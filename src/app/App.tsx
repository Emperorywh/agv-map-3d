// 应用组合根（SPEC §7.1、§10.3、§12.3；TASK-004 接入启动编排）。
// 职责：持有启动状态（bootstrapApplication：config + 地图首载），就绪后以
//       地图视图描述符装配唯一全屏 Canvas 内的场景组合根 AgvMonitorScene；
//       地图阶段失败时按指数退避在后台自动重试（清屏色不变），配置阶段失败
//       为终态（保持清屏色，不渲染任何错误 DOM）。
// 关键不变量（SPEC §7.1 / §7.4 / D2）：
// 1. 整个应用自始至终只挂载一个 Canvas，尺寸 100vw × 100dvh；Canvas 外无
//    任何 DOM 覆盖层（无加载/错误/进度 UI）；
// 2. 启动可取消：effect 清理中止进行中的启动流程并清除重试计时器，
//    StrictMode 的 setup→cleanup→setup 只保留最后一次流程的结果；
// 3. App 只做组合与启动状态持有，不承载地图校验、几何构建等业务算法；
// 4. ACESFilmic 色调映射在 Canvas 上显式声明（SPEC §5.4 的唯一色调映射口径）。
import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { Canvas } from '@react-three/fiber'
import {
  createDiagnosticsReporter,
  isAbortError,
  StructuredError,
} from '@/shared/diagnostics'
import type { MapViewDescriptor } from '@/features/map-visualization'
import { bootstrapApplication } from './bootstrap/bootstrapApplication'
import { AgvMonitorScene } from './scene/AgvMonitorScene'

/** 启动重试基础间隔与上限（毫秒）：指数退避 1s→2s→4s…≤30s */
const STARTUP_RETRY_BASE_MS = 1000
const STARTUP_RETRY_MAX_MS = 30000

/**
 * 启动状态机（TASK-004 阶段）：
 * - pending：启动进行中或地图阶段后台重试中，页面保持清屏色；
 * - ready：config 与地图均就绪，携带场景描述符（含 bootstrap 种子）；
 * - config-failed：配置阶段终态失败，保持清屏色，无自动重试（SPEC §7.4）。
 * 后续启动编排扩展（数据源并行、阶段指标、恢复矩阵）归 TASK-017。
 */
type StartupState =
  | { phase: 'pending' }
  | { phase: 'ready'; mapDescriptor: MapViewDescriptor }
  | { phase: 'config-failed' }

export function App() {
  const [startup, setStartup] = useState<StartupState>({ phase: 'pending' })
  // 诊断通道仅创建一次，同时供启动编排与重试上报使用
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

  return (
    <Canvas
      style={{ width: '100vw', height: '100dvh' }}
      gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
      camera={{ fov: 60, near: 0.5, far: 4000, position: [0, 300, 300] }}
    >
      <AgvMonitorScene
        mapDescriptor={startup.phase === 'ready' ? startup.mapDescriptor : null}
      />
    </Canvas>
  )
}

export default App
