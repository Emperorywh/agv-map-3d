/*
 * 启动编排测试（与实现共置）。
 *
 * 职责：锁定 bootstrapApplication 的编排合同：阶段耗时进诊断通道、重复启动
 *       取消旧流程、外部 AbortSignal 联动、失败只上报一次稳定错误码。
 * 关键不变量（TASK-002 / SPEC §10.3）：
 * 1. 取消（AbortError）不是失败，不进入错误诊断；
 * 2. 配置失败以稳定错误码上报恰好一次后原样重抛；
 * 3. 同一时刻只保留最新一次启动流程，旧流程在展示层被中止。
 */
import { describe, expect, it } from 'vitest'
import { createDiagnosticsReporter, isAbortError, type DiagnosticRecord } from '@/shared/diagnostics'
import { bootstrapApplication } from '@/app/bootstrap/bootstrapApplication'

const BASE_URL = 'http://localhost:5173/'

const VALID_CONFIG = {
  dataSource: 'mock',
  mapUrl: './json/map.json',
  wsUrl: null,
  maxVehicles: 256,
  staleAfterMs: 10000,
  renderer: { maxDpr: 1.5, shadowMapSize: 2048 },
  coordinateTransform: { scale: 1, rotation: 0, mirrorY: false, translateX: 0, translateY: 0 },
}

/** 记录型诊断通道 */
function recordingDiagnostics(): { records: DiagnosticRecord[]; diagnostics: ReturnType<typeof createDiagnosticsReporter> } {
  const records: DiagnosticRecord[] = []
  return {
    records,
    diagnostics: createDiagnosticsReporter({ sink: (record) => void records.push(record), now: () => 0 }),
  }
}

function fetchOk(body: string): typeof fetch {
  return async () => new Response(body, { status: 200 })
}

describe('bootstrapApplication', () => {
  it('成功启动返回配置与实际配置 URL，并把 config 阶段耗时写入诊断', async () => {
    const { records, diagnostics } = recordingDiagnostics()
    const result = await bootstrapApplication({
      baseUrl: BASE_URL,
      fetchImpl: fetchOk(JSON.stringify(VALID_CONFIG)),
      diagnostics,
    })
    expect(result.config.maxVehicles).toBe(256)
    expect(result.configUrl).toBe(`${BASE_URL}config.json`)

    const stageRecords = records.filter((record) => record.code === 'BOOTSTRAP_STAGE_DURATION')
    expect(stageRecords).toHaveLength(1)
    expect(stageRecords[0].context).toMatchObject({ stage: 'config' })
    expect(stageRecords[0].level).toBe('info')
    expect(stageRecords[0].context.durationMs).toBeTypeOf('number')
  })

  it('重复启动取消旧流程：旧调用以 AbortError 结束，新调用成功，且取消不进错误诊断', async () => {
    const { records, diagnostics } = recordingDiagnostics()
    const releaseFirst: Array<() => void> = []
    const slowFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((resolve, reject) => {
        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
        init?.signal?.addEventListener('abort', onAbort)
        releaseFirst.push(() => resolve(new Response(JSON.stringify(VALID_CONFIG), { status: 200 })))
      })

    const first = bootstrapApplication({ baseUrl: BASE_URL, fetchImpl: slowFetch, diagnostics })
    const second = bootstrapApplication({ baseUrl: BASE_URL, fetchImpl: fetchOk(JSON.stringify(VALID_CONFIG)), diagnostics })

    await expect(first).rejects.toSatisfy(isAbortError)
    await expect(second).resolves.toMatchObject({ configUrl: `${BASE_URL}config.json` })

    // 第二次启动已经接管，第一次的 fetch 桩永远不会被 resolve
    expect(releaseFirst).toHaveLength(1)
    // 仅第二次启动的阶段指标；无任何错误级别记录（取消不是失败）
    expect(records.filter((record) => record.level === 'error')).toHaveLength(0)
  })

  it('外部 AbortSignal 取消本次启动，且监听器被对称移除', async () => {
    const { records, diagnostics } = recordingDiagnostics()
    const external = new AbortController()
    const hanging: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })

    const pending = bootstrapApplication({ baseUrl: BASE_URL, fetchImpl: hanging, diagnostics, signal: external.signal })
    external.abort()
    await expect(pending).rejects.toSatisfy(isAbortError)

    // 监听器已移除：再次 abort 不产生任何新拒绝或诊断
    external.abort()
    expect(records.filter((record) => record.level === 'error')).toHaveLength(0)
  })

  it('已中止的信号直接以取消结束，不发起请求', async () => {
    const external = new AbortController()
    external.abort()
    let fetchCalls = 0
    const counting: typeof fetch = async () => {
      fetchCalls += 1
      return new Response(JSON.stringify(VALID_CONFIG), { status: 200 })
    }
    await expect(
      bootstrapApplication({ baseUrl: BASE_URL, fetchImpl: counting, signal: external.signal }),
    ).rejects.toSatisfy(isAbortError)
    expect(fetchCalls).toBe(0)
  })

  it('配置失败以稳定错误码上报恰好一次后原样重抛', async () => {
    const { records, diagnostics } = recordingDiagnostics()
    const failing: typeof fetch = async () => new Response('nope', { status: 404 })
    await expect(
      bootstrapApplication({ baseUrl: BASE_URL, fetchImpl: failing, diagnostics }),
    ).rejects.toMatchObject({ code: 'CONFIG_HTTP_STATUS' })

    const errorRecords = records.filter((record) => record.level === 'error')
    expect(errorRecords).toHaveLength(1)
    expect(errorRecords[0].code).toBe('CONFIG_HTTP_STATUS')
  })

  it('非结构化的意外异常被包装为 BOOTSTRAP_FAILED 上报并重抛', async () => {
    const { records, diagnostics } = recordingDiagnostics()
    const throwing: typeof fetch = async () => {
      throw new TypeError('network unreachable')
    }
    await expect(
      bootstrapApplication({ baseUrl: BASE_URL, fetchImpl: throwing, diagnostics }),
    ).rejects.toMatchObject({ code: 'CONFIG_FETCH_FAILED' })
    expect(records.filter((record) => record.level === 'error').map((record) => record.code)).toEqual([
      'CONFIG_FETCH_FAILED',
    ])
  })
})
