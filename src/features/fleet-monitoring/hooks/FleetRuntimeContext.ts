/**
 * 车队运行时 Context 与消费入口（SPEC §4、§12.5；TASK-007）。
 *
 * 职责：声明 fleet-monitoring 内部的运行时 Context（高频运行时只读消费入口 +
 *       低频连接状态）与 useFleetRuntime 消费 Hook；由 FleetRuntimeProvider
 *       注入值，车辆渲染组件（TASK-010 起）经本 Hook 取数。
 * 边界：Feature 内部模块，不从 Feature index.ts 导出（跨 Feature 协作由 app
 *       组合层完成）；Context 对象本身绝不被外部直接读写。
 * 关键不变量：
 * 1. Context value 的 runtime 引用在 Provider 生命周期内恒定，status 为低频
 *    状态——高频快照/脏集合永远不进入本 Context 的更替依据；
 * 2. 缺 Provider 属接线缺陷，useFleetRuntime 立即抛出而非静默返回空值。
 */
import { createContext, useContext } from 'react'
import type { FleetRuntime } from '../model/createFleetRuntime'
import type { SourceStatus } from '../data-source/contract'

/** Context 注入值：运行时只读消费入口 + 低频连接状态 */
export interface FleetRuntimeContextValue {
  /** 高频运行时（实体表/脏集合/tick）；引用在 Provider 生命周期内恒定 */
  readonly runtime: FleetRuntime
  /** 数据源连接状态；无数据源时恒为 IDLE */
  readonly status: SourceStatus
}

export const FleetRuntimeContext =
  createContext<FleetRuntimeContextValue | null>(null)

/**
 * Feature 内消费入口：读取运行时与连接状态。
 * 必须在 FleetRuntimeProvider 子树内使用；缺 Provider 属接线错误，立即抛出。
 */
export function useFleetRuntime(): FleetRuntimeContextValue {
  const value = useContext(FleetRuntimeContext)
  if (value === null) {
    throw new Error(
      'useFleetRuntime 必须在 FleetRuntimeProvider 子树内使用（接线缺陷）',
    )
  }
  return value
}
