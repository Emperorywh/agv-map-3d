/**
 * 车辆光环批次图层（SPEC §5.1、§7.3、§12.5；TASK-012）。
 *
 * 职责：把选中/L1/L2 分层光环以「批次 × 1 个 InstancedMesh」挂载到场景——
 *       每批次一个环实例网格（容量 = 车辆槽位 × 3 层），逐帧提交交给
 *       useFleetRingFrameSync。批次结构由 FleetMonitoringFeature 持有的
 *       batchCount 决定，与车体/标签图层共用同一实例槽位表。
 * 边界：本组件只拥有光环批次的实例缓冲；单位环几何与材质归 RingResources
 *       所有者（FleetMonitoringFeature），本组件绝不释放它们；槽位表归
 *       Feature 根组件。光环不参与拾取（拾取仅车体外壳，SPEC §5.2）。
 * 关键不变量：
 * 1. 每批次恒为 1 个 InstancedMesh = 1 个光环 Draw Call：200 台（单批次）
 *    车辆相关 Draw Call = 7（车体）+ 2（标签）+ 1（光环）= 12，满足 SPEC
 *    §6.3 预算；实例矩阵全部零缩放初始化，空槽位绝不以单位阵出现在原点；
 * 2. 渲染顺序 renderOrder=3、透明不写深度：贴地层（交通锁 2）之上、标签层
 *    （10/11）之下，多层透明对象按序合成互不遮挡；
 * 3. key 携带批次数：批次数变化时全部批次走卸载/挂载路径——R3F 对已挂载
 *    primitive 换 object 的重建依赖「兄弟序列尾部」探测，条件子树下会被
 *    静默丢弃（TASK-005 实测结论），key 变化强制干净重建；
 * 4. 高频车辆事件不触碰本组件任何 React 状态，实例矩阵/颜色永远在帧同步
 *    Hook 自有对象中（SPEC §4/§12.5）。
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { WorldTransform } from '@/shared/spatial'
import type { FleetRuntime } from '../model/createFleetRuntime'
import type { InstanceSlotTable } from '../model/instanceSlots'
import type { RingResources } from '../scene/vehicleRings'
import {
  useFleetRingFrameSync,
  RING_BATCH_CAPACITY,
  type FleetRingBatchMeshes,
} from '../hooks/useFleetRingFrameSync'

export interface VehicleRingsProps {
  /** 高频车队运行时（来自 FleetRuntimeProvider 的稳定引用） */
  runtime: FleetRuntime
  /** 地图世界变换；null 时不提交任何光环（等待地图就绪） */
  worldTransform: WorldTransform | null
  /** 与车体/标签共享的实例槽位表（环槽位 = 车辆槽位 × 3 + 层序） */
  table: InstanceSlotTable
  /** 当前批次数（与车体/标签图层一致；由 Feature 根组件持有） */
  batchCount: number
  /** 共享几何与材质（Feature 根组件单一所有者） */
  resources: RingResources
}

export function VehicleRings({
  runtime,
  worldTransform,
  table,
  batchCount,
  resources,
}: VehicleRingsProps) {
  // 光环批次按 batchCount 构建：容量、零缩放初始化、命名与拾取关闭一次完成
  const batches = useMemo(
    () => createRingBatches(resources, batchCount),
    [resources, batchCount],
  )
  useEffect(() => () => disposeBatches(batches), [batches])

  useFleetRingFrameSync({ runtime, table, worldTransform, batches })

  return (
    <group name="fleet-rings">
      {/* key 含 batchCount：批次数变化时强制全部批次卸载/挂载（不变量 3） */}
      {batches.map((batch, index) => (
        <primitive
          key={`fleet-ring-batch-${index}-${batchCount}`}
          object={batch.rings}
          dispose={null}
        />
      ))}
    </group>
  )
}

/** 创建单个光环批次网格：容量 = 车辆槽位 × 3 层，实例颜色缓冲随批创建 */
function createRingBatches(
  resources: RingResources,
  batchCount: number,
): FleetRingBatchMeshes[] {
  const batches: FleetRingBatchMeshes[] = []
  for (let b = 0; b < batchCount; b += 1) {
    const mesh = new THREE.InstancedMesh(resources.ring, resources.material, RING_BATCH_CAPACITY)
    mesh.name = `fleet-rings-b${b}`
    mesh.count = 0 // 初始无任何活跃环：GPU 跳过整批提交，首帧同步后按需抬起
    mesh.matrixAutoUpdate = false
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.frustumCulled = false
    mesh.renderOrder = 3
    mesh.raycast = () => {} // 光环不参与拾取（拾取仅车体外壳，SPEC §5.2）

    // 实例矩阵零缩放初始化：空槽位绝不以单位阵出现在原点（不变量 1）
    const matrices = mesh.instanceMatrix.array as unknown as number[]
    for (let s = 0; s < RING_BATCH_CAPACITY; s += 1) {
      const base = s * 16
      for (let i = 0; i < 15; i += 1) {
        matrices[base + i] = 0
      }
      matrices[base + 15] = 1
    }
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

    // 实例颜色缓冲：三层固定层色，激活时写入
    const colors = new Float32Array(RING_BATCH_CAPACITY * 3)
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3)
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)

    batches.push({ rings: mesh })
  }
  return batches
}

/** 释放批次实例缓冲（几何/材质归 resources 所有者，这里只释放 mesh 自身） */
function disposeBatches(batches: readonly FleetRingBatchMeshes[]): void {
  for (const batch of batches) {
    batch.rings.dispose()
  }
}
