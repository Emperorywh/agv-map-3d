/**
 * 车队运行时 Provider（SPEC §4、§12.3、§12.5；TASK-007）。
 *
 * 职责：作为 fleet-monitoring 内部高频运行时与低频状态的唯一持有者——以
 *       稳定引用创建一次 createFleetRuntime，经 useVehicleDataSource 把数据
 *       源接入运行时（连接/订阅/ticker 生命周期），并把「运行时 + 连接状态」
 *       经 Context 注入子树（Context 与消费 Hook 见 hooks/FleetRuntimeContext.ts）。
 *       车辆组件（TASK-010 起）通过 useFleetRuntime 消费，无需感知数据源
 *       实现（WS 或 Mock）。
 * 边界：本组件是 Feature 内部组合件，只注入稳定引用，不渲染任何可见 DOM、
 *       不创建 Three.js 对象、不解析协议；本文件只导出 Provider 组件本身
 *       （fast-refresh 约束），Context 对象与消费 Hook 不出 Feature。
 * 关键不变量：
 * 1. 运行时单实例：runtime 在 Provider 生命周期内只创建一次（useRef 惰性
 *    初始化），staleAfterMs/诊断通道取首挂载值——高频实体表与脏集合绝不因
 *    重渲染重建（SPEC §4「运行时对象只创建一次」）；
 * 2. Context value 以 runtime（恒定）+ status（低频）组成，引用仅在状态
 *    真实变化时更替；高频事件不经过本组件的任何 state；
 * 3. source 为 null 是合法稳态（Mock 未实现/无数据源配置）：不连接、状态
 *    恒为 IDLE，子树照常渲染——静态地图不依赖车队数据存在；
 * 4. 连接以非取消方式失败时只记结构化诊断并保持状态机自身语义，绝不抛出
 *    或渲染错误 DOM（SPEC §7.4 / D2）；
 * 5. 删除差异转发为低频 store 命令（TASK-012）：onDiffApplied 在高频事件
 *    路径上只调用 store 的命令式动作（notifyEntitiesRemoved），被选中车辆
 *    被删除时选中键立即清空，绝不触碰 React state。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  createDiagnosticsReporter,
  describeError,
  type DiagnosticsReporter,
} from '@/shared/diagnostics'
import {
  useVehicleDataSource,
} from '../hooks/useVehicleDataSource'
import {
  FleetRuntimeContext,
  type FleetRuntimeContextValue,
} from '../hooks/FleetRuntimeContext'
import {
  createFleetRuntime,
  type FleetRuntime,
  type ReadonlyFleetRuntime,
} from '../model/createFleetRuntime'
import { useFleetMonitoringStore } from '../model/fleetMonitoringStore'
import type { SourceStatus, VehicleDataSource } from '../data-source/contract'

/** 兜底诊断通道：仅在调用方未注入 diagnostics 时用于连接失败上报 */
const fallbackDiagnostics = createDiagnosticsReporter()

export interface FleetRuntimeProviderProps {
  /** 车辆数据源；null 表示无数据源（合法稳态，不连接） */
  source: VehicleDataSource | null
  /** 单车过期阈值（毫秒）；缺省用 DEFAULT_STALE_AFTER_MS（10s） */
  staleAfterMs?: number
  /** 诊断通道；默认独立控制台通道（运行时与连接失败共用） */
  diagnostics?: DiagnosticsReporter
  /**
   * 运行时就绪通知（TASK-013）：组合层经它拿到只读运行时引用以构建跟随目
   * 标读取器等适配器。运行时引用在 Provider 生命周期内恒定，StrictMode 重
   * 挂载会以同一引用重复通知——回调必须幂等。
   */
  onRuntimeAvailable?: (runtime: ReadonlyFleetRuntime) => void
  children: ReactNode
}

export function FleetRuntimeProvider({
  source,
  staleAfterMs,
  diagnostics,
  onRuntimeAvailable,
  children,
}: FleetRuntimeProviderProps) {
  // 运行时单实例：StrictMode 双渲染与重渲染都不重建（不变量 1）
  const runtimeRef = useRef<FleetRuntime | null>(null)
  if (runtimeRef.current === null) {
    runtimeRef.current = createFleetRuntime({
      staleAfterMs,
      diagnostics: diagnostics ?? createDiagnosticsReporter(),
    })
  }
  const runtime = runtimeRef.current

  // 低频连接状态：变化频率为秒/分钟级，可安全进入 React state
  const [status, setStatus] = useState<SourceStatus>('IDLE')
  const diagnosticsRef = useRef(diagnostics)
  diagnosticsRef.current = diagnostics

  // 运行时就绪通知（TASK-013）：effect 中以恒定引用回调一次；组合层据此构
  // 建跟随目标读取器。回调经 ref 透传，内联函数不触发重复通知。
  const onRuntimeAvailableRef = useRef(onRuntimeAvailable)
  onRuntimeAvailableRef.current = onRuntimeAvailable
  useEffect(() => {
    onRuntimeAvailableRef.current?.(runtime)
  }, [runtime])

  useVehicleDataSource(source, runtime, {
    onStatusChange: setStatus,
    // 删除差异立即清理低频交互状态：被选中的车辆被删除时选中键同帧清空
    // （SPEC §11.6；TASK-012）。命令式 store 调用不触碰 React state。
    onDiffApplied: (diff) => {
      if (diff.removed.length > 0) {
        useFleetMonitoringStore.getState().notifyEntitiesRemoved(diff.removed)
      }
    },
    onConnectError: (error) => {
      const reporter = diagnosticsRef.current ?? fallbackDiagnostics
      reporter.report(
        'VEHICLE_SOURCE_CONNECT_FAILED',
        'warn',
        '车辆数据源连接失败（非取消），连接层将持续自动重试',
        { reason: describeError(error) },
      )
    },
  })

  const value = useMemo<FleetRuntimeContextValue>(
    () => ({ runtime, status }),
    [runtime, status],
  )

  return (
    <FleetRuntimeContext.Provider value={value}>
      {children}
    </FleetRuntimeContext.Provider>
  )
}
