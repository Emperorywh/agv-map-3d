/**
 * 车队脏槽位的唯一帧消费者，继续使用原有槽位分配、删除清场和批次扩容机制。
 * 模型资源就绪后全程展示精修模型，不再按相机距离分档；资源换代触发全量回填。
 * 载货部件始终遵守有效性和载荷状态，颜色同步写入局部状态灯与地面投光。
 */
import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { DiagnosticsReporter } from '@/shared/diagnostics'
import type { WorldTransform } from '@/shared/spatial'
import type { FleetRuntime } from '../model/createFleetRuntime'
import type { InstanceSlotTable } from '../model/instanceSlots'
import type { VehiclePrimaryDisplayState } from '../model/types'
import { STATUS_LIGHT_STYLES, statusLightBrightness } from '../scene/vehicleStatusLights'
import {
  shellColorOf,
  BEACON_BLINK_HZ,
  BEACON_BLINK_MIN_BRIGHTNESS,
  BEACON_FAULT_COLOR,
} from '../scene/fleetAppearance'
import {
  computeVehiclePartLayout,
  computeVehicleWorldPose,
  VEHICLE_PART_KINDS,
  type PartPlacement,
  type VehiclePartKind,
  vehiclePartVisible,
  PICKABLE_PARTS,
  LOAD_PARTS,
} from '../scene/createVehicleGeometry'

/** 一个批次的可写网格集合：七个部件 InstancedMesh（批次序号即数组序号） */
export interface FleetBatchMeshes {
  readonly parts: Record<VehiclePartKind, THREE.InstancedMesh>
  /**
   * 模型加载后才启用精修部件，切换批次身份会触发既有全量回填机制。
   * 未加载和恢复过程中使用程序模型，槽位与车辆映射保持一致。
   */
  readonly modelReady: boolean
}

export interface UseFleetFrameSyncOptions {
  /** 高频车队运行时（脏集合唯一消费者） */
  runtime: FleetRuntime
  /** 实例槽位表（批次序号与 batches 数组序号一一对应） */
  table: InstanceSlotTable
  /** 地图世界变换（车辆放置唯一坐标口径）；null 时跳过提交等待就绪 */
  worldTransform: WorldTransform | null
  /** 当前已挂载批次（数组身份变化即结构变化，触发全量重写） */
  batches: readonly FleetBatchMeshes[]
  /** 批次数量变化上抛（渲染层挂载新批次；缺省不通知） */
  onBatchCountChanged?: (batchCount: number) => void
  /** 硬上限溢出诊断（未渲染数从 0 变正时采样告警一次） */
  diagnostics?: DiagnosticsReporter
}

/** 诊断码：车队规模超过渲染硬上限（SPEC §11.13：只记录，不显示页面提示） */
const CAPACITY_EXCEEDED_CODE = 'FLEET_RENDER_CAPACITY_EXCEEDED'

/** 帧循环复用的草稿对象：模块级常量，杜绝每帧分配（与 React 无关） */
const scratchMatrix = new THREE.Matrix4()
const scratchQuaternion = new THREE.Quaternion()
const scratchPosition = new THREE.Vector3()
const scratchScale = new THREE.Vector3()
const scratchColor = new THREE.Color()
const UP_AXIS = new THREE.Vector3(0, 1, 0)

/** PART 数量常量（脏标记数组宽度） */
const PART_COUNT = VEHICLE_PART_KINDS.length

/** 帧同步控制器的自有可变状态（普通对象，绝不进入 React） */
interface FrameSyncController {
  /** 累积时间（秒）：信标旋转/闪烁时钟；真实循环与测试 advanceFrames 通用 */
  elapsed: number
  /** 上一次全量重写对应的批次数组身份；null 表示尚未收敛 */
  lastBatchesIdentity: readonly FleetBatchMeshes[] | null
  /** 已上抛过的批次数（初始 1 = 渲染层初始批次数，首个批次无需通知） */
  notifiedBatchCount: number
  /** [批次][部件] 矩阵脏标记 */
  matrixDirty: boolean[][]
  /** [批次][部件] 颜色脏标记 */
  colorDirty: boolean[][]
  /** FAULT 激活信标实体键集合（display 差维护，动画消费） */
  beaconKeys: Set<string>
  /**
   * 只维护需要呼吸动画的车辆，常亮车辆继续仅在显示差变化时更新。
   * 与信标集合一同在删除和全量重建时清理，防止槽位复用串色。
   */
  pulsingLightKeys: Set<string>
  /** 硬上限溢出告警置位标记：未渲染数回 0 后复位，允许再次告警 */
  overflowReported: boolean
  /** 待全量重写标记（批次挂载/重挂载后置位） */
  pendingFullRewrite: boolean
}

export function useFleetFrameSync({
  runtime,
  table,
  worldTransform,
  batches,
  onBatchCountChanged,
  diagnostics,
}: UseFleetFrameSyncOptions): void {
  // 全部可变状态收拢在 ref 持有的控制器：useFrame 闭包恒定，options 经
  // ref 透传（数组身份/回调变化不重建帧回调，也无逐帧 React 开销）
  const optionsRef = useRef({ runtime, table, worldTransform, batches, onBatchCountChanged })
  optionsRef.current = { runtime, table, worldTransform, batches, onBatchCountChanged }

  const diagnosticsRef = useRef<DiagnosticsReporter | undefined>(diagnostics)
  diagnosticsRef.current = diagnostics

  const controllerRef = useRef<FrameSyncController | null>(null)
  if (controllerRef.current === null) {
    controllerRef.current = {
      elapsed: 0,
      lastBatchesIdentity: null,
      notifiedBatchCount: 1,
      matrixDirty: [],
      colorDirty: [],
      beaconKeys: new Set<string>(),
      pulsingLightKeys: new Set<string>(),
      overflowReported: false,
      // 首帧即全量重写：不依赖身份 effect 先于首个 useFrame 执行
      pendingFullRewrite: true,
    }
  }

  // 批次数组身份变化（挂载/扩批重建）→ 下一帧先全量重写再消费增量差异
  useEffect(() => {
    const controller = controllerRef.current
    if (controller === null || batches.length === 0) {
      return
    }
    if (controller.lastBatchesIdentity !== batches) {
      controller.lastBatchesIdentity = batches
      controller.pendingFullRewrite = true
    }
  }, [batches])

  // 卸载：重置结构跟踪；重挂载（StrictMode setup→cleanup→setup）后首帧
  // 重新全量重写，不依赖上一挂载周期遗留的脏标记或槽位内容
  useEffect(
    () => () => {
      const controller = controllerRef.current
      if (controller !== null) {
        controller.lastBatchesIdentity = null
        controller.pendingFullRewrite = true
      }
    },
    [],
  )

  useFrame((_, delta) => {
    const controller = controllerRef.current
    if (controller === null) {
      return
    }
    controller.elapsed += delta
    tickFrame(controller, optionsRef.current, diagnosticsRef.current)
  })
}

/** 单帧提交：消费脏集合并按需写入实例缓冲（useFrame 回调本体） */
function tickFrame(
  controller: FrameSyncController,
  options: {
    runtime: FleetRuntime
    table: InstanceSlotTable
    worldTransform: WorldTransform | null
    batches: readonly FleetBatchMeshes[]
    onBatchCountChanged?: (batchCount: number) => void
  },
  diagnostics: DiagnosticsReporter | undefined,
): void {
  const { runtime, table, worldTransform, batches, onBatchCountChanged } = options
  if (worldTransform === null || batches.length === 0) {
    // 地图变换未就绪：不做任何提交（脏集合保留，就绪后首帧全量重写收敛）
    return
  }

  ensureDirtyCapacity(controller, batches.length)

  // 结构变化（首帧/扩批挂载/StrictMode 重挂载）：先收敛到运行时真相
  if (controller.pendingFullRewrite) {
    controller.pendingFullRewrite = false
    rewriteAll(controller, runtime, table, worldTransform, batches)
  }
  reportOverflow(controller, table, diagnostics)

  const dirty = runtime.consumeDirty()

  // —— 删除：释放槽位 + 零缩放清场；槽位转派时对补录实体立即全量写入 ——
  for (const key of dirty.removed) {
    controller.beaconKeys.delete(key)
    controller.pulsingLightKeys.delete(key)
    const result = table.release(key)
    if (result.admitted !== null) {
      writeVehicleFull(controller, runtime, table, worldTransform, batches, result.admitted)
      continue
    }
    if (result.freed !== null && result.freed.batch < batches.length) {
      zeroSlot(controller, batches, result.freed.batch, result.freed.slot)
    }
  }

  // —— 位姿差：整车矩阵重写（平台/托盘按 loadState 决定可见性） ——
  for (const key of dirty.pose) {
    writeVehiclePose(controller, runtime, table, worldTransform, batches, key)
  }

  // —— 显示差：实例颜色 + 平台/托盘可见性 + 信标集合维护 ——
  for (const key of dirty.display) {
    writeVehicleDisplay(controller, runtime, table, worldTransform, batches, key)
  }

  // —— FAULT 信标动画：仅激活集合内的槽位逐帧写旋转矩阵与脉动颜色 ——
  for (const key of controller.beaconKeys) {
    animateBeacon(controller, runtime, table, worldTransform, batches, key, controller.elapsed)
  }

  /**
   * 灯面与照地共用一个呼吸包络，只更新活跃车辆的颜色缓冲。
   * 不逐帧重建实例矩阵、材质或光源，常亮状态没有额外动画开销。
   */
  for (const key of controller.pulsingLightKeys) {
    const entity = runtime.get(key)
    const slot = table.get(key)
    if (entity === undefined || slot === undefined || slot.batch >= batches.length ||
      !entity.snapshot.positionValid || !entity.snapshot.dimensionValid) {
      controller.pulsingLightKeys.delete(key)
      continue
    }
    writeStatusLightColors(controller, batches, slot.batch, slot.slot, entity.displayState.primary)
  }

  // 批次扩容上抛（在脏处理之后检查：全量重写与位姿懒分配都可能扩批）；
  // 只响应扩容（批次数不缩），渲染层挂载新批次后由数组身份变化触发下一帧
  // 全量重写回填。初始值 1 与渲染层初始批次数一致：首个批次无需通知。
  if (table.batchCount > controller.notifiedBatchCount) {
    controller.notifiedBatchCount = table.batchCount
    onBatchCountChanged?.(table.batchCount)
  }

  // —— 批次级合并提交：本帧出现过脏写的 (批次, 部件) 才置 needsUpdate ——
  flushDirtyBatches(controller, batches)
}

/** 按批次数量扩展脏标记数组（新槽位默认无脏） */
function ensureDirtyCapacity(controller: FrameSyncController, batchCount: number): void {
  while (controller.matrixDirty.length < batchCount) {
    controller.matrixDirty.push(new Array<boolean>(PART_COUNT).fill(false))
    controller.colorDirty.push(new Array<boolean>(PART_COUNT).fill(false))
  }
}

/**
 * 全量重写：全部批次槽位先清零，再按「运行时当前全部实体」逐台写入。
 * 事实源必须是运行时实体表而非槽位表：重挂载（StrictMode/地图就绪）会换新
 * 槽位表，而旧挂载周期可能已消费掉脏集合——以实体表为源做懒分配写入，才能
 * 在任何路径下把场景收敛到运行时当前真相（不变量 4）。
 */
function rewriteAll(
  controller: FrameSyncController,
  runtime: FleetRuntime,
  table: InstanceSlotTable,
  worldTransform: WorldTransform,
  batches: readonly FleetBatchMeshes[],
): void {
  controller.beaconKeys.clear()
  controller.pulsingLightKeys.clear()
  for (let b = 0; b < batches.length; b += 1) {
    const capacity = batches[b].parts.chassis.instanceMatrix.array.length / 16
    for (let s = 0; s < capacity; s += 1) {
      zeroSlot(controller, batches, b, s)
    }
  }
  for (const entity of runtime.entities()) {
    writeVehicleFull(controller, runtime, table, worldTransform, batches, entity.key)
  }
}

/** 硬上限溢出诊断：未渲染数 0 → 正 采样告警一次，回落 0 后复位可再告警 */
function reportOverflow(
  controller: FrameSyncController,
  table: InstanceSlotTable,
  diagnostics: DiagnosticsReporter | undefined,
): void {
  const unrendered = table.unrenderedCount
  if (unrendered > 0 && !controller.overflowReported) {
    controller.overflowReported = true
    diagnostics?.report(
      CAPACITY_EXCEEDED_CODE,
      'warn',
      '车队规模超过渲染硬上限，超出部分保留快照但不渲染车体',
      { unrendered, rendered: table.renderedCount, batchCount: table.batchCount },
    )
  } else if (unrendered === 0) {
    controller.overflowReported = false
  }
}

/** 单台全量写入（位姿 + 显示；槽位懒分配，可能触发扩批） */
function writeVehicleFull(
  controller: FrameSyncController,
  runtime: FleetRuntime,
  table: InstanceSlotTable,
  worldTransform: WorldTransform,
  batches: readonly FleetBatchMeshes[],
  key: string,
): void {
  writeVehiclePose(controller, runtime, table, worldTransform, batches, key)
  writeVehicleDisplay(controller, runtime, table, worldTransform, batches, key)
}

/** 位姿写入：整车可见时写入除信标外的全部部件矩阵；不可见时整车零缩放 */
function writeVehiclePose(
  controller: FrameSyncController,
  runtime: FleetRuntime,
  table: InstanceSlotTable,
  worldTransform: WorldTransform,
  batches: readonly FleetBatchMeshes[],
  key: string,
): void {
  const entity = runtime.get(key)
  if (entity === undefined) {
    return
  }
  const layout = computeVehiclePartLayout(entity.snapshot, entity.displayState, batches[0]?.modelReady === true)
  let slot = table.get(key)
  if (!layout.visible) {
    // 非法坐标/尺寸：不放置车体也不占用新槽位；已持槽位整车清零
    if (slot !== undefined && slot.batch < batches.length) {
      zeroSlot(controller, batches, slot.batch, slot.slot)
    }
    return
  }
  if (slot === undefined) {
    slot = table.acquire(key) ?? undefined
    if (slot === undefined) {
      return // 硬上限满：保持未渲染（等待队列），快照仍在运行时
    }
  }
  if (slot.batch >= batches.length) {
    return // 新批次尚未挂载：等挂载后的全量重写回填
  }
  const pose = computeVehicleWorldPose(entity.snapshot, worldTransform)
  for (const kind of VEHICLE_PART_KINDS) {
    if (kind === 'beacon') {
      continue // 信标矩阵由显示路径（激活/熄灭）与动画路径负责
    }
    // 平台/托盘/纸箱仅在载货时真实放置；车轮/其余部件常显
    const partVisible = vehiclePartVisible(kind, layout)
    if (!partVisible) {
      zeroPartMatrix(controller, batches, slot.batch, slot.slot, kind)
      continue
    }
    writePlacementMatrix(
      controller,
      batches,
      slot.batch,
      slot.slot,
      kind,
      layout[kind],
      pose,
      0,
    )
  }
}

/**
 * 显示变化同步更新灯面、地面光斑与载货部件。
 * 呼吸与故障信标各自维护活跃集合，离线或过期立即退出旧动画。
 */
function writeVehicleDisplay(
  controller: FrameSyncController,
  runtime: FleetRuntime,
  table: InstanceSlotTable,
  worldTransform: WorldTransform,
  batches: readonly FleetBatchMeshes[],
  key: string,
): void {
  const entity = runtime.get(key)
  if (entity === undefined) {
    return
  }
  const layout = computeVehiclePartLayout(entity.snapshot, entity.displayState, batches[0]?.modelReady === true)
  const slot = table.get(key)
  if (slot === undefined || slot.batch >= batches.length) {
    // 无可见槽位（非法车或硬上限等待）：只需保证不留在信标激活集合
    controller.beaconKeys.delete(key)
    controller.pulsingLightKeys.delete(key)
    return
  }

  /**
   * 外壳和底盘保持物理材质，主状态同步写入两套灯带与地面光斑。
   * 状态变化立即覆盖旧颜色，退出呼吸时也恢复对应的常亮或低亮参数。
   */
  const primary = entity.displayState.primary
  writeStatusLightColors(controller, batches, slot.batch, slot.slot, primary)
  if (layout.visible && STATUS_LIGHT_STYLES[primary].pulseHz > 0) {
    controller.pulsingLightKeys.add(key)
  } else {
    controller.pulsingLightKeys.delete(key)
  }

  // 平台/托盘/纸箱可见性：loadState 属显示差，变化时重写三者矩阵
  const pose = computeVehicleWorldPose(entity.snapshot, worldTransform)
  for (const kind of LOAD_PARTS) {
    if (layout.visible && layout.loaded) {
      writePlacementMatrix(controller, batches, slot.batch, slot.slot, kind, layout[kind], pose, 0)
    } else {
      zeroPartMatrix(controller, batches, slot.batch, slot.slot, kind)
    }
  }

  // 信标：激活当且仅当投影主状态为 FAULT（FRESH + ONLINE 的故障车）；
  // 熄灭（含 OFFLINE/STALE）零缩放且移出激活集合（SPEC §5.2）
  if (layout.beaconActive) {
    controller.beaconKeys.add(key)
    animateBeacon(controller, runtime, table, worldTransform, batches, key, controller.elapsed)
  } else {
    controller.beaconKeys.delete(key)
    zeroPartMatrix(controller, batches, slot.batch, slot.slot, 'beacon')
  }
}

/**
 * 灯面和地面投光共享主状态颜色，用独立亮度系数控制近景灯面与周边可见范围。
 * 共用临时颜色对象，状态切换和动画都不会创建逐车材质或临时三维对象。
 */
function writeStatusLightColors(
  controller: FrameSyncController,
  batches: readonly FleetBatchMeshes[],
  batchIndex: number,
  slotIndex: number,
  primary: VehiclePrimaryDisplayState,
): void {
  const style = STATUS_LIGHT_STYLES[primary]
  const brightness = statusLightBrightness(primary, controller.elapsed)
  scratchColor.set(shellColorOf(primary))
  writePartColor(controller, batches, batchIndex, slotIndex, 'status', scratchColor, brightness * style.lamp)
  writePartColor(controller, batches, batchIndex, slotIndex, 'glbStatus', scratchColor, brightness * style.lamp)
  writePartColor(controller, batches, batchIndex, slotIndex, 'statusGround', scratchColor, brightness * style.ground)
}

/** FAULT 信标动画帧：rotation.y = rotY + t·自旋，亮度按正弦脉动 */
function animateBeacon(
  controller: FrameSyncController,
  runtime: FleetRuntime,
  table: InstanceSlotTable,
  worldTransform: WorldTransform,
  batches: readonly FleetBatchMeshes[],
  key: string,
  elapsed: number,
): void {
  const entity = runtime.get(key)
  const slot = table.get(key)
  if (entity === undefined || slot === undefined || slot.batch >= batches.length) {
    controller.beaconKeys.delete(key)
    return
  }
  const layout = computeVehiclePartLayout(entity.snapshot, entity.displayState, batches[0]?.modelReady === true)
  if (!layout.visible || !layout.beaconActive) {
    // 故障恢复或整车非法：移出激活集合并熄灭
    controller.beaconKeys.delete(key)
    zeroPartMatrix(controller, batches, slot.batch, slot.slot, 'beacon')
    return
  }
  const pose = computeVehicleWorldPose(entity.snapshot, worldTransform)
  writePlacementMatrix(
    controller,
    batches,
    slot.batch,
    slot.slot,
    'beacon',
    layout.beacon,
    pose,
    0,
  )
  // 亮度脉动：红基色 ×（下限～1 的正弦包络）；实例颜色调制，材质保持白色
  const blink =
    BEACON_BLINK_MIN_BRIGHTNESS +
    (1 - BEACON_BLINK_MIN_BRIGHTNESS) *
      (0.5 + 0.5 * Math.sin(elapsed * BEACON_BLINK_HZ * Math.PI * 2))
  scratchColor.set(BEACON_FAULT_COLOR).multiplyScalar(blink)
  writePartColor(controller, batches, slot.batch, slot.slot, 'beacon', scratchColor, 1)
}

/** 把一个部件放置写为实例矩阵（spin 为附加自旋，如信标旋转） */
function writePlacementMatrix(
  controller: FrameSyncController,
  batches: readonly FleetBatchMeshes[],
  batchIndex: number,
  slotIndex: number,
  kind: VehiclePartKind,
  placement: PartPlacement,
  pose: { cx: number; cz: number; rotY: number },
  spin: number,
): void {
  const rotated = rotateOffsetY(placement.x, placement.z, pose.rotY)
  scratchPosition.set(pose.cx + rotated.dx, placement.y, pose.cz + rotated.dz)
  scratchQuaternion.setFromAxisAngle(UP_AXIS, pose.rotY + spin)
  scratchScale.set(placement.sx, placement.sy, placement.sz)
  scratchMatrix.compose(scratchPosition, scratchQuaternion, scratchScale)
  const mesh = batches[batchIndex].parts[kind]
  scratchMatrix.toArray(mesh.instanceMatrix.array as unknown as number[], slotIndex * 16)
  controller.matrixDirty[batchIndex][VEHICLE_PART_KINDS.indexOf(kind)] = true
}

/** 零缩放矩阵：隐藏实例的唯一表达（不存在 instanceColor.a，SPEC §5.2） */
function zeroPartMatrix(
  controller: FrameSyncController,
  batches: readonly FleetBatchMeshes[],
  batchIndex: number,
  slotIndex: number,
  kind: VehiclePartKind,
): void {
  const array = batches[batchIndex].parts[kind].instanceMatrix.array as unknown as number[]
  const base = slotIndex * 16
  for (let i = 0; i < 15; i += 1) {
    array[base + i] = 0
  }
  array[base + 15] = 1
  controller.matrixDirty[batchIndex][VEHICLE_PART_KINDS.indexOf(kind)] = true
}

/** 整车清零：九个部件全部零缩放（删除/非法车的清场表达） */
function zeroSlot(
  controller: FrameSyncController,
  batches: readonly FleetBatchMeshes[],
  batchIndex: number,
  slotIndex: number,
): void {
  for (const kind of VEHICLE_PART_KINDS) {
    zeroPartMatrix(controller, batches, batchIndex, slotIndex, kind)
  }
}

/** 写实例颜色（brightness 为整体亮度系数）；置位对应颜色脏标记 */
function writePartColor(
  controller: FrameSyncController,
  batches: readonly FleetBatchMeshes[],
  batchIndex: number,
  slotIndex: number,
  kind: VehiclePartKind,
  color: THREE.Color,
  brightness: number,
): void {
  const instanceColor = batches[batchIndex].parts[kind].instanceColor
  if (instanceColor === null) {
    return
  }
  const array = instanceColor.array as unknown as number[]
  const base = slotIndex * 3
  array[base] = color.r * brightness
  array[base + 1] = color.g * brightness
  array[base + 2] = color.b * brightness
  controller.colorDirty[batchIndex][VEHICLE_PART_KINDS.indexOf(kind)] = true
}

/** 批次级合并提交：每 (批次, 部件) 每帧至多一次 needsUpdate */
function flushDirtyBatches(
  controller: FrameSyncController,
  batches: readonly FleetBatchMeshes[],
): void {
  for (let b = 0; b < batches.length; b += 1) {
    for (let k = 0; k < PART_COUNT; k += 1) {
      const mesh = batches[b].parts[VEHICLE_PART_KINDS[k]]
      if (controller.matrixDirty[b][k]) {
        controller.matrixDirty[b][k] = false
        /**
         * 收紧到最后一个有效槽位，空部件整批隐藏，避免空槽位仍产生精修顶点开销。
         * 删除、载货切换和资源换代均走矩阵脏路径，显隐随之同步。
         */
        let count = 0
        const array = mesh.instanceMatrix.array
        for (let slot = 0; slot < array.length / 16; slot += 1) {
          if (array[slot * 16] !== 0 || array[slot * 16 + 5] !== 0 || array[slot * 16 + 10] !== 0) count = slot + 1
        }
        mesh.count = count
        mesh.visible = count > 0
        mesh.instanceMatrix.needsUpdate = true
        // 外壳可拾取（SPEC §5.2）：实例矩阵变化后同步重算拾取包围球。
        // InstancedMesh 的 boundingSphere 只在 null 时被惰性计算，若在挂载期
        // 实例全零时被提前计算并缓存为「原点半径 0」，此后 raycast 的包围球
        // 预检将永远失败（真实浏览器实测复现）；这里按脏帧重算保证拾取球
        // 恒与最新实例数据一致（含车辆移出旧球的情形）。
        if (PICKABLE_PARTS.has(VEHICLE_PART_KINDS[k]) && mesh.geometry.getAttribute('position')) {
          mesh.computeBoundingSphere()
        }
      }
      if (controller.colorDirty[b][k]) {
        controller.colorDirty[b][k] = false
        if (mesh.instanceColor !== null) {
          mesh.instanceColor.needsUpdate = true
        }
      }
    }
  }
}

/** 绕 Y 旋转本地偏移 (lx, lz) 得世界偏移（three.js Y 旋转矩阵口径） */
function rotateOffsetY(lx: number, lz: number, rotY: number): { dx: number; dz: number } {
  const cos = Math.cos(rotY)
  const sin = Math.sin(rotY)
  return { dx: lx * cos + lz * sin, dz: -lx * sin + lz * cos }
}
