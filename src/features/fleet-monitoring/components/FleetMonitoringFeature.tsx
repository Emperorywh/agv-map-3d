/**
 * 车队监控 Feature 公开根组件（SPEC §12.3、§12.5；TASK-010/011/012/016）。
 *
 * 职责：协调车队场景表达——消费 Feature 内部 FleetRuntimeContext（运行时 +
 *       低频连接状态，由 FleetRuntimeProvider 注入），创建并单一持有共享结
 *       构：程序化 AGV 共用几何/材质资源（VehicleResources）、光环共用几
 *       何/材质（RingResources）、实例槽位表（车体/标签/光环共用的
 *       「实体键 → (批次, 槽位)」映射）与批次数（唯一进入 React state 的结
 *       构值）；组合车辆实例、图集化标签、分层光环与交通锁四个图层，并把
 *       选择交互（useVehicleSelection）展开在包裹 group 上。
 *       本组件是 fleet-monitoring 在场景内的唯一公开根：app 组合层经它接入
 *       车辆渲染与交互回调，不感知内部组件与运行时细节。
 *       TASK-016 接入上下文恢复重建：contextGeneration 资源代递增时，共享
 *       几何/材质（车辆/光环）整代重建（旧资源由所有权 effect 释放），四个
 *       图层经 keyed Fragment 整体重挂——图集、批次几何与交通锁资源随重挂
 *       全部重建，批次矩阵/标签实例属性由帧同步 Hook 以运行时实体表为唯一
 *       事实源全量重写收敛（恢复期间运行时继续保留的最新数据随之落地）。
 * 边界：不解析协议、不连接数据源（连接生命周期归 FleetRuntimeProvider）、
 *       不做状态派生（model 层职责）、不读运行时配置文件；世界变换由 app
 *       组合层显式注入（SPEC §12.4：地图模型与坐标转换由 app 注入，本
 *       Feature 不导入地图实现）。双击跟随只经 onFollowRequest 上抛请求，
 *       相机行为归 app 组合层与 camera-navigation（TASK-013）。
 * 关键不变量：
 * 1. 共享结构单一所有者：resources / ringResources 在同一资源代内只创建一
 *    次（useMemo 以资源代为依赖），槽位表以 useRef 惰性创建并随卸载丢弃，
 *    卸载/换代时幂等释放——批次组件只消费不释放；车体、标签与光环共用同
 *    一槽位表（换代不换表：槽位映射是纯 JS 结构，与 GL 无关）；
 * 2. 批次数是唯一进入 React state 的结构值：扩容只发生在车队超过当前容量
 *    时（≤1 次重建），三个实例图层经同一状态保持批次一致；
 * 3. worldTransform 为 null（地图未就绪）时渲染 null：不放置任何车辆、标
 *    签、光环与交通锁，也不创建实例缓冲；运行时继续积累事件，地图就绪后
 *    首帧全量重写收敛；
 * 4. 选择是低频 store 状态：本组件不订阅 selectedKey（避免高频渲染），选
 *    中变化由光环/标签的帧同步经 getState 在下一渲染帧表达（SPEC §4）；
 * 5. 恢复重建顺序（TASK-016，SPEC §11.9）：同一恢复提交内按「车辆 → 标签
 *    → 环 → 交通资源」落地（Fragment 内图层 JSX 顺序 = React effect 执行
 *    顺序），且恒在地图 Feature（地图 → 环境）之后；重建期间数据源与运行
 *    时不受影响，恢复后第一帧即与最新快照对齐。
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createDiagnosticsReporter, type DiagnosticsReporter } from '@/shared/diagnostics'
import type { WorldTransform } from '@/shared/spatial'
import { useFleetRuntime } from '../hooks/FleetRuntimeContext'
import { useVehicleSelection } from '../hooks/useVehicleSelection'
import {
  createVehicleResources,
  type VehicleResources,
} from '../scene/createVehicleGeometry'
import {
  createRingResources,
  type RingResources,
} from '../scene/vehicleRings'
import {
  createInstanceSlotTable,
  SLOT_HARD_CAP,
} from '../model/instanceSlots'
import { VehicleInstances } from './VehicleInstances'
import { VehicleLabels } from './VehicleLabels'
import { VehicleRings } from './VehicleRings'
import { TrafficLocksLayer } from './TrafficLocksLayer'

export interface FleetMonitoringFeatureProps {
  /** 地图世界变换；null 表示地图尚未就绪（不渲染车队场景内容） */
  worldTransform: WorldTransform | null
  /** 渲染硬上限；默认 512（SPEC §4），测试可注入 */
  hardCap?: number
  /** 双击跟随请求上抛（实体键）；app 组合层转发给 camera-navigation（TASK-013） */
  onFollowRequest?: (entityKey: string) => void
  /**
   * 标签降级能力开关（SPEC §6.5 行动 1；TASK-014 质量能力接线）：true 时
   * 标签仅保留重点与近景，中距离纯名称档隐藏；默认 false（完整 LOD）。
   */
  importantLabelsOnly?: boolean
  /**
   * 交通锁脉冲能力开关（SPEC §6.5 行动 3；TASK-014）：false 时交通矩形恒定
   * 不透明度；默认 true。
   */
  trafficPulseEnabled?: boolean
  /** 结构化诊断通道（硬上限溢出、标签图集降级等）；默认独立通道 */
  diagnostics?: DiagnosticsReporter
  /**
   * GPU 资源代（TASK-016 上下文恢复）：0 为初始挂载；恢复时由 app 状态机
   * 递增——共享几何/材质整代重建，四个图层经 keyed Fragment 整体重挂。
   */
  contextGeneration?: number
}

export function FleetMonitoringFeature({
  worldTransform,
  hardCap = SLOT_HARD_CAP,
  onFollowRequest,
  importantLabelsOnly = false,
  trafficPulseEnabled = true,
  diagnostics,
  contextGeneration = 0,
}: FleetMonitoringFeatureProps) {
  const { runtime } = useFleetRuntime()

  // 共用几何/材质单一所有者：同一资源代内恒定，换代（TASK-016 恢复重建）
  // 与卸载时幂等释放（旧资源在 effect 清理中 dispose，新资源同提交内生效）。
  // 资源代是「何时重建」的触发器而非构造入参：工厂不消费代号，代号变化即换代。
  const resources = useMemo<VehicleResources>(() => {
    void contextGeneration
    return createVehicleResources()
  }, [contextGeneration])
  useEffect(() => () => resources.dispose(), [resources])

  // 光环共用几何/材质：同上，换代与卸载幂等释放（TASK-012 / TASK-016）
  const ringResources = useMemo<RingResources>(() => {
    void contextGeneration
    return createRingResources()
  }, [contextGeneration])
  useEffect(() => () => ringResources.dispose(), [ringResources])

  // 实例槽位表：车体/标签/光环共享（环槽位 = 车辆槽位 × 3 + 层序），随卸载丢弃
  const tableRef = useRef<ReturnType<typeof createInstanceSlotTable> | null>(null)
  if (tableRef.current === null) {
    tableRef.current = createInstanceSlotTable({ hardCap })
  }
  const table = tableRef.current

  // 批次数：唯一进入 React state 的结构值（三个实例图层共用，保持批次一致）
  const [batchCount, setBatchCount] = useState(1)

  // 选择交互：事件处理器引用稳定（options 经 ref 透传），可安全展开在 group 上
  const selection = useVehicleSelection({ table, onFollowRequest })

  // 兜底诊断通道：未注入时仅创建一次，保证引用稳定
  const fallbackDiagnostics = useMemo(
    () => (diagnostics === undefined ? createDiagnosticsReporter() : undefined),
    [diagnostics],
  )
  const effectiveDiagnostics = diagnostics ?? fallbackDiagnostics

  if (worldTransform === null) {
    // 地图未就绪：不渲染车队场景内容（不变量 3）；资源在挂载期间保持
    return null
  }

  return (
    <group
      name="fleet-monitoring-feature"
      onPointerDown={selection.onPointerDown}
      onClick={selection.onClick}
      onDoubleClick={selection.onDoubleClick}
      onPointerMissed={selection.onPointerMissed}
    >
      {/* key 绑定资源代（TASK-016）：上下文恢复时代号变化强制四个图层整体
          卸载/挂载（JSX 顺序即恢复顺序：车辆→标签→环→交通），图集、批次
          几何与交通锁资源随重挂全部重建，规避 R3F 对已挂载 primitive 换
          object 的重建丢弃问题；选择交互挂在外层 group 上不受重挂影响。 */}
      <Fragment key={`fleet-resources-${contextGeneration}`}>
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
          importantLabelsOnly={importantLabelsOnly}
          diagnostics={effectiveDiagnostics}
        />
        <VehicleRings
          runtime={runtime}
          worldTransform={worldTransform}
          table={table}
          batchCount={batchCount}
          resources={ringResources}
        />
        <TrafficLocksLayer
          runtime={runtime}
          worldTransform={worldTransform}
          pulseEnabled={trafficPulseEnabled}
          diagnostics={effectiveDiagnostics}
        />
      </Fragment>
    </group>
  )
}
