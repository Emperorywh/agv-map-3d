/**
 * 启动阶段编排原语（SPEC §10.3；TASK-002 配置阶段、TASK-003 地图阶段，
 * TASK-017 拆分为可并行编排的阶段函数）。
 *
 * 职责：把 SPEC §10.3 的启动阶段拆为两个无状态异步原语，供 app 启动编排
 *       （App 启动 effect）按「config 就绪 → 并行窗口（WS 数据源初始化 ×
 *       地图加载）→ 地图建模」驱动：
 *       - loadStartupConfig：阶段 1「读取并校验 config.json」，耗时以
 *         BOOTSTRAP_STAGE_CONFIG 写入诊断通道；
 *       - loadStartupMap：阶段 2「加载地图」（网络 + JSON 解析，BOOTSTRAP_
 *         STAGE_MAP）与阶段 3「解析、校验并建立地图逻辑索引」（BOOTSTRAP_
 *         STAGE_INDEX）分别计时，地图逐项异常按条上报。
 *       各阶段耗时只写入性能指标，不在页面显示（SPEC §10.3）。
 * 边界：只做编排与诊断上报，不承载配置校验、地图解析等业务算法；不渲染
 *       任何 DOM——配置或地图失败时页面保持唯一清屏 Canvas（SPEC §7.4 / D2）。
 *       地图失败的原样重抛是有意行为：首次加载的自动重试与旧场景保留由
 *       App 编排与地图生命周期 Hook 接管（SPEC §11.10）。重复启动取消由
 *       App 启动 effect 的 AbortController 收敛（本模块无模块级状态）。
 * 关键不变量：
 * 1. 取消（AbortError）不作为错误上报诊断；真正的失败以稳定错误码上报且
 *    只上报一次，随后原样重抛给调用方；
 * 2. 地图逐项异常（anomalies）在成功路径上按条写入诊断通道（采样合并由
 *    诊断通道负责），不改变启动结果；
 * 3. 阶段函数无模块级可变状态：并发调用互不干扰，编排策略（重试、并行、
 *    取消）完全属于调用方。
 */
import {
  createDiagnosticsReporter,
  isAbortError,
  StructuredError,
  type DiagnosticsReporter,
} from '@/shared/diagnostics'
import {
  buildMapFromJson,
  fetchMapJson,
} from '@/features/map-visualization'
import type { MapModel } from '@/features/map-visualization'
import type { WorldTransform } from '@/shared/spatial'
import { loadRuntimeConfig, type RuntimeConfig } from './loadRuntimeConfig'

/** fetchMapJson 注入点类型（测试用桩替换；默认真实实现） */
export type FetchMapJsonImpl = typeof fetchMapJson

/** buildMapFromJson 注入点类型（测试用桩替换；默认真实实现） */
export type BuildMapFromJsonImpl = typeof buildMapFromJson

export interface LoadStartupConfigOptions {
  /** 取消信号：中止后以 AbortError 拒绝 */
  signal?: AbortSignal
  /** 诊断通道；默认创建控制台通道 */
  diagnostics?: DiagnosticsReporter
  /** fetch 注入点；默认全局 fetch，测试用桩替换 */
  fetchImpl?: typeof fetch
  /** 配置解析基准 URL；默认 document.baseURI */
  baseUrl?: string
}

export interface StartupConfigResult {
  config: RuntimeConfig
  /** 实际使用的配置资源 URL（根路径与子路径部署下不同） */
  configUrl: string
}

/**
 * 阶段 1「读取并校验 config.json」（SPEC §10.3）：耗时以
 * BOOTSTRAP_STAGE_CONFIG（info）写入诊断通道；失败以稳定错误码上报一次后
 * 原样重抛；取消（AbortError）原样上抛且不上报。
 */
export async function loadStartupConfig(
  options: LoadStartupConfigOptions = {},
): Promise<StartupConfigResult> {
  const diagnostics = options.diagnostics ?? createDiagnosticsReporter()
  // 已中止的信号直接以取消结束，不发起任何请求（与真实 fetch 的中止语义一致）
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException('启动已被取消', 'AbortError')
  }
  const stageStartedAt = performance.now()
  try {
    const { config, href } = await loadRuntimeConfig({
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      baseUrl: options.baseUrl,
    })
    // 取消竞态兜底：fetch 已完成但流程随后被中止时，同样以 AbortError 结束
    options.signal?.throwIfAborted()
    // 阶段耗时只写入性能指标（诊断通道），不在页面显示（SPEC §10.3）
    diagnostics.report('BOOTSTRAP_STAGE_CONFIG', 'info', '启动阶段耗时', {
      stage: 'config',
      durationMs: performance.now() - stageStartedAt,
    })
    return { config, configUrl: href }
  } catch (error) {
    if (!isAbortError(error)) {
      const structured = asStartupError(error)
      diagnostics.report(structured.code, structured.level, structured.message, {
        ...structured.context,
      })
    }
    throw error
  }
}

export interface LoadStartupMapOptions {
  /** 取消信号：中止后以 AbortError 拒绝 */
  signal?: AbortSignal
  /** 诊断通道；默认创建控制台通道 */
  diagnostics?: DiagnosticsReporter
  /** fetch 注入点；默认全局 fetch，测试用桩替换 */
  fetchImpl?: typeof fetch
  /** 配置与地图解析基准 URL；默认 document.baseURI */
  baseUrl?: string
  /** 地图网络阶段注入点；默认 fetchMapJson，测试用桩替换 */
  fetchMapJsonImpl?: FetchMapJsonImpl
  /** 地图建模阶段注入点；默认 buildMapFromJson，测试用桩替换 */
  buildMapFromJsonImpl?: BuildMapFromJsonImpl
}

export interface StartupMapResult {
  /** 实际使用的地图资源 URL */
  mapUrl: string
  /** 冻结的只读地图模型（唯一事实源；地图恢复时整体原子替换） */
  mapModel: MapModel
  /** 与地图模型配套的世界坐标变换（原点已定型） */
  worldTransform: WorldTransform
}

/**
 * 阶段 2「加载地图」与阶段 3「解析、校验并建立地图逻辑索引」（SPEC §10.3）：
 * 网络与建模分别以 BOOTSTRAP_STAGE_MAP / BOOTSTRAP_STAGE_INDEX（info）计时
 * 上报；地图逐项异常按条上报后随成功结果返回；失败以稳定错误码上报一次后
 * 原样重抛（MAP_* 稳定错误码）；取消（AbortError）原样上抛且不上报。
 */
export async function loadStartupMap(
  config: RuntimeConfig,
  options: LoadStartupMapOptions = {},
): Promise<StartupMapResult> {
  const diagnostics = options.diagnostics ?? createDiagnosticsReporter()
  const fetchMapImpl = options.fetchMapJsonImpl ?? fetchMapJson
  const buildMapImpl = options.buildMapFromJsonImpl ?? buildMapFromJson

  // 已中止的信号直接以取消结束，不发起任何请求
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException('启动已被取消', 'AbortError')
  }

  try {
    // 阶段 2：加载地图资源（网络 + JSON 解析）
    const mapStageStartedAt = performance.now()
    const fetched = await fetchMapImpl({
      mapUrl: config.mapUrl,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      baseUrl: options.baseUrl,
    })
    options.signal?.throwIfAborted()
    diagnostics.report('BOOTSTRAP_STAGE_MAP', 'info', '启动阶段耗时', {
      stage: 'map',
      durationMs: performance.now() - mapStageStartedAt,
    })

    // 阶段 3：解析、校验（逐项隔离）并建立逻辑索引
    const indexStageStartedAt = performance.now()
    const { mapModel, worldTransform, anomalies } = buildMapImpl(fetched.raw, {
      coordinateTransform: config.coordinateTransform,
    })
    for (const anomaly of anomalies) {
      diagnostics.report(anomaly.code, anomaly.level, anomaly.message, {
        ...anomaly.context,
        mapId: mapModel.mapId,
      })
    }
    diagnostics.report('BOOTSTRAP_STAGE_INDEX', 'info', '启动阶段耗时', {
      stage: 'index',
      durationMs: performance.now() - indexStageStartedAt,
    })

    return { mapUrl: fetched.url, mapModel, worldTransform }
  } catch (error) {
    if (!isAbortError(error)) {
      const structured = asStartupError(error)
      diagnostics.report(structured.code, structured.level, structured.message, {
        ...structured.context,
      })
    }
    throw error
  }
}

/** 非结构化异常的兜底错误码（保持既有合同：调用方按码分支终态/重试） */
export const BOOTSTRAP_FAILED_CODE = 'BOOTSTRAP_FAILED'

/**
 * 把启动阶段抛出的非结构化异常包装为稳定错误码（BOOTSTRAP_FAILED）；
 * StructuredError 原样返回。供启动编排的 catch 分支与诊断上报使用。
 */
export function asStartupError(error: unknown): StructuredError {
  return error instanceof StructuredError
    ? error
    : new StructuredError({
        code: BOOTSTRAP_FAILED_CODE,
        message: `启动流程失败：${error instanceof Error ? error.message : String(error)}`,
        context: {},
        cause: error,
      })
}
