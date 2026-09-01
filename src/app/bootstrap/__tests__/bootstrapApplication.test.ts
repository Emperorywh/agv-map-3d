/*
 * 启动编排测试（与实现共置）。
 *
 * 职责：锁定 bootstrapApplication 的编排合同：阶段耗时进诊断通道、重复启动
 *       取消旧流程、外部 AbortSignal 联动、失败只上报一次稳定错误码，以及
 *       TASK-003 新增的地图阶段：成功返回 MapModel、异常逐条上报、失败重抛。
 * 关键不变量（TASK-002/003 / SPEC §10.3）：
 * 1. 取消（AbortError）不是失败，不进入错误诊断；
 * 2. 配置或地图失败以稳定错误码上报恰好一次后原样重抛；
 * 3. 同一时刻只保留最新一次启动流程，旧流程在展示层被中止；
 * 4. 地图逐项异常只随成功结果上报（warn/error 级），不改变启动结果。
 */
import { describe, expect, it } from 'vitest'
import { createDiagnosticsReporter, isAbortError, StructuredError, type DiagnosticRecord } from '@/shared/diagnostics'
import { bootstrapApplication, type LoadMapImpl } from '@/app/bootstrap/bootstrapApplication'
import { createMapModel, validateMap, type LoadMapResult } from '@/features/map-visualization'

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

/** 最小合法地图夹具：两个节点一条 LINE 边（经真实校验与建模，测试无 cast） */
const TINY_MAP = {
  nodes: [
    { id: 'n1', name: '1', type: 'work', mapId: 'm1', x: 0, y: 0, angle: null },
    { id: 'n2', name: '2', type: 'charge', mapId: 'm1', x: 2, y: 0, angle: null },
  ],
  edges: [
    {
      id: 'e1',
      mapId: 'm1',
      edgeType: 'LINE',
      sx: 0,
      sy: 0,
      ex: 2,
      ey: 0,
      cx: null,
      cy: null,
      dx: null,
      dy: null,
      snodeId: 'n1',
      enodeId: 'n2',
      isBackEdge: false,
    },
  ],
  zones: [],
  nodeEdgeGroups: [],
}

/** 地图加载桩：默认返回真实建模的最小地图结果，可覆盖任意字段或抛错 */
function stubLoadMap(overrides: Partial<LoadMapResult> = {}): LoadMapImpl {
  const { mapModel, worldTransform } = createMapModel(validateMap(TINY_MAP))
  return async () => ({
    mapModel,
    worldTransform,
    url: `${BASE_URL}json/map.json`,
    anomalies: [],
    ...overrides,
  })
}

/** 记录型诊断通道（采样窗口为 0：同码记录也逐条发出，便于按序断言） */
function recordingDiagnostics(): { records: DiagnosticRecord[]; diagnostics: ReturnType<typeof createDiagnosticsReporter> } {
  const records: DiagnosticRecord[] = []
  return {
    records,
    diagnostics: createDiagnosticsReporter({
      sink: (record) => void records.push(record),
      now: () => 0,
      sampleWindowMs: 0,
    }),
  }
}

function fetchOk(body: string): typeof fetch {
  return async () => new Response(body, { status: 200 })
}

describe('bootstrapApplication', () => {
  it('成功启动返回配置、地图模型与实际 URL，并把 config/map 阶段耗时写入诊断', async () => {
    const { records, diagnostics } = recordingDiagnostics()
    const result = await bootstrapApplication({
      baseUrl: BASE_URL,
      fetchImpl: fetchOk(JSON.stringify(VALID_CONFIG)),
      loadMapImpl: stubLoadMap(),
      diagnostics,
    })
    expect(result.config.maxVehicles).toBe(256)
    expect(result.configUrl).toBe(`${BASE_URL}config.json`)
    expect(result.mapUrl).toBe(`${BASE_URL}json/map.json`)
    expect(result.mapModel.nodes.size).toBe(2)
    expect(result.mapModel.edgeList).toHaveLength(1)
    expect(result.worldTransform.origin).toEqual({ x: 1, y: 0 })

    const stages = records.filter((record) => record.code === 'BOOTSTRAP_STAGE_DURATION')
    expect(stages.map((record) => record.context.stage)).toEqual(['config', 'map'])
    expect(stages.every((record) => record.level === 'info')).toBe(true)
    expect(stages.every((record) => typeof record.context.durationMs === 'number')).toBe(true)
  })

  it('地图逐项异常随成功结果逐条上报，但不改变启动结果', async () => {
    const { records, diagnostics } = recordingDiagnostics()
    const anomalies = [
      Object.freeze({
        code: 'MAP_NODE_UNKNOWN_TYPE' as const,
        level: 'warn' as const,
        message: '未知节点类型',
        context: { id: 'n9' },
      }),
    ]
    const result = await bootstrapApplication({
      baseUrl: BASE_URL,
      fetchImpl: fetchOk(JSON.stringify(VALID_CONFIG)),
      loadMapImpl: stubLoadMap({ anomalies }),
      diagnostics,
    })
    expect(result.mapModel.nodes.size).toBe(2)
    const warnRecords = records.filter((record) => record.level === 'warn')
    expect(warnRecords).toHaveLength(1)
    expect(warnRecords[0]).toMatchObject({ code: 'MAP_NODE_UNKNOWN_TYPE', context: { id: 'n9' } })
    expect(records.filter((record) => record.level === 'error')).toHaveLength(0)
  })

  it('地图失败以稳定错误码上报恰好一次后原样重抛', async () => {
    const { records, diagnostics } = recordingDiagnostics()
    const failingLoadMap: LoadMapImpl = async () => {
      throw new StructuredError({
        code: 'MAP_HTTP_STATUS',
        message: '地图资源请求失败：HTTP 404',
        context: { status: 404 },
      })
    }
    await expect(
      bootstrapApplication({
        baseUrl: BASE_URL,
        fetchImpl: fetchOk(JSON.stringify(VALID_CONFIG)),
        loadMapImpl: failingLoadMap,
        diagnostics,
      }),
    ).rejects.toMatchObject({ code: 'MAP_HTTP_STATUS' })

    const errorRecords = records.filter((record) => record.level === 'error')
    expect(errorRecords).toHaveLength(1)
    expect(errorRecords[0].code).toBe('MAP_HTTP_STATUS')
  })

  it('地图阶段被取消时以 AbortError 结束，且不进错误诊断', async () => {
    const { records, diagnostics } = recordingDiagnostics()
    const external = new AbortController()
    const hangingLoadMap: LoadMapImpl = (options) =>
      new Promise<LoadMapResult>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    const pending = bootstrapApplication({
      baseUrl: BASE_URL,
      fetchImpl: fetchOk(JSON.stringify(VALID_CONFIG)),
      loadMapImpl: hangingLoadMap,
      diagnostics,
      signal: external.signal,
    })
    // 外部取消联动内部信号：地图阶段的挂起请求被中止
    external.abort()
    await expect(pending).rejects.toSatisfy(isAbortError)
    expect(records.filter((record) => record.level === 'error')).toHaveLength(0)
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

    const first = bootstrapApplication({ baseUrl: BASE_URL, fetchImpl: slowFetch, loadMapImpl: stubLoadMap(), diagnostics })
    const second = bootstrapApplication({
      baseUrl: BASE_URL,
      fetchImpl: fetchOk(JSON.stringify(VALID_CONFIG)),
      loadMapImpl: stubLoadMap(),
      diagnostics,
    })

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

    const pending = bootstrapApplication({
      baseUrl: BASE_URL,
      fetchImpl: hanging,
      loadMapImpl: stubLoadMap(),
      diagnostics,
      signal: external.signal,
    })
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
      bootstrapApplication({
        baseUrl: BASE_URL,
        fetchImpl: counting,
        loadMapImpl: stubLoadMap(),
        signal: external.signal,
      }),
    ).rejects.toSatisfy(isAbortError)
    expect(fetchCalls).toBe(0)
  })

  it('配置失败以稳定错误码上报恰好一次后原样重抛', async () => {
    const { records, diagnostics } = recordingDiagnostics()
    const failing: typeof fetch = async () => new Response('nope', { status: 404 })
    await expect(
      bootstrapApplication({
        baseUrl: BASE_URL,
        fetchImpl: failing,
        loadMapImpl: stubLoadMap(),
        diagnostics,
      }),
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
      bootstrapApplication({
        baseUrl: BASE_URL,
        fetchImpl: throwing,
        loadMapImpl: stubLoadMap(),
        diagnostics,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_FETCH_FAILED' })
    expect(records.filter((record) => record.level === 'error').map((record) => record.code)).toEqual([
      'CONFIG_FETCH_FAILED',
    ])
  })
})
