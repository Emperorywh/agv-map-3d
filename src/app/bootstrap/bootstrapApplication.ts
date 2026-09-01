/**
 * 启动阶段编排（SPEC §10.3；TASK-002 配置阶段、TASK-003 地图阶段）。
 *
 * 职责：按阶段驱动应用启动——阶段 1「读取并校验 config.json」、阶段 3
 *       「拉取地图并解析、校验、建立逻辑索引」；各阶段耗时写入诊断通道
 *       （性能指标），不在页面显示。数据源并行初始化与场景几何阶段属
 *       TASK-007/009 与 TASK-004，尚未接入。
 * 边界：只做编排与诊断上报，不承载配置校验、地图解析等业务算法；不渲染
 *       任何 DOM——配置或地图失败时页面保持唯一清屏 Canvas（SPEC §7.4 / D2）。
 *       地图失败的原样重抛是有意行为：首次加载的自动重试与旧场景保留由
 *       TASK-004 的地图生命周期 Hook 接管（SPEC §11.10）。
 * 关键不变量：
 * 1. 重复启动取消：同一时刻只保留最新一次启动流程，旧流程的进行中请求被
 *    中止并以 AbortError 结束（StrictMode / 热重载安全）；
 * 2. 外部 AbortSignal 联动内部信号，监听器在结束后对称移除；
 * 3. 取消（AbortError）不作为错误上报诊断；真正的失败以稳定错误码上报且
 *    只上报一次，随后原样重抛给调用方；
 * 4. 地图逐项异常（anomalies）在成功路径上按条写入诊断通道（采样合并由
 *    诊断通道负责），不改变启动结果。
 */
import {
  createDiagnosticsReporter,
  isAbortError,
  StructuredError,
  type DiagnosticsReporter,
} from '@/shared/diagnostics'
import type { MapModel } from '@/features/map-visualization'
import type { WorldTransform } from '@/shared/spatial'
import { loadRuntimeConfig, type RuntimeConfig } from './loadRuntimeConfig'
import { loadMap } from '@/features/map-visualization'

/** loadMap 注入点类型（测试用桩替换；默认真实实现） */
export type LoadMapImpl = typeof loadMap

export interface BootstrapOptions {
  /** 取消信号：中止本次启动流程 */
  signal?: AbortSignal
  /** 诊断通道；默认创建控制台通道 */
  diagnostics?: DiagnosticsReporter
  /** fetch 注入点；默认全局 fetch，测试用桩替换 */
  fetchImpl?: typeof fetch
  /** 配置与地图解析基准 URL；默认 document.baseURI */
  baseUrl?: string
  /** 地图加载注入点；默认 loadMap，测试用桩替换 */
  loadMapImpl?: LoadMapImpl
}

export interface BootstrapResult {
  config: RuntimeConfig
  /** 实际使用的配置资源 URL（根路径与子路径部署下不同） */
  configUrl: string
  /** 实际使用的地图资源 URL */
  mapUrl: string
  /** 冻结的只读地图模型（唯一事实源；地图恢复时整体原子替换） */
  mapModel: MapModel
  /** 与地图模型配套的世界坐标变换（原点已定型） */
  worldTransform: WorldTransform
}

/** 仍在进行中的启动流程；新启动会中止它（重复启动取消） */
let activeController: AbortController | null = null

export async function bootstrapApplication(
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  // 不变量 1：新启动开始前，中止旧流程，保证同一时刻只有一条启动链路
  activeController?.abort()
  const controller = new AbortController()
  activeController = controller

  const diagnostics = options.diagnostics ?? createDiagnosticsReporter()
  const external = options.signal
  const loadMapImpl = options.loadMapImpl ?? loadMap

  const onExternalAbort = (): void => {
    controller.abort()
  }
  if (external) {
    if (external.aborted) {
      activeController = null
      throw external.reason ?? new DOMException('启动已被取消', 'AbortError')
    }
    external.addEventListener('abort', onExternalAbort, { once: true })
  }

  try {
    const configStageStartedAt = performance.now()
    const { config, href } = await loadRuntimeConfig({
      signal: controller.signal,
      fetchImpl: options.fetchImpl,
      baseUrl: options.baseUrl,
    })
    // 取消竞态兜底：fetch 已完成但流程随后被中止时，同样以 AbortError 结束
    controller.signal.throwIfAborted()

    // 阶段耗时只写入性能指标（诊断通道），不在页面显示（SPEC §10.3）
    diagnostics.report('BOOTSTRAP_STAGE_DURATION', 'info', '启动阶段耗时', {
      stage: 'config',
      durationMs: performance.now() - configStageStartedAt,
    })

    // 阶段 3：拉取地图 → 校验（逐项隔离）→ 建立逻辑索引（SPEC §10.3）
    const mapStageStartedAt = performance.now()
    const mapResult = await loadMapImpl({
      mapUrl: config.mapUrl,
      coordinateTransform: config.coordinateTransform,
      signal: controller.signal,
      fetchImpl: options.fetchImpl,
      baseUrl: options.baseUrl,
    })
    controller.signal.throwIfAborted()

    for (const anomaly of mapResult.anomalies) {
      diagnostics.report(anomaly.code, anomaly.level, anomaly.message, {
        ...anomaly.context,
        mapId: mapResult.mapModel.mapId,
      })
    }
    diagnostics.report('BOOTSTRAP_STAGE_DURATION', 'info', '启动阶段耗时', {
      stage: 'map',
      durationMs: performance.now() - mapStageStartedAt,
    })

    return {
      config,
      configUrl: href,
      mapUrl: mapResult.url,
      mapModel: mapResult.mapModel,
      worldTransform: mapResult.worldTransform,
    }
  } catch (error) {
    if (!isAbortError(error)) {
      // 失败以稳定错误码上报一次；非结构化异常兜底包装
      const structured =
        error instanceof StructuredError
          ? error
          : new StructuredError({
              code: 'BOOTSTRAP_FAILED',
              message: `启动流程失败：${error instanceof Error ? error.message : String(error)}`,
              context: {},
              cause: error,
            })
      diagnostics.report(structured.code, structured.level, structured.message, {
        ...structured.context,
      })
    }
    throw error
  } finally {
    // 不变量 2：外部监听对称移除；仅当自己仍是活跃流程时才清空指针
    external?.removeEventListener('abort', onExternalAbort)
    if (activeController === controller) {
      activeController = null
    }
  }
}
