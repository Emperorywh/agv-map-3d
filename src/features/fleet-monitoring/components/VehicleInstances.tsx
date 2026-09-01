/**
 * 车辆实例批次图层（SPEC §4、§5.2、§6.3、§11.13、§12.5；TASK-010）。
 *
 * 职责：把程序化 AGV 以「批次 × 七部件 InstancedMesh」挂载到场景——持有
 *       实例槽位表（初始 256、按 256 扩批、硬上限 512），按当前批次数挂载
 *       对应数量的批次对象，并把逐帧提交交给 useFleetFrameSync（脏集合的
 *       唯一帧消费者）。批次扩容只发生在车队超过当前容量时（≤1 次重建），
 *       属结构性低频变化，允许进入 React state。
 * 边界：本组件只拥有各批次的 InstancedMesh 实例缓冲；几何与材质归
 *       VehicleResources 所有者（FleetMonitoringFeature），本组件绝不释放
 *       它们；槽位表由本组件创建并随卸载丢弃（矩阵等高频状态不进 React）。
 *       外壳网格携带 userData.batchId，供拾取层把 (batchId, instanceId)
 *       映射回实体键（映射本体在槽位表 resolve，选择接线属 TASK-012）。
 * 关键不变量：
 * 1. 每批次恒为 7 个 InstancedMesh（底盘/外壳/楔/平台/托盘/信标/阴影），
 *    200 台（单批次）车辆主体 Draw Call = 7 ≤ 8（SPEC §6.3）；不参与拾取
 *    的部件关闭 raycast，仅外壳保留拾取（SPEC §5.2）；
 * 2. 全部实例矩阵初始为零缩放：空槽位与超容量等待的车辆绝不以默认单位阵
 *    出现在原点；count 恒等于批次容量，可见性完全由矩阵表达；
 * 3. 车辆不投实时阴影（castShadow=false），假阴影是独立半透明贴片（SPEC
 *    §5.4）；InstancedMesh 关闭视锥剔除（包围球不随实例动态变化）；
 * 4. key 携带批次数：批次数变化时全部批次走卸载/挂载路径——R3F 对已挂载
 *    primitive 换 object 依赖「兄弟序列尾部」探测，与条件子树组合时重建
 *    会被静默丢弃（TASK-005 实测），key 变化强制干净重建；
 * 5. 高频车辆事件不触碰本组件的任何 React 状态（扩批除外），实例矩阵与
 *    脏集合永远在 Hook 自有对象中（SPEC §4/§12.5）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import type { DiagnosticsReporter } from '@/shared/diagnostics'
import type { WorldTransform } from '@/shared/spatial'
import type { FleetRuntime } from '../model/createFleetRuntime'
import {
  createInstanceSlotTable,
  SLOT_BATCH_CAPACITY,
  SLOT_HARD_CAP,
} from '../model/instanceSlots'
import {
  INSTANCE_COLOR_PARTS,
  VEHICLE_PART_KINDS,
  type VehiclePartKind,
  type VehicleResources,
} from '../scene/createVehicleGeometry'
import {
  useFleetFrameSync,
  type FleetBatchMeshes,
} from '../hooks/useFleetFrameSync'

export interface VehicleInstancesProps {
  /** 高频车队运行时（来自 FleetRuntimeProvider 的稳定引用） */
  runtime: FleetRuntime
  /** 地图世界变换；null 时不提交任何车辆矩阵（等待地图就绪） */
  worldTransform: WorldTransform | null
  /** 共用几何与材质（Feature 根组件单一所有者） */
  resources: VehicleResources
  /** 渲染硬上限；默认 512（SPEC §4），测试可注入小容量 */
  hardCap?: number
  /** 硬上限溢出诊断通道（未渲染数上抛） */
  diagnostics?: DiagnosticsReporter
}

export function VehicleInstances({
  runtime,
  worldTransform,
  resources,
  hardCap = SLOT_HARD_CAP,
  diagnostics,
}: VehicleInstancesProps) {
  // 槽位表与批次数：槽位表跨渲染恒定；批次数是唯一会进入 state 的结构值
  const tableRef = useRef<ReturnType<typeof createInstanceSlotTable> | null>(null)
  if (tableRef.current === null) {
    tableRef.current = createInstanceSlotTable({ hardCap })
  }
  const table = tableRef.current

  const [batchCount, setBatchCount] = useState(1)

  // 批次网格按 batchCount 构建：容量、零缩放初始化、命名与拾取元数据一次完成
  const batches = useMemo(
    () => createBatches(resources, batchCount),
    [resources, batchCount],
  )
  useEffect(() => () => disposeBatches(batches), [batches])

  useFleetFrameSync({
    runtime,
    table,
    worldTransform,
    batches,
    onBatchCountChanged: setBatchCount,
    diagnostics,
  })

  return (
    <group name="fleet-vehicles">
      {/* key 含 batchCount：批次数变化时强制全部批次卸载/挂载（不变量 4） */}
      {batches.map((batch, index) => (
        <group key={`fleet-batch-${index}-${batchCount}`} name={`fleet-batch-${index}`}>
          {VEHICLE_PART_KINDS.map((kind) => (
            <primitive
              key={kind}
              object={batch.parts[kind]}
              dispose={null}
            />
          ))}
        </group>
      ))}
    </group>
  )
}

/** 批次容量即槽位表默认批次容量（256）；矩阵数量 = 容量 × 16 浮点 */
function createBatches(resources: VehicleResources, batchCount: number): FleetBatchMeshes[] {
  const batches: FleetBatchMeshes[] = []
  for (let b = 0; b < batchCount; b += 1) {
    const parts = {} as Record<VehiclePartKind, THREE.InstancedMesh>
    for (const kind of VEHICLE_PART_KINDS) {
      const mesh = createPartMesh(resources, kind, b)
      parts[kind] = mesh
    }
    batches.push({ parts })
  }
  return batches
}

/** 创建单个部件 InstancedMesh：零缩放初始化、动态用法、拾取与阴影语义 */
function createPartMesh(
  resources: VehicleResources,
  kind: VehiclePartKind,
  batchIndex: number,
): THREE.InstancedMesh {
  const geometry =
    kind === 'chassis' || kind === 'shell' || kind === 'platform' || kind === 'pallet'
      ? resources.box
      : kind === 'wedge'
        ? resources.wedge
        : kind === 'beacon'
          ? resources.beacon
          : resources.shadow
  const material =
    kind === 'chassis'
      ? resources.chassisMaterial
      : kind === 'shell'
        ? resources.shellMaterial
        : kind === 'wedge'
          ? resources.wedgeMaterial
          : kind === 'platform'
            ? resources.platformMaterial
            : kind === 'pallet'
              ? resources.palletMaterial
              : kind === 'beacon'
                ? resources.beaconMaterial
                : resources.shadowMaterial

  const capacity = SLOT_BATCH_CAPACITY
  const mesh = new THREE.InstancedMesh(geometry, material, capacity)
  mesh.name = `fleet-${kind}-b${batchIndex}`
  mesh.count = capacity
  mesh.matrixAutoUpdate = false
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.frustumCulled = false

  // 实例矩阵零缩放初始化：空槽位绝不以单位阵出现在原点（不变量 2）
  const matrices = mesh.instanceMatrix.array as unknown as number[]
  for (let s = 0; s < capacity; s += 1) {
    const base = s * 16
    for (let i = 0; i < 15; i += 1) {
      matrices[base + i] = 0
    }
    matrices[base + 15] = 1
  }
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

  // 实例颜色缓冲：外壳/楔/信标逐车差异色；默认白色由材质/写入路径覆盖
  if (INSTANCE_COLOR_PARTS.has(kind)) {
    const colors = new Float32Array(capacity * 3).fill(1)
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3)
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
  }

  // 拾取语义：仅外壳可拾取并携带批次号；其余部件关闭 raycast（SPEC §6.3）
  if (kind === 'shell') {
    mesh.userData.batchId = batchIndex
  } else {
    mesh.raycast = () => {}
  }
  return mesh
}

/** 释放批次实例缓冲（几何/材质归 resources 所有者，这里只释放 mesh 自身） */
function disposeBatches(batches: readonly FleetBatchMeshes[]): void {
  for (const batch of batches) {
    for (const kind of VEHICLE_PART_KINDS) {
      batch.parts[kind].dispose()
    }
  }
}
