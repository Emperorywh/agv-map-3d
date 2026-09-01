/**
 * 光环帧同步（SPEC §5.1、§7.3、§11.6、§11.8、§12.5；TASK-012）。
 *
 * 职责：作为选中/L1/L2 分层光环实例缓冲的唯一帧消费者——每帧对运行时实体
 *       做一次全量扫描（≤512 台），以「快照引用 + 层激活布尔 + 位姿缓存」为
 *       差量依据只写变化实例：层激活 → 矩阵（位置 + 每车缩放）与实例颜色；
 *       条件恢复 → 同帧零缩放清场（下一帧移除语义）；删除 → 清理缓存与实例。
 *       选中层依据低频 store 的 selectedKey（getState 读取，不订阅）。
 * 边界：绝不消费运行时 pose/display/removed 脏集合——那是车体帧同步
 *       （useFleetFrameSync）的独占输入；光环层判定复用 ringLayersOf（与
 *       SPEC §7.3 告警表同口径，L1/L2 可同时存在）。全部缓存、脏标记与草稿
 *       对象为 Hook 自有普通对象，绝不进入 React state/zustand（SPEC §4）。
 * 关键不变量：
 * 1. 从内到外可同时存在：层序 0/1/2 = 选中/L1/L2，实例槽 = 车辆槽位×3+层，
 *    半径随层单调递增（RING_LAYER_RADII_M）；
 * 2. 条件恢复下一帧移除：层布尔翻假即在当帧写零缩放矩阵——不存在迟滞或
 *    残留环（SPEC §7.3「条件恢复后移除对应告警环」）；
 * 3. 非法坐标车辆不放置任何环：visible=false（位置/尺寸非法）时三层全零，
 *    与车体同口径（SPEC §7.3、§11.8）；
 * 4. 删除清理先于内容扫描：先建 seen 集合再清理消失实体，槽位被同帧转派时
 *    以 table.resolve 防护跳过矩阵清零（新车主全量写入覆盖）；
 * 5. 网格 count 收缩到「最大活跃实例 + 1」：无任何环的批次 count=0，GPU
 *    跳过整批提交；同一帧多次写合并为一次 needsUpdate。
 */
import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { WorldTransform } from '@/shared/spatial'
import type { FleetRuntime } from '../model/createFleetRuntime'
import type { InstanceSlotTable } from '../model/instanceSlots'
import { SLOT_BATCH_CAPACITY } from '../model/instanceSlots'
import { useFleetMonitoringStore } from '../model/fleetMonitoringStore'
import {
  RING_LAYER_COUNT,
  RING_LAYER_COLORS,
  ringLayersOf,
} from '../scene/vehicleRings'
import {
  RING_LAYER_RADII_M,
  RING_SIZE_REFERENCE_M,
  RING_Y_M,
} from '../scene/fleetAppearance'
import { computeVehicleWorldPose } from '../scene/createVehicleGeometry'

/** 一个光环批次的可写网格集合：单个 InstancedMesh（每批 1 个 Draw Call） */
export interface FleetRingBatchMeshes {
  readonly rings: THREE.InstancedMesh
}

export interface UseFleetRingFrameSyncOptions {
  /** 高频车队运行时（只读扫描，不消费脏集合） */
  runtime: FleetRuntime
  /** 与车体/标签共享的实例槽位表（环槽位 = 车辆槽位 × 3 + 层序） */
  table: InstanceSlotTable
  /** 地图世界变换；null 时不做任何提交（等待地图就绪） */
  worldTransform: WorldTransform | null
  /** 当前已挂载光环批次（数组身份变化触发全量重写） */
  batches: readonly FleetRingBatchMeshes[]
}

/** 每批次实例容量：车辆槽位 × 每车层数 */
export const RING_BATCH_CAPACITY = SLOT_BATCH_CAPACITY * RING_LAYER_COUNT

/** 单实体的光环渲染缓存（Hook 自有普通对象，绝不进入 React） */
interface RingEntityCache {
  readonly key: string
  batch: number
  slot: number
  /** 内容差量依据：快照对象引用（不可变替换语义） */
  snapshot: unknown
  /** 三层激活态（0 选中 / 1 L1 / 2 L2） */
  active: boolean[]
  /** 最近写入矩阵的位姿与缩放（变化才重写） */
  writtenX: number
  writtenZ: number
  writtenScale: number
}

interface RingFrameController {
  caches: Map<string, RingEntityCache>
  seen: Set<string>
  /** [批次] 矩阵脏标记 */
  matrixDirty: boolean[]
  /** [批次] 实例颜色脏标记 */
  colorDirty: boolean[]
  /** [批次] 本帧最大活跃扁平实例序（count 收缩依据） */
  maxUsedIndex: number[]
  /** 上一次全量重写对应的批次数组身份 */
  lastBatchesIdentity: readonly FleetRingBatchMeshes[] | null
}

/** 帧循环复用的草稿对象：模块级常量，杜绝每帧分配 */
const scratchMatrix = new THREE.Matrix4()
const scratchPosition = new THREE.Vector3()
const scratchScale = new THREE.Vector3()
const scratchColor = new THREE.Color()
const IDENTITY_QUATERNION = new THREE.Quaternion()

function createRingFrameController(): RingFrameController {
  return {
    caches: new Map(),
    seen: new Set<string>(),
    matrixDirty: [],
    colorDirty: [],
    maxUsedIndex: [],
    lastBatchesIdentity: null,
  }
}

export function useFleetRingFrameSync({
  runtime,
  table,
  worldTransform,
  batches,
}: UseFleetRingFrameSyncOptions): void {
  // options 经 ref 透传：useFrame 闭包恒定，数组身份变化不重建帧回调
  const optionsRef = useRef({ runtime, table, worldTransform, batches })
  optionsRef.current = { runtime, table, worldTransform, batches }

  const controllerRef = useRef<RingFrameController | null>(null)
  if (controllerRef.current === null) {
    controllerRef.current = createRingFrameController()
  }

  // 卸载：重置结构跟踪并清空缓存；重挂载（StrictMode）后首帧全量重写
  useEffect(
    () => () => {
      const controller = controllerRef.current
      if (controller !== null) {
        controller.lastBatchesIdentity = null
        controller.caches.clear()
      }
    },
    [],
  )

  useFrame(() => {
    const controller = controllerRef.current
    if (controller !== null) {
      tickRingFrame(controller, optionsRef.current)
    }
  })
}

/** 单帧光环提交（useFrame 回调本体） */
function tickRingFrame(
  controller: RingFrameController,
  options: {
    runtime: FleetRuntime
    table: InstanceSlotTable
    worldTransform: WorldTransform | null
    batches: readonly FleetRingBatchMeshes[]
  },
): void {
  const { runtime, table, worldTransform, batches } = options
  if (worldTransform === null || batches.length === 0) {
    return
  }
  ensureCapacity(controller, batches.length)

  // 批次数组身份变化（首帧/扩批挂载/StrictMode 重挂载）→ 清缓存全量重写
  if (controller.lastBatchesIdentity !== batches) {
    controller.lastBatchesIdentity = batches
    controller.caches.clear()
  }

  const selectedKey = useFleetMonitoringStore.getState().selectedKey
  const entities = runtime.entities()

  // —— 删除清理（先于内容扫描）：消失实体三层全部清零 ——
  controller.seen.clear()
  for (const entity of entities) {
    controller.seen.add(entity.key)
  }
  for (const [key, cache] of controller.caches) {
    if (controller.seen.has(key)) {
      continue
    }
    if (cache.batch < batches.length) {
      // 槽位同帧被转派时矩阵由新车主全量写入，此处跳过（resolve 防护）
      if (table.resolve(cache.batch, cache.slot) === undefined) {
        for (let layer = 0; layer < RING_LAYER_COUNT; layer += 1) {
          writeRingMatrix(controller, batches, cache.batch, cache.slot, layer, false, 0, 0, 1)
        }
      }
    }
    controller.caches.delete(key)
  }

  // —— 内容扫描：层激活差量 + 位姿差量 ——
  for (const entity of entities) {
    const slot = table.get(entity.key)
    if (slot === undefined || slot.batch >= batches.length) {
      continue
    }
    let cache = controller.caches.get(entity.key)
    if (cache === undefined) {
      cache = {
        key: entity.key,
        batch: slot.batch,
        slot: slot.slot,
        snapshot: null,
        active: [false, false, false],
        writtenX: Number.NaN,
        writtenZ: Number.NaN,
        writtenScale: Number.NaN,
      }
      controller.caches.set(entity.key, cache)
    }
    cache.batch = slot.batch
    cache.slot = slot.slot

    // 非法位置/尺寸：不放置车体也不放置任何环（SPEC §7.3）
    if (!(entity.snapshot.positionValid && entity.snapshot.dimensionValid)) {
      applyLayerStates(controller, batches, cache, [false, false, false], 0, 0, 1)
      continue
    }

    const { l1, l2 } = ringLayersOf(entity.displayState.primary, entity.staticState.alerts)
    const active = [entity.key === selectedKey, l1, l2]

    // 位姿：快照引用变化时重算（位置差量以写入值比对兜底）
    let poseX = cache.writtenX
    let poseZ = cache.writtenZ
    let scale = cache.writtenScale
    if (cache.snapshot !== entity.snapshot) {
      const pose = computeVehicleWorldPose(entity.snapshot, worldTransform)
      poseX = pose.cx
      poseZ = pose.cz
      scale =
        Math.max(entity.snapshot.dimension.length, entity.snapshot.dimension.width) /
        RING_SIZE_REFERENCE_M
      cache.snapshot = entity.snapshot
    }
    applyLayerStates(controller, batches, cache, active, poseX, poseZ, scale)
  }

  // —— 批次级合并提交：矩阵/颜色 needsUpdate 与 count 收缩 ——
  // count 以「缓存中的真实激活态」重算（而非本帧写入）：矩阵是持久状态，
  // 活跃但本帧未写矩阵的实例必须继续被绘制。
  for (let b = 0; b < batches.length; b += 1) {
    controller.maxUsedIndex[b] = -1
  }
  for (const cache of controller.caches.values()) {
    if (cache.batch >= batches.length) {
      continue
    }
    for (let layer = RING_LAYER_COUNT - 1; layer >= 0; layer -= 1) {
      if (cache.active[layer]) {
        const instance = cache.slot * RING_LAYER_COUNT + layer
        if (instance > controller.maxUsedIndex[cache.batch]) {
          controller.maxUsedIndex[cache.batch] = instance
        }
        break
      }
    }
  }
  for (let b = 0; b < batches.length; b += 1) {
    const mesh = batches[b].rings
    if (controller.matrixDirty[b]) {
      controller.matrixDirty[b] = false
      mesh.instanceMatrix.needsUpdate = true
    }
    if (controller.colorDirty[b]) {
      controller.colorDirty[b] = false
      if (mesh.instanceColor !== null) {
        mesh.instanceColor.needsUpdate = true
      }
    }
    const nextCount = controller.maxUsedIndex[b] + 1
    if (mesh.count !== nextCount) {
      mesh.count = nextCount
    }
  }
}

/** 把一层的三元组激活态写为实例矩阵/颜色（仅变化实例落笔） */
function applyLayerStates(
  controller: RingFrameController,
  batches: readonly FleetRingBatchMeshes[],
  cache: RingEntityCache,
  active: readonly boolean[],
  x: number,
  z: number,
  scale: number,
): void {
  for (let layer = 0; layer < RING_LAYER_COUNT; layer += 1) {
    const wasActive = cache.active[layer]
    const nowActive = active[layer]
    if (nowActive !== wasActive) {
      cache.active[layer] = nowActive
      if (nowActive) {
        // 激活即写层颜色（层序恒定色，激活期间不重复写）
        writeRingColor(controller, batches, cache.batch, cache.slot, layer)
      }
    }
    if (nowActive || wasActive) {
      const poseChanged = cache.writtenX !== x || cache.writtenZ !== z || cache.writtenScale !== scale
      if (nowActive && (!wasActive || poseChanged)) {
        writeRingMatrix(controller, batches, cache.batch, cache.slot, layer, true, x, z, scale)
      } else if (!nowActive) {
        writeRingMatrix(controller, batches, cache.batch, cache.slot, layer, false, 0, 0, 1)
      }
    }
  }
  cache.writtenX = x
  cache.writtenZ = z
  cache.writtenScale = scale
}

/** 写单个环实例矩阵：位置贴 RING_Y、x/z 等比缩放（层半径由缩放表达） */
function writeRingMatrix(
  controller: RingFrameController,
  batches: readonly FleetRingBatchMeshes[],
  batch: number,
  slot: number,
  layer: number,
  shown: boolean,
  x: number,
  z: number,
  scale: number,
): void {
  const mesh = batches[batch].rings
  const instance = slot * RING_LAYER_COUNT + layer
  if (shown) {
    // 层半径 = 基准半径 × 每车缩放；单位环外半径 1，故缩放值即层半径
    const radius = RING_LAYER_RADII_M[layer] * scale
    scratchPosition.set(x, RING_Y_M, z)
    scratchScale.set(radius, 1, radius)
    scratchMatrix.compose(scratchPosition, IDENTITY_QUATERNION, scratchScale)
  } else {
    const array = scratchMatrix.elements
    for (let i = 0; i < 15; i += 1) {
      array[i] = 0
    }
    array[15] = 1
  }
  ;(mesh.instanceMatrix.array as Float32Array).set(scratchMatrix.elements, instance * 16)
  controller.matrixDirty[batch] = true
}

/** 写单个环实例颜色（层色，线性空间） */
function writeRingColor(
  controller: RingFrameController,
  batches: readonly FleetRingBatchMeshes[],
  batch: number,
  slot: number,
  layer: number,
): void {
  const mesh = batches[batch].rings
  const instanceColor = mesh.instanceColor
  if (instanceColor === null) {
    return
  }
  scratchColor.set(RING_LAYER_COLORS[layer])
  const base = (slot * RING_LAYER_COUNT + layer) * 3
  const array = instanceColor.array as Float32Array
  array[base] = scratchColor.r
  array[base + 1] = scratchColor.g
  array[base + 2] = scratchColor.b
  controller.colorDirty[batch] = true
}

/** 按批次数量扩展脏标记数组（新批次默认无脏） */
function ensureCapacity(controller: RingFrameController, batchCount: number): void {
  while (controller.matrixDirty.length < batchCount) {
    controller.matrixDirty.push(false)
    controller.colorDirty.push(false)
    controller.maxUsedIndex.push(-1)
  }
}
