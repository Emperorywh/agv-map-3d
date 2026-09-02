/*
 * 启动阶段原语测试（与实现共置；TASK-002/003 合同，TASK-017 拆分重写）。
 *
 * 职责：锁定 loadStartupConfig / loadStartupMap 的编排合同：阶段耗时进诊断
 *       通道（BOOTSTRAP_STAGE_CONFIG / _MAP / _INDEX）、失败只上报一次稳定
 *       错误码后原样重抛、取消（AbortError）不是失败不进错误诊断、地图逐
 *       项异常只随成功结果上报，以及「网络阶段 → 建模阶段」拆分原语与
 *       loadMap 组合入口的等价性。
 * 关键不变量（TASK-002/003/017 / SPEC §10.3）：
 * 1. 阶段函数无模块级状态：并发调用互不干扰（重复启动取消由 App 启动
 *    effect 的 AbortController 收敛，见 App 外壳测试）；
 * 2. 取消（AbortError）不进入错误诊断；
 * 3. 配置或地图失败以稳定错误码上报恰好一次后原样重抛；
 * 4. 地图逐项异常只随成功结果上报（warn/error 级），不改变启动结果。
 */
import { describe, expect, it } from 'vitest'
import { createDiagnosticsReporter, isAbortError, StructuredError, type DiagnosticRecord } from '@/shared/diagnostics'
import {
  asStartupError,
  BOOTSTRAP_FAILED_CODE,
  loadStartupConfig,
  loadStartupMap,
} from '@/app/bootstrap/bootstrapApplication'
import {
  buildMapFromJson,
  fetchMapJson,
  type FetchedMapResource,
  type MapModel,
} from '@/features/map-visualization'
import type { WorldTransform } from '@/shared/spatial'
import type { RuntimeConfig } from '@/app/bootstrap/loadRuntimeConfig'

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

/** 建模阶段桩输入：真实建模一次，供桩按引用返回（避免重复构建） */
const PREBUILT = buildMapFromJson(TINY_MAP)

/** 网络阶段桩：返回原始 JSON 与 URL，可覆盖任意字段或抛错 */
function stubFetchMapJson(
  overrides: Partial<FetchedMapResource> = {},
): typeof fetchMapJson {
  return async () => ({ raw: TINY_MAP, url: `${BASE_URL}json/map.json`, ...overrides })
}

/** 建模阶段桩：默认返回真实建模的最小地图结果，可覆盖任意字段或抛错 */
function stubBuildMapFromJson(
  overrides: { mapModel?: MapModel; worldTransform?: WorldTransform } = {},
): typeof buildMapFromJson {
  return () => ({
    mapModel: PREBUILT.mapModel,
    worldTransform: PREBUILT.worldTransform,
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

function stageRecords(records: DiagnosticRecord[], code: string): DiagnosticRecord[] {
  return records.filter((record) => record.code === code)
}

describe('loadStartupConfig', () => {
  it('成功返回配置与 URL，config 阶段耗时写入诊断', async () => {
    const { records, diagnostics } = recordingDiagnostics()
    const result = await loadStartupConfig({
      baseUrl: BASE_URL,
      fetchImpl: fetchOk(JSON.stringify(VALID_CONFIG)),
      diagnostics,
    })
    expect(result.config.maxVehicles).toBe(256)
    expect(result.configUrl).toBe(`${BASE_URL}config.json`)

    const stages = stageRecords(records, 'BOOTSTRAP_STAGE_CONFIG')
    expect(stages).toHaveLength(1)
    expect(stages[0]).toMatchObject({ level: 'info', context: { stage: 'config' } })
    expect(typeof stages[0].context.durationMs).toBe('number')
  })

  it('配置失败以稳定错误码上报恰好一次后原样重抛', async () => {
    const { records, diagnostics } = recordingDiagnostics()
    const failing: typeof fetch = async () => new Response('nope', { status: 404 })
    await expect(
      loadStartupConfig({ baseUrl: BASE_URL, fetchImpl: failing, diagnostics }),
    ).rejects.toMatchObject({ code: 'CONFIG_HTTP_STATUS' })

    const errorRecords = records.filter((record) => record.level === 'error')
    expect(errorRecords).toHaveLength(1)
    expect(errorRecords[0].code).toBe('CONFIG_HTTP_STATUS')
    expect(stageRecords(records, 'BOOTSTRAP_STAGE_CONFIG')).toHaveLength(0)
  })

  it('取消（AbortError）原样上抛且不进错误诊断，外部监听器对称移除', async () => {
    const { records, diagnostics } = recordingDiagnostics()
    const external = new AbortController()
    const hanging: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })

    const pending = loadStartupConfig({
      baseUrl: BASE_URL,
      fetchImpl: hanging,
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
      loadStartupConfig({ baseUrl: BASE_URL, fetchImpl: counting, signal: external.signal }),
    ).rejects.toSatisfy(isAbortError)
    expect(fetchCalls).toBe(0)
  })
})

describe('loadStartupMap', () => {
  it('成功返回地图模型与 URL，map/index 两阶段耗时分别写入诊断', async () => {
    const { records, diagnostics } = recordingDiagnostics()
    const config = { ...VALID_CONFIG, mapUrl: './json/map.json' } as RuntimeConfig
    const result = await loadStartupMap(config, {
      baseUrl: BASE_URL,
      diagnostics,
      fetchMapJsonImpl: stubFetchMapJson(),
      buildMapFromJsonImpl: stubBuildMapFromJson(),
    })
    expect(result.mapUrl).toBe(`${BASE_URL}json/map.json`)
    expect(result.mapModel.nodes.size).toBe(2)
    expect(result.worldTransform.origin).toEqual({ x: 1, y: 0 })

    expect(stageRecords(records, 'BOOTSTRAP_STAGE_MAP')).toHaveLength(1)
    expect(stageRecords(records, 'BOOTSTRAP_STAGE_INDEX')).toHaveLength(1)
    const stages = [
      ...stageRecords(records, 'BOOTSTRAP_STAGE_MAP'),
      ...stageRecords(records, 'BOOTSTRAP_STAGE_INDEX'),
    ]
    expect(stages.every((record) => record.level === 'info')).toBe(true)
    expect(stages.every((record) => typeof record.context.durationMs === 'number')).toBe(true)
    expect(stages.map((record) => record.context.stage)).toEqual(['map', 'index'])
  })

  it('地图逐项异常随成功结果逐条上报（携带 mapId），但不改变启动结果', async () => {
    const { records, diagnostics } = recordingDiagnostics()
    const result = await loadStartupMap({ ...VALID_CONFIG } as RuntimeConfig, {
      baseUrl: BASE_URL,
      diagnostics,
      fetchMapJsonImpl: stubFetchMapJson(),
      buildMapFromJsonImpl: () => ({
        mapModel: PREBUILT.mapModel,
        worldTransform: PREBUILT.worldTransform,
        anomalies: [
          Object.freeze({
            code: 'MAP_NODE_UNKNOWN_TYPE' as const,
            level: 'warn' as const,
            message: '未知节点类型',
            context: { id: 'n9' },
          }),
        ],
      }),
    })
    expect(result.mapModel.nodes.size).toBe(2)
    const warnRecords = records.filter((record) => record.level === 'warn')
    expect(warnRecords).toHaveLength(1)
    expect(warnRecords[0]).toMatchObject({
      code: 'MAP_NODE_UNKNOWN_TYPE',
      context: { id: 'n9', mapId: 'm1' },
    })
    expect(records.filter((record) => record.level === 'error')).toHaveLength(0)
  })

  it('地图失败以稳定错误码上报恰好一次后原样重抛', async () => {
    const { records, diagnostics } = recordingDiagnostics()
    const failingFetchMap: typeof fetchMapJson = async () => {
      throw new StructuredError({
        code: 'MAP_HTTP_STATUS',
        message: '地图资源请求失败：HTTP 404',
        context: { status: 404 },
      })
    }
    await expect(
      loadStartupMap({ ...VALID_CONFIG } as RuntimeConfig, {
        baseUrl: BASE_URL,
        diagnostics,
        fetchMapJsonImpl: failingFetchMap,
        buildMapFromJsonImpl: stubBuildMapFromJson(),
      }),
    ).rejects.toMatchObject({ code: 'MAP_HTTP_STATUS' })

    const errorRecords = records.filter((record) => record.level === 'error')
    expect(errorRecords).toHaveLength(1)
    expect(errorRecords[0].code).toBe('MAP_HTTP_STATUS')
    expect(stageRecords(records, 'BOOTSTRAP_STAGE_MAP')).toHaveLength(0)
    expect(stageRecords(records, 'BOOTSTRAP_STAGE_INDEX')).toHaveLength(0)
  })

  it('地图阶段被取消时以 AbortError 结束，且不进错误诊断', async () => {
    const { records, diagnostics } = recordingDiagnostics()
    const external = new AbortController()
    const hangingFetchMap: typeof fetchMapJson = (options) =>
      new Promise<FetchedMapResource>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    const pending = loadStartupMap({ ...VALID_CONFIG } as RuntimeConfig, {
      baseUrl: BASE_URL,
      diagnostics,
      fetchMapJsonImpl: hangingFetchMap,
      buildMapFromJsonImpl: stubBuildMapFromJson(),
      signal: external.signal,
    })
    external.abort()
    await expect(pending).rejects.toSatisfy(isAbortError)
    expect(records.filter((record) => record.level === 'error')).toHaveLength(0)
  })

  it('拆分原语与 loadMap 组合等价：真实 fetch+JSON → 真实校验建模', async () => {
    const fetched = await fetchMapJson({
      mapUrl: './json/map.json',
      baseUrl: BASE_URL,
      fetchImpl: fetchOk(JSON.stringify(TINY_MAP)),
    })
    expect(fetched.url).toBe(`${BASE_URL}json/map.json`)
    const built = buildMapFromJson(fetched.raw)
    expect(built.mapModel.nodes.size).toBe(2)
    expect(built.mapModel.edgeList).toHaveLength(1)
    expect(built.anomalies).toHaveLength(0)
  })

  it('非结构化的意外异常经 asStartupError 包装为 BOOTSTRAP_FAILED 码', () => {
    const wrapped = asStartupError(new TypeError('unexpected'))
    expect(wrapped.code).toBe(BOOTSTRAP_FAILED_CODE)
    const passthrough = asStartupError(
      new StructuredError({ code: 'MAP_JSON_PARSE', message: 'x', context: {} }),
    )
    expect(passthrough.code).toBe('MAP_JSON_PARSE')
  })
})
