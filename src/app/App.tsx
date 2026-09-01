// 应用组合根（SPEC §7.1、§10.3、§12.3；TASK-004 接入启动编排，TASK-007 接入
// 数据源选择）。
// 职责：持有启动状态（bootstrapApplication：config + 地图首载），就绪后按
//       配置构造车辆数据源（WS / Mock 选择），以地图视图描述符 + 数据源装配
//       唯一全屏 Canvas 内的场景组合根 AgvMonitorScene；地图阶段失败时按指数
//       退避在后台自动重试（清屏色不变），配置阶段失败为终态（保持清屏色，
//       不渲染任何错误 DOM）。
// 关键不变量（SPEC §7.1 / §7.4 / D2）：
// 1. 整个应用自始至终只挂载一个 Canvas，尺寸 100vw × 100dvh；Canvas 外无
//    任何 DOM 覆盖层（无加载/错误/进度/连接状态 UI）；
// 2. 启动可取消：effect 清理中止进行中的启动流程并清除重试计时器，
//    StrictMode 的 setup→cleanup→setup 只保留最后一次流程的结果；
// 3. App 只做组合与启动状态持有，不承载地图校验、几何构建、协议映射等
//    业务算法；数据源实例按配置构造一次（useMemo），连接生命周期由 Feature
//    内 Provider 的 Hook 管理；
// 4. 数据源为 null（Mock 缺地图拓扑 / wsUrl 缺失）是合法稳态：静态地图照常
//    装配；Mock 数据源在 MapModel 拓扑就绪后创建（就绪态携带 mapModel），
//    WS 数据源不受该屏障限制；
// 5. ACESFilmic 色调映射在 Canvas 上显式声明（SPEC §5.4 的唯一色调映射口径）。
import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { Canvas } from '@react-three/fiber'
import {
  createDiagnosticsReporter,
  isAbortError,
  StructuredError,
} from '@/shared/diagnostics'
import type { MapModel, MapViewDescriptor } from '@/features/map-visualization'
import type { VehicleDataSource } from '@/features/fleet-monitoring'
import {
  MOCK_DEV_BRIDGE_KEY,
  registerMockDevBridge,
  type MockVehicleDataSource,
} from '@/features/mock-simulation'
import type { RuntimeConfig } from './bootstrap/loadRuntimeConfig'
import { bootstrapApplication } from './bootstrap/bootstrapApplication'
import { selectVehicleDataSource } from './bootstrap/selectVehicleDataSource'
import { AgvMonitorScene } from './scene/AgvMonitorScene'

/** 启动重试基础间隔与上限（毫秒）：指数退避 1s→2s→4s…≤30s */
const STARTUP_RETRY_BASE_MS = 1000
const STARTUP_RETRY_MAX_MS = 30000

/**
 * 启动状态机（TASK-004 阶段 + TASK-007 数据源选择）：
 * - pending：启动进行中或地图阶段后台重试中，页面保持清屏色；
 * - ready：config 与地图均就绪，携带场景描述符（含 bootstrap 种子）、配置与
 *   地图上下文（数据源选择输入）；
 * - config-failed：配置阶段终态失败，保持清屏色，无自动重试（SPEC §7.4）。
 * 后续启动编排扩展（数据源并行初始化、阶段指标、恢复矩阵）归 TASK-017。
 */
type StartupState =
  | { phase: 'pending' }
  | {
      phase: 'ready'
      mapDescriptor: MapViewDescriptor
      config: RuntimeConfig
      mapId: string
      /** 地图模型：Mock 数据源创建的硬前置（内核需要真实拓扑） */
      mapModel: MapModel
    }
  | { phase: 'config-failed' }

export function App() {
  const [startup, setStartup] = useState<StartupState>({ phase: 'pending' })
  // 诊断通道仅创建一次，同时供启动编排、重试与数据源选择上报使用
  const diagnostics = useMemo(() => createDiagnosticsReporter(), [])

  useEffect(() => {
    let disposed = false
    let attempt = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const controller = new AbortController()

    const start = (): void => {
      void bootstrapApplication({ signal: controller.signal, diagnostics })
        .then((result) => {
          if (disposed) {
            return
          }
          // 就绪即构建一次描述符对象（引用稳定，场景 Hook 以其字段为依赖）
          setStartup({
            phase: 'ready',
            mapDescriptor: {
              mapUrl: result.mapUrl,
              coordinateTransform: result.config.coordinateTransform,
              initial: {
                mapModel: result.mapModel,
                worldTransform: result.worldTransform,
              },
            },
            config: result.config,
            mapId: result.mapModel.mapId,
            mapModel: result.mapModel,
          })
        })
        .catch((error: unknown) => {
          // 卸载/重挂载取消与 StrictMode 竞态：静默丢弃
          if (disposed || isAbortError(error)) {
            return
          }
          const code =
            error instanceof StructuredError ? error.code : 'BOOTSTRAP_FAILED'
          if (code.startsWith('CONFIG_')) {
            // 配置失败为终态：无有效配置就无法知道地图地址，保持清屏色
            setStartup({ phase: 'config-failed' })
            return
          }
          // 地图阶段失败：清屏色保持，后台指数退避重试（SPEC §7.4 / §11.10）
          attempt += 1
          const delayMs = Math.min(
            STARTUP_RETRY_BASE_MS * 2 ** (attempt - 1),
            STARTUP_RETRY_MAX_MS,
          )
          diagnostics.report('APP_STARTUP_RETRY', 'warn', '启动地图阶段失败，已安排后台重试', {
            code,
            attempt,
            delayMs,
            reason: error instanceof Error ? error.message : String(error),
          })
          retryTimer = setTimeout(start, delayMs)
        })
    }

    start()
    return () => {
      disposed = true
      controller.abort()
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
      }
    }
  }, [diagnostics])

  // 数据源按就绪配置构造一次（useMemo 依赖 startup 只在 ready 时变化一次）；
  // 返回 null（Mock 缺地图拓扑 / wsUrl 缺失）即「无车队数据」稳态，地图照常渲染
  const vehicleSource: VehicleDataSource | null = useMemo(() => {
    if (startup.phase !== 'ready') {
      return null
    }
    return selectVehicleDataSource({
      config: startup.config,
      mapId: startup.mapId,
      mapModel: startup.mapModel,
      diagnostics,
    })
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
    >
      <AgvMonitorScene
        mapDescriptor={startup.phase === 'ready' ? startup.mapDescriptor : null}
        vehicleSource={vehicleSource}
        staleAfterMs={startup.phase === 'ready' ? startup.config.staleAfterMs : undefined}
      />
    </Canvas>
  )
}

export default App
