// 应用组合根（SPEC §7.1、§10.3、§12.3；TASK-004 接入启动编排，TASK-007 接入
// 数据源选择，TASK-014 接入渲染质量配置传递，TASK-016 接入 WebGL 上下文恢复，
// TASK-017 接入并行初始化与启动阶段指标）。
// 职责：持有启动状态机并编排 SPEC §10.3 的启动阶段——阶段 1 读取配置；
//       阶段 2 起地图加载与数据源初始化并行：dataSource='ws' 的数据源在配
//       置就绪后立即创建并以「地图上下文 promise」异步绑定 mapId（连接与
//       地图下载并行，见 WS 数据源延迟绑定语义），dataSource='mock' 的数据
//       源仍在 MapModel 就绪（阶段 3 完成）后创建；就绪后以地图视图描述符 +
//       数据源装配唯一全屏 Canvas 内的场景组合根 AgvMonitorScene。地图阶段
//       失败时按指数退避在后台自动重试（清屏色不变，地图上下文 promise 在
//       首个成功地图兑现），配置阶段失败为终态（保持清屏色，不渲染任何错
//       误 DOM）。config.renderer（maxDpr/shadowMapSize）经 props 传入场景，
//       由 render-quality 与地图灯光消费。TASK-016：经 Canvas onCreated 捕
//       获渲染器并交给 useWebGLContextRecovery 监听上下文丢失/恢复——丢失即
//       preventDefault 并随恢复期暂停帧提交，恢复后递增 GPU 资源代驱动各
//       Feature 按确定顺序重建，重建结算成功才恢复渲染；连续三次失败记录结
//       构化错误并永久停止渲染。
// 关键不变量（SPEC §7.1 / §7.4 / D2）：
// 1. 整个应用自始至终只挂载一个 Canvas，尺寸 100vw × 100dvh；Canvas 外无
//    任何 DOM 覆盖层（无加载/错误/进度/连接状态 UI；上下文恢复失败后页面
//    仍只有原 Canvas，无 DOM 兜底、不自动刷新）；
// 2. 启动可取消：effect 清理中止进行中的启动流程、拒绝地图上下文 promise
//    并清除重试计时器，StrictMode 的 setup→cleanup→setup 只保留最后一次流
//    程的结果；
// 3. App 只做组合与启动状态持有，不承载地图校验、几何构建、协议映射等业
//    务算法；
// 4. 数据源初始化屏障按形态区分（SPEC §10.3 阶段 2）：WS = config 就绪
//    （mapId 延迟绑定，重试链对数据源透明，首个成功地图兑现绑定）；
//    Mock = MapModel 就绪（内核需要真实拓扑）。数据源为 null（配置失败 /
//    mock 尚未就绪 / wsUrl 缺失）是合法稳态，静态地图照常装配；
// 5. ACESFilmic 色调映射在 Canvas 上显式声明（SPEC §5.4 的唯一色调映射口径）；
// 6. 后台节流（SPEC §11.5；TASK-015）：页面隐藏时 Canvas frameloop 切为
//    never——R3F 帧循环完全停止（useFrame 不执行、帧同步不消费脏集合、
//    GPU 零提交），数据源与运行时继续在后台归并每车最新快照；回前台恢复
//    always 后首个渲染帧消费全部积压脏标记，与最新快照一帧对齐。可见性是
//    秒/分钟级低频信号，进入 React state 合法（SPEC §4 只禁高频）；
// 7. 上下文恢复（SPEC §11.9；TASK-016）：frameloop = 可见 && 恢复状态机处
//    于 running——上下文丢失（含恢复重建与重试等待期）与恢复失败终态都保
//    持 never（暂停帧提交/停止渲染）；数据源与运行时在恢复期间照常归并最
//    新快照，恢复成功后首帧全量对齐；恢复状态是低频事件，进入 React state
//    合法。
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas } from '@react-three/fiber'
import {
  createDiagnosticsReporter,
  isAbortError,
} from '@/shared/diagnostics'
import type { MapModel, MapViewDescriptor } from '@/features/map-visualization'
import type { VehicleDataSource } from '@/features/fleet-monitoring'
import {
  MOCK_DEV_BRIDGE_KEY,
  registerMockDevBridge,
  type MockVehicleDataSource,
} from '@/features/mock-simulation'
import type { RuntimeConfig } from './bootstrap/loadRuntimeConfig'
import {
  asStartupError,
  loadStartupConfig,
  loadStartupMap,
} from './bootstrap/bootstrapApplication'
import { selectVehicleDataSource } from './bootstrap/selectVehicleDataSource'
import { AgvMonitorScene } from './scene/AgvMonitorScene'
import { useWebGLContextRecovery, type ContextRecoveryRenderer } from './webgl/useWebGLContextRecovery'

/** 启动重试基础间隔与上限（毫秒）：指数退避 1s→2s→4s…≤30s */
const STARTUP_RETRY_BASE_MS = 1000
const STARTUP_RETRY_MAX_MS = 30000

/**
 * 启动状态机（SPEC §10.3；TASK-017 引入 config-ready 并行窗口）：
 * - pending：config 加载中，页面保持清屏色；
 * - config-ready：阶段 1 完成、地图加载中（阶段 2/3）。携带配置与地图上下
 *   文 promise——WS 数据源在本阶段创建（与地图下载并行初始化）；
 * - ready：地图就绪（阶段 3 完成），携带场景描述符（含 bootstrap 种子）、
 *   配置与地图上下文；Mock 数据源在本阶段创建；
 * - config-failed：配置阶段终态失败，保持清屏色，无自动重试（SPEC §7.4）。
 */
type StartupState =
  | { phase: 'pending' }
  | {
      phase: 'config-ready'
      config: RuntimeConfig
      configUrl: string
      /**
       * 地图上下文 promise（TASK-017）：WS 数据源的 mapId 绑定来源。首个
       * 成功的地图阶段加载兑现；取消/终态失败时拒绝（此时数据源已随 App
       * 卸载丢弃）。重试链对 promise 消费方透明。
       */
      mapContext: Promise<string>
    }
  | {
      phase: 'ready'
      mapDescriptor: MapViewDescriptor
      config: RuntimeConfig
      configUrl: string
      mapId: string
      /** 地图模型：Mock 数据源创建的硬前置（内核需要真实拓扑） */
      mapModel: MapModel
      /** 同一地图上下文 promise（WS 实例复用的身份键；mock 分支不消费） */
      mapContext: Promise<string>
    }
  | { phase: 'config-failed' }

export function App() {
  const [startup, setStartup] = useState<StartupState>({ phase: 'pending' })
  // 诊断通道仅创建一次，同时供启动编排、重试与数据源选择上报使用
  const diagnostics = useMemo(() => createDiagnosticsReporter(), [])
  // 启动起点（TASK-017）：appInteractive 阶段耗时的计时原点（B3 口径中的
  // 「导航开始」），ref 初始化一次，挂载后恒定
  const startedAtRef = useRef<number>(0)
  if (startedAtRef.current === 0) {
    startedAtRef.current = performance.now()
  }

  // 渲染器捕获（TASK-016）：R3F 在创建渲染器后回调 onCreated（引用稳定），
  // 捕获进 state 供恢复 Hook 挂监听；StrictMode 重挂产生的旧渲染器随 R3F
  // 自身清理，state 始终指向最新一次创建的渲染器。
  const [renderer, setRenderer] = useState<ContextRecoveryRenderer | null>(null)

  // WebGL 上下文恢复状态机（不变量 7）：丢失即暂停提交（frameloop never），
  // 恢复后经资源代驱动重建、结算成功才回到 running。
  const { state: recovery, settleContextRecovery } = useWebGLContextRecovery({
    renderer,
    diagnostics,
  })

  // 页面可见性 → Canvas frameloop（SPEC §11.5；不变量 6）：监听回调内实时
  // 读取 document.visibilityState，不缓存事件间状态；监听随 effect 对称
  // 摘除，StrictMode 双执行不产生重复回调。
  const [pageVisible, setPageVisible] = useState<boolean>(
    () => document.visibilityState !== 'hidden',
  )
  useEffect(() => {
    const handleVisibilityChange = (): void => {
      setPageVisible(document.visibilityState !== 'hidden')
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let attempt = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const controller = new AbortController()

    // 地图上下文 deferred（不变量 4）：config-ready 阶段交付 WS 数据源作
    // mapId 绑定；首个成功的地图阶段兑现；取消/终态失败时拒绝。mock 分支
    // 不消费该 promise，显式 catch 避免无消费者的 unhandled rejection。
    let resolveMapContext: ((mapId: string) => void) | null = null
    let rejectMapContext: ((error: unknown) => void) | null = null
    const mapContext = new Promise<string>((resolve, reject) => {
      resolveMapContext = resolve
      rejectMapContext = reject
    })
    mapContext.catch(() => {
      // 无消费者的拒绝噪声兜底（WS 分支会另行挂带处理的回调）
    })
    const rejectContext = (error: unknown): void => {
      rejectMapContext?.(error)
      rejectMapContext = null
    }

    const start = (): void => {
      void (async () => {
        try {
          // 阶段 1：读取并校验 config.json（失败以稳定错误码上报后重抛）
          const { config, configUrl } = await loadStartupConfig({
            signal: controller.signal,
            diagnostics,
          })
          if (disposed) {
            return
          }
          // 阶段 2 并行窗口打开：先把「config + 地图上下文 promise」交给
          // 渲染树（WS 数据源据此立即创建并连接，与下行的地图下载并行），
          // 再继续 await 地图阶段（SPEC §10.3 阶段 2/3）
          setStartup({ phase: 'config-ready', config, configUrl, mapContext })
          const mapResult = await loadStartupMap(config, {
            signal: controller.signal,
            diagnostics,
          })
          if (disposed) {
            return
          }
          resolveMapContext?.(mapResult.mapModel.mapId)
          resolveMapContext = null
          // 地图阶段完成（阶段 3）：就绪即构建一次描述符对象（引用稳定，
          // 场景 Hook 以其字段为依赖）
          setStartup({
            phase: 'ready',
            mapDescriptor: {
              mapUrl: mapResult.mapUrl,
              coordinateTransform: config.coordinateTransform,
              initial: {
                mapModel: mapResult.mapModel,
                worldTransform: mapResult.worldTransform,
              },
            },
            config,
            configUrl,
            mapId: mapResult.mapModel.mapId,
            mapModel: mapResult.mapModel,
            mapContext,
          })
        } catch (error: unknown) {
          // 卸载/重挂载取消与 StrictMode 竞态：静默丢弃（promise 一并拒绝）
          if (disposed || isAbortError(error)) {
            rejectContext(
              new DOMException('启动已被取消', 'AbortError'),
            )
            return
          }
          const structured = asStartupError(error)
          if (structured.code.startsWith('CONFIG_')) {
            // 配置失败为终态：无有效配置就无法知道地图地址，保持清屏色
            rejectContext(error)
            setStartup({ phase: 'config-failed' })
            return
          }
          // 地图阶段失败：清屏色保持，地图上下文 promise 保持待定（重试链
          // 内部消化，WS 数据源的绑定不受单次失败影响），指数退避重试
          attempt += 1
          const delayMs = Math.min(
            STARTUP_RETRY_BASE_MS * 2 ** (attempt - 1),
            STARTUP_RETRY_MAX_MS,
          )
          diagnostics.report('APP_STARTUP_RETRY', 'warn', '启动地图阶段失败，已安排后台重试', {
            code: structured.code,
            attempt,
            delayMs,
            reason: error instanceof Error ? error.message : String(error),
          })
          retryTimer = setTimeout(start, delayMs)
        }
      })()
    }

    start()
    return () => {
      disposed = true
      controller.abort()
      rejectContext(new DOMException('启动已被取消', 'AbortError'))
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
      }
    }
  }, [diagnostics])

  // WS 数据源实例缓存（不变量 4）：config-ready 阶段创建一次；进入 ready
  // 后复用同一实例（绝不因状态跃迁重建/重连）。以地图上下文 promise 身份
  // 为键，promise 更换（理论上的重挂载路径）时旧实例随引用丢弃。
  const wsSourceRef = useRef<{
    mapContext: Promise<string>
    source: VehicleDataSource | null
  } | null>(null)

  // 数据源选择（不变量 4）：WS 在 config-ready 即创建（并行初始化）；
  // Mock 在 ready（MapModel 就绪）后创建。memo 依赖 startup 只在状态跃迁
  // 时变化（低频）。
  const vehicleSource: VehicleDataSource | null = useMemo(() => {
    if (startup.phase === 'config-ready') {
      if (startup.config.dataSource !== 'ws') {
        // Mock 的初始化屏障是 MapModel（ready 阶段），config-ready 期间
        // 无车队数据（合法稳态，静态地图照常）
        return null
      }
      const cached = wsSourceRef.current
      if (cached === null || cached.mapContext !== startup.mapContext) {
        const entry = {
          mapContext: startup.mapContext,
          source: selectVehicleDataSource({
            config: startup.config,
            mapId: startup.mapContext,
            diagnostics,
          }),
        }
        wsSourceRef.current = entry
        return entry.source
      }
      return cached.source
    }
    if (startup.phase === 'ready') {
      if (startup.config.dataSource === 'ws') {
        // WS 实例已在 config-ready 创建：绝不重建（重建即断开重连）
        const cached = wsSourceRef.current
        return cached !== null && cached.mapContext === startup.mapContext
          ? cached.source
          : null
      }
      return selectVehicleDataSource({
        config: startup.config,
        mapId: startup.mapId,
        mapModel: startup.mapModel,
        diagnostics,
      })
    }
    return null
  }, [startup, diagnostics])

  // __AGV_MOCK__ 开发桥（SPEC §9.3：只在开发和 Mock 模式暴露）：在提交阶段
  // 注册到「实际被连接的数据源实例」——StrictMode 双渲染会丢弃其中一个
  // render 产物，只有 effect 拿到的实例与连接生命周期一致。生产构建中
  // import.meta.env.DEV 被静态替换为 false，注册块连同 Mock 全局键名字符串
  // 被死代码消除，生产产物无 Mock 全局。清理时对称摘除，卸载后不留残留。
  useEffect(() => {
    if (!import.meta.env.DEV) {
      return
    }
    if (vehicleSource === null || !('devControl' in vehicleSource)) {
      return
    }
    registerMockDevBridge((vehicleSource as MockVehicleDataSource).devControl, {
      dev: true,
    })
    return () => {
      delete (globalThis as Record<string, unknown>)[MOCK_DEV_BRIDGE_KEY]
    }
  }, [vehicleSource])

  return (
    <Canvas
      style={{ width: '100vw', height: '100dvh' }}
      gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
      camera={{ fov: 60, near: 0.5, far: 4000, position: [0, 300, 300] }}
      frameloop={pageVisible && recovery.phase === 'running' ? 'always' : 'never'}
      onCreated={(state) => {
        setRenderer(state.gl)
      }}
    >
      <AgvMonitorScene
        mapDescriptor={startup.phase === 'ready' ? startup.mapDescriptor : null}
        vehicleSource={vehicleSource}
        staleAfterMs={startup.phase === 'ready' ? startup.config.staleAfterMs : undefined}
        worldTransform={
          startup.phase === 'ready' ? (startup.mapDescriptor.initial?.worldTransform ?? null) : null
        }
        maxDpr={startup.phase === 'ready' ? startup.config.renderer.maxDpr : undefined}
        shadowMapSize={
          startup.phase === 'ready' ? startup.config.renderer.shadowMapSize : undefined
        }
        contextGeneration={recovery.generation}
        onContextRecoverySettled={settleContextRecovery}
        diagnostics={diagnostics}
        startedAt={startedAtRef.current}
      />
    </Canvas>
  )
}

export default App
