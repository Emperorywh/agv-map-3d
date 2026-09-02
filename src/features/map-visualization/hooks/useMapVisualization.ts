/**
 * 地图场景生命周期 Hook（SPEC §7.4、§11.10；TASK-004）。
 *
 * 职责：以地图描述符（mapUrl + 仿射参数 + 可选 bootstrap 初始模型）为输入，
 *       管理场景侧的地图加载、后台自动重试、旧场景保留与 GPU 资源释放，
 *       产出「当前生效的地图视图」（模型 + 世界变换 + 已构建静态几何）。
 * 边界：首次启动的地图拉取与启动重试由 app 的 bootstrap 编排负责（本 Hook
 *       只消费其产物 initial，避免重复拉取 14.94MB 地图）；本 Hook 负责其后
 *       的场景刷新生命周期——mapUrl 变化或 initial 缺失时的加载、失败退避
 *       重试、成功后原子替换。不渲染 DOM、不读取运行时配置文件。
 * 关键不变量：
 * 1. 旧场景保留（SPEC §11.10）：已存在有效场景时，刷新失败不清空视图、
 *    不卸载图层，仅在后台按指数退避（1s 起、30s 封顶）自动重试；
 * 2. 原子替换：成功路径只做一次 setState 整体替换视图；旧几何在新视图提交
 *    渲染后（effect 清理阶段）才释放，任何一帧都不引用已释放的 GPU 资源；
 * 3. 可取消：每次加载携带 AbortSignal，描述符变化或卸载时中止进行中的请求、
 *    清除重试计时器，竞态完成的结果被丢弃；
 * 4. 幂等：当前视图已与描述符同源（sourceUrl 相同）时不再重复加载或重建
 *    （StrictMode 的 setup→cleanup→setup 不会重建场景或重复拉取）；
 * 5. 首次失败保持清屏色：尚无视图时加载失败不产出任何地图对象，仅记录
 *    结构化诊断并继续重试；
 * 6. 启动阶段指标（TASK-017，SPEC §10.3 阶段 4）：静态几何构建只在会话首
 *    个视图以 BOOTSTRAP_STAGE_GEOMETRY 计时上报（刷新重建与恢复换代不属于
 *    启动流程，不上报）。
 */
import { useEffect, useRef, useState } from 'react'
import {
  createDiagnosticsReporter,
  describeError,
  isAbortError,
  type DiagnosticsReporter,
} from '@/shared/diagnostics'
import type { AffineParams, WorldTransform } from '@/shared/spatial'
import type { MapModel } from '../model/types'
import { loadMap, type LoadMapResult } from '../services/loadMap'
import { buildMapGeometry, type MapGeometry } from '../scene/buildMapGeometry'

/** bootstrap 已加载的地图模型种子（首挂载直接建模，不重复拉取） */
export interface MapViewSeed {
  readonly mapModel: MapModel
  readonly worldTransform: WorldTransform
}

/** 地图视图描述符：场景侧地图生命周期的唯一输入 */
export interface MapViewDescriptor {
  /** 已由运行时配置解析的地图资源 URL（根路径/子路径部署下的绝对地址） */
  readonly mapUrl: string
  /** 运行时二维仿射参数（与 bootstrap 建模时一致） */
  readonly coordinateTransform: AffineParams
  /** app bootstrap 的地图加载产物；缺失时由本 Hook 自行加载（恢复路径） */
  readonly initial?: MapViewSeed
}

/** 当前生效的地图视图（图层组件只消费该对象） */
export interface MapView {
  /** 单调递增版本号：每次原子替换加一（诊断与测试用） */
  readonly version: number
  /** 本视图的地图来源 URL（幂等判断依据） */
  readonly sourceUrl: string
  readonly mapModel: MapModel
  readonly worldTransform: WorldTransform
  readonly geometry: MapGeometry
}

export interface UseMapVisualizationOptions {
  /** 地图加载实现注入点；默认 loadMap，测试用桩替换 */
  loadMapImpl?: typeof loadMap
  /** 结构化诊断通道；默认创建独立通道 */
  diagnostics?: DiagnosticsReporter
}

export interface MapVisualizationStatus {
  /** 当前生效视图；null 表示尚无有效场景（页面保持清屏色） */
  view: MapView | null
  /** 是否正在加载/重试（含旧场景保留期间的恢复尝试） */
  reloading: boolean
}

/** 场景刷新重试的基础间隔与上限（毫秒）——指数退避 1s→2s→4s…≤30s */
const MAP_RETRY_BASE_MS = 1000
const MAP_RETRY_MAX_MS = 30000

export function useMapVisualization(
  descriptor: MapViewDescriptor | null,
  options: UseMapVisualizationOptions = {},
): MapVisualizationStatus {
  const loadMapImpl = options.loadMapImpl ?? loadMap
  const fallbackDiagnosticsRef = useRef<DiagnosticsReporter | null>(null)
  if (fallbackDiagnosticsRef.current === null) {
    fallbackDiagnosticsRef.current = createDiagnosticsReporter()
  }
  // 注入通道优先；未注入时使用仅创建一次的默认通道，保证引用稳定
  const diagnostics = options.diagnostics ?? fallbackDiagnosticsRef.current

  const [view, setView] = useState<MapView | null>(null)
  const [reloading, setReloading] = useState(false)
  /** 与 state 同步的视图镜像：effect 内可读最新生效视图，无需加入依赖 */
  const viewRef = useRef<MapView | null>(null)
  const versionRef = useRef(0)

  const mapUrl = descriptor?.mapUrl ?? null
  const coordinateTransform = descriptor?.coordinateTransform ?? null
  const initial = descriptor?.initial ?? null

  useEffect(() => {
    // 描述符移除：清空视图（几何由视图所有权 effect 在提交后释放）
    if (mapUrl === null || coordinateTransform === null) {
      viewRef.current = null
      setView(null)
      setReloading(false)
      return
    }
    // 幂等：当前视图已与描述符同源时什么都不做（StrictMode 重复执行安全）
    const current = viewRef.current
    if (current !== null && current.sourceUrl === mapUrl) {
      return
    }

    const controller = new AbortController()
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0

    const applyModel = (result: Pick<LoadMapResult, 'mapModel' | 'worldTransform'>) => {
      // 阶段 4（SPEC §10.3）：去重物理路径并创建静态几何——启动编排的
      // 'geometry' 阶段只在首个视图计时上报（会话级一次性；刷新重建不算启动）
      const geometryStageStartedAt = performance.now()
      const geometry = buildMapGeometry(result.mapModel, result.worldTransform)
      versionRef.current += 1
      if (versionRef.current === 1) {
        diagnostics.report('BOOTSTRAP_STAGE_GEOMETRY', 'info', '启动阶段耗时', {
          stage: 'geometry',
          durationMs: performance.now() - geometryStageStartedAt,
        })
      }
      const nextView: MapView = {
        version: versionRef.current,
        sourceUrl: mapUrl,
        mapModel: result.mapModel,
        worldTransform: result.worldTransform,
        geometry,
      }
      viewRef.current = nextView
      setView(nextView)
      setReloading(false)
      if (attempt > 0) {
        // 曾失败后恢复：记录一次恢复成功，便于运维确认旧场景已延续
        diagnostics.report('MAP_SCENE_RECOVERED', 'info', '地图场景恢复成功', {
          mapUrl,
          attempt,
          version: nextView.version,
        })
      }
    }

    const loadOnce = async (): Promise<void> => {
      setReloading(true)
      try {
        const result = await loadMapImpl({
          mapUrl,
          coordinateTransform,
          signal: controller.signal,
        })
        if (cancelled) {
          return
        }
        applyModel(result)
      } catch (error) {
        if (cancelled || isAbortError(error)) {
          return
        }
        // 失败不清空现有视图（不变量 1）；记录诊断并安排退避重试
        attempt += 1
        const delayMs = Math.min(MAP_RETRY_BASE_MS * 2 ** (attempt - 1), MAP_RETRY_MAX_MS)
        diagnostics.report(
          'MAP_SCENE_LOAD_RETRY',
          'warn',
          '地图场景加载失败，已安排后台自动重试',
          { mapUrl, attempt, delayMs, reason: describeError(error) },
        )
        retryTimer = setTimeout(() => {
          retryTimer = null
          void loadOnce()
        }, delayMs)
      }
    }

    // 首个视图可由 bootstrap 种子直接建模（不重复拉取）；建模异常退回网络加载
    let seeded = false
    if (initial !== null && current === null) {
      try {
        applyModel({ mapModel: initial.mapModel, worldTransform: initial.worldTransform })
        seeded = true
      } catch (error) {
        diagnostics.report('MAP_SCENE_GEOMETRY_FAILED', 'error', '种子地图几何构建失败', {
          mapUrl,
          reason: describeError(error),
        })
      }
    }
    if (!seeded) {
      void loadOnce()
    }

    return () => {
      cancelled = true
      controller.abort()
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
      }
    }
  }, [mapUrl, coordinateTransform, initial, loadMapImpl, diagnostics])

  // 视图所有权：几何在新视图提交渲染后（或卸载时）才释放——原子替换的
  // 最后一环；StrictMode 双执行与刷新替换都经由同一清理路径，幂等释放。
  useEffect(() => {
    if (view === null) {
      return
    }
    const geometry = view.geometry
    return () => {
      geometry.dispose()
    }
  }, [view])

  return { view, reloading }
}
