/**
 * 车队监控 Feature 公开根组件（SPEC §12.3、§12.5；TASK-010/011）。
 *
 * 职责：协调车队场景表达——消费 Feature 内部 FleetRuntimeContext（运行时 +
 *       低频连接状态，由 FleetRuntimeProvider 注入），创建并单一持有三类共
 *       享结构：程序化 AGV 共用几何/材质资源（VehicleResources）、实例槽位
 *       表（车体与标签共用的「实体键 → (批次, 槽位)」映射）与批次数（唯一
 *       进入 React state 的结构值），组合车辆实例批次图层与图集化标签图层。
 *       本组件是 fleet-monitoring 在场景内的唯一公开根：app 组合层经它接入
 *       车辆渲染，不感知内部组件与运行时细节。
 * 边界：不解析协议、不连接数据源（连接生命周期归 FleetRuntimeProvider）、
 *       不做状态派生（model 层职责）、不读运行时配置文件；世界变换由 app
 *       组合层显式注入（SPEC §12.4：地图模型与坐标转换由 app 注入，本
 *       Feature 不导入地图实现）。选择/告警环与交通锁属 TASK-012，在本组件
 *       下追加组合。
 * 关键不变量：
 * 1. 共享结构单一所有者：resources 在本组件生命周期内只创建一次（useMemo），
 *    槽位表以 useRef 惰性创建并随卸载丢弃，卸载时幂等释放资源——批次组件
 *    只消费不释放；车体与标签共用同一槽位表，标签槽位恒等于车体槽位；
 * 2. 批次数是唯一进入 React state 的结构值：扩容只发生在车队超过当前容量
 *    时（≤1 次重建），两个图层经同一状态保持批次一致；
 * 3. worldTransform 为 null（地图未就绪）时渲染 null：不放置任何车辆与标
 *    签，也不创建实例缓冲；运行时继续积累事件，地图就绪后首帧全量重写收敛；
 * 4. 数据源缺失或断开（IDLE/ERROR 等）不改变本组件行为：运行时已积累的
 *    车辆照常渲染，静态地图语义不受车队数据存在性影响（SPEC §11.2）；
 *    标签图集不可用时整层降级不渲染，车体语义不受影响（SPEC §6.4 降级）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createDiagnosticsReporter, type DiagnosticsReporter } from '@/shared/diagnostics'
import type { WorldTransform } from '@/shared/spatial'
import { useFleetRuntime } from '../hooks/FleetRuntimeContext'
import {
  createVehicleResources,
  type VehicleResources,
} from '../scene/createVehicleGeometry'
import {
  createInstanceSlotTable,
  SLOT_HARD_CAP,
} from '../model/instanceSlots'
import { VehicleInstances } from './VehicleInstances'
import { VehicleLabels } from './VehicleLabels'

export interface FleetMonitoringFeatureProps {
  /** 地图世界变换；null 表示地图尚未就绪（不渲染车辆与标签） */
  worldTransform: WorldTransform | null
  /** 渲染硬上限；默认 512（SPEC §4），测试可注入 */
  hardCap?: number
  /** 结构化诊断通道（硬上限溢出、标签图集降级等）；默认独立通道 */
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

  // 实例槽位表：车体与标签共享（标签槽位 = 车体槽位），随本组件卸载丢弃
  const tableRef = useRef<ReturnType<typeof createInstanceSlotTable> | null>(null)
  if (tableRef.current === null) {
    tableRef.current = createInstanceSlotTable({ hardCap })
  }
  const table = tableRef.current

  // 批次数：唯一进入 React state 的结构值（两图层共用，保持批次一致）
  const [batchCount, setBatchCount] = useState(1)

  // 兜底诊断通道：未注入时仅创建一次，保证引用稳定
  const fallbackDiagnostics = useMemo(
    () => (diagnostics === undefined ? createDiagnosticsReporter() : undefined),
    [diagnostics],
  )
  const effectiveDiagnostics = diagnostics ?? fallbackDiagnostics

  if (worldTransform === null) {
    // 地图未就绪：不渲染车辆与标签（不变量 3）；资源在本组件挂载期间保持
    return null
  }

  return (
    <group name="fleet-monitoring-feature">
      <VehicleInstances
        runtime={runtime}
        worldTransform={worldTransform}
        resources={resources}
        table={table}
        batchCount={batchCount}
        onBatchCountChanged={setBatchCount}
        diagnostics={effectiveDiagnostics}
      />
      <VehicleLabels
        runtime={runtime}
        worldTransform={worldTransform}
        table={table}
        batchCount={batchCount}
        diagnostics={effectiveDiagnostics}
      />
    </group>
  )
}
