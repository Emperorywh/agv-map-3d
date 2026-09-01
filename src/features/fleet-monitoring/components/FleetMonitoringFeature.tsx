/**
 * 车队监控 Feature 公开根组件（SPEC §12.3、§12.5；TASK-010）。
 *
 * 职责：协调车队场景表达——消费 Feature 内部 FleetRuntimeContext（运行时 +
 *       低频连接状态，由 FleetRuntimeProvider 注入），创建并单一持有程序化
 *       AGV 共用几何/材质资源，组合车辆实例批次图层。本组件是 fleet-
 *       monitoring 在场景内的唯一公开根：app 组合层经它接入车辆渲染，不
 *       感知内部组件与运行时细节。
 * 边界：不解析协议、不连接数据源（连接生命周期归 FleetRuntimeProvider）、
 *       不做状态派生（model 层职责）、不读运行时配置文件；世界变换由 app
 *       组合层显式注入（SPEC §12.4：地图模型与坐标转换由 app 注入，本
 *       Feature 不导入地图实现）。标签、选择/告警环与交通锁属 TASK-011/
 *       012，在本组件下追加组合。
 * 关键不变量：
 * 1. 共用 GPU 资源单一所有者：resources 在本组件生命周期内只创建一次
 *    （useMemo），卸载时幂等释放——批次组件只消费不释放；
 * 2. worldTransform 为 null（地图未就绪）时渲染 null：不放置任何车辆，
 *    也不创建实例缓冲；运行时继续积累事件，地图就绪后首帧全量重写收敛；
 * 3. 数据源缺失或断开（IDLE/ERROR 等）不改变本组件行为：运行时已积累的
 *    车辆照常渲染，静态地图语义不受车队数据存在性影响（SPEC §11.2）。
 */
import { useEffect, useMemo } from 'react'
import { createDiagnosticsReporter, type DiagnosticsReporter } from '@/shared/diagnostics'
import type { WorldTransform } from '@/shared/spatial'
import { useFleetRuntime } from '../hooks/FleetRuntimeContext'
import {
  createVehicleResources,
  type VehicleResources,
} from '../scene/createVehicleGeometry'
import { SLOT_HARD_CAP } from '../model/instanceSlots'
import { VehicleInstances } from './VehicleInstances'

export interface FleetMonitoringFeatureProps {
  /** 地图世界变换；null 表示地图尚未就绪（不渲染车辆） */
  worldTransform: WorldTransform | null
  /** 渲染硬上限；默认 512（SPEC §4），测试可注入 */
  hardCap?: number
  /** 结构化诊断通道（硬上限溢出等）；默认独立通道 */
  diagnostics?: DiagnosticsReporter
}

export function FleetMonitoringFeature({
  worldTransform,
  hardCap = SLOT_HARD_CAP,
  diagnostics,
}: FleetMonitoringFeatureProps) {
  const { runtime } = useFleetRuntime()

  // 共用几何/材质单一所有者：Feature 挂载期间恒定，卸载幂等释放
  const resources = useMemo<VehicleResources>(() => createVehicleResources(), [])
  useEffect(() => () => resources.dispose(), [resources])

  // 兜底诊断通道：未注入时仅创建一次，保证引用稳定
  const fallbackDiagnostics = useMemo(
    () => (diagnostics === undefined ? createDiagnosticsReporter() : undefined),
    [diagnostics],
  )

  if (worldTransform === null) {
    // 地图未就绪：不渲染车辆（不变量 2）；资源在本组件挂载期间保持
    return null
  }

  return (
    <group name="fleet-monitoring-feature">
      <VehicleInstances
        runtime={runtime}
        worldTransform={worldTransform}
        resources={resources}
        hardCap={hardCap}
        diagnostics={diagnostics ?? fallbackDiagnostics}
      />
    </group>
  )
}
