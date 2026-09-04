/**
 * 车辆按材质和部件批量实例渲染，精修资产与程序回退共用原来的车辆槽位表。
 * 模型资源归上层所有，各批次只释放实例缓冲；资源替换强制重新挂载并全量回填。
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { DiagnosticsReporter } from '@/shared/diagnostics'
import type { WorldTransform } from '@/shared/spatial'
import type { FleetRuntime } from '../model/createFleetRuntime'
import type { InstanceSlotTable } from '../model/instanceSlots'
import { SLOT_BATCH_CAPACITY } from '../model/instanceSlots'
import { INSTANCE_COLOR_PARTS, PICKABLE_PARTS, VEHICLE_PART_KINDS, type VehiclePartKind, type VehicleResources } from '../scene/createVehicleGeometry'
import { useFleetFrameSync, type FleetBatchMeshes } from '../hooks/useFleetFrameSync'

export interface VehicleInstancesProps {
  runtime: FleetRuntime
  worldTransform: WorldTransform | null
  resources: VehicleResources
  table: InstanceSlotTable
  batchCount: number
  onBatchCountChanged?: (batchCount: number) => void
  diagnostics?: DiagnosticsReporter
}

export function VehicleInstances({ runtime, worldTransform, resources, table, batchCount, onBatchCountChanged, diagnostics }: VehicleInstancesProps) {
  const batches = useMemo(() => createBatches(resources, batchCount), [resources, batchCount])
  useEffect(() => () => {
    for (const batch of batches) for (const mesh of Object.values(batch.parts)) mesh.dispose()
  }, [batches])
  useFleetFrameSync({ runtime, table, worldTransform, batches, onBatchCountChanged, diagnostics })
  return <group name="fleet-vehicles">
    {batches.map((batch, index) => <group key={batch.parts.shell.uuid} name={`fleet-batch-${index}`}>
      {VEHICLE_PART_KINDS.map((kind) => <primitive key={kind} object={batch.parts[kind]} dispose={null} />)}
    </group>)}
  </group>
}

/**
 * 所有矩阵以零缩放初始化，空槽位绝不出现在原点；动态颜色缓冲只分配给灯光部件。
 * 拾取部件携带相同批次号，加载模型或点击载货纸箱仍映射到同一车辆实体。
 */
function createBatches(resources: VehicleResources, count: number): FleetBatchMeshes[] {
  return Array.from({ length: count }, (_, batchId) => {
    const parts = {} as Record<VehiclePartKind, THREE.InstancedMesh>
    for (const kind of VEHICLE_PART_KINDS) {
      const resource = resources.parts[kind]
      const mesh = new THREE.InstancedMesh(resource.geometry, resource.material, SLOT_BATCH_CAPACITY)
      mesh.name = `fleet-${kind}-b${batchId}`
      mesh.matrixAutoUpdate = false
      mesh.frustumCulled = false
      mesh.castShadow = !INSTANCE_COLOR_PARTS.has(kind) && kind !== 'shadow'
      /**
       * 投光贴片在道路透明层之后绘制，不投射或接收实时阴影，也不参与拾取。
       * 保留材质深度测试，让车身、货物与实体设施正常遮挡光斑。
       */
      mesh.receiveShadow = kind !== 'shadow' && kind !== 'statusGround'
      if (kind === 'statusGround') mesh.renderOrder = 8
      mesh.instanceMatrix.array.fill(0)
      for (let i = 0; i < SLOT_BATCH_CAPACITY; i += 1) mesh.instanceMatrix.array[i * 16 + 15] = 1
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      if (INSTANCE_COLOR_PARTS.has(kind)) {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SLOT_BATCH_CAPACITY * 3).fill(1), 3)
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
      }
      if (PICKABLE_PARTS.has(kind)) mesh.userData.batchId = batchId
      else mesh.raycast = () => {}
      parts[kind] = mesh
    }
    return { parts, modelReady: resources.modelReady }
  })
}
