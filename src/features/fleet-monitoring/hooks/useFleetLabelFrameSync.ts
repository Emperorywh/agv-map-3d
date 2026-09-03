/**
 * 标签帧同步（SPEC §5.1、§6.4、§7.2、§11.5、§12.5；TASK-011）。
 *
 * 职责：作为车辆标签实例缓冲的唯一帧消费者——每帧对运行时实体做一次全量
 *       扫描（≤512 台），以「快照/显示状态对象引用」为差量依据只写变化的
 *       实例属性：内容差 → 底色/电量条/告警级/芯片 UV/名称图集单元；相机
 *       相关的投影档位逐帧重算（8px/20px 分级）；远景（<8px）只保留按优先
 *       级截断的前 20 个重点标签；删除 → 释放图集单元并零缩放清场。
 *       质量降级能力（TASK-014 接入）：importantLabelsOnly=true 时中距离纯
 *       名称档隐藏，仅保留重点标签与近景完整档（SPEC §6.5 行动 1）。
 * 边界：绝不消费运行时的 pose/display/removed 脏集合——那是车体帧同步
 *       （useFleetFrameSync）的独占输入，两者的差量口径互不干扰；标签只渲染
 *       已被槽位表分配槽位的实体（无车体者无标签）。全部缓存、投影草稿与
 *       脏标记为本 Hook 自有普通对象，绝不进入 React state/zustand（SPEC §4）。
 *       名称绘制只在内容变化时触达图集账本，电量/选中/告警变化绝不重绘名称
 *       纹理（SPEC §6.4）。
 * 关键不变量：
 * 1. 名称单元即槽位：cell = slot，槽位分配/复用/释放完全跟随车体槽位表；
 *    删除清理先用账本中记录的（批次, 槽位）清除单元，再用 table.resolve 防
 *    护——若该槽位同帧已被转派给等待车辆，矩阵清零跳过（新车主本帧全量
 *    写入覆盖），图集单元清除仍安全（转派车的名称写入发生在其后的内容
 *    扫描中，次序保证不被本清理覆盖）；
 * 2. 删除清理先于内容扫描：先以当前实体集合构建 seen，再清理消失实体的
 *    缓存与图集单元，杜绝「先绘新名后被旧清理覆盖」的次序缺陷；
 * 3. 未变化槽位不写：内容以快照/显示状态引用比对，档位与选中以缓存值比对，
 *    同一 (批次, 属性) 一帧内多次写合并为一次 needsUpdate；图集一帧至多
 *    一次纹理上载（SPEC §6.3/§6.4 合并提交语义）；
 * 4. 批次数组身份变化（扩批挂载/StrictMode 重挂载）即清空全部缓存：下一帧
 *    全量重写（新图集、新缓冲），任何挂载路径都收敛到运行时当前真相；
 * 5. 相机后方或视口尺寸不可得的投影长度记 0（隐藏），绝不以 NaN 进入档位
 *    判定。
 */
import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { DiagnosticsReporter } from '@/shared/diagnostics'
import type { WorldTransform } from '@/shared/spatial'
import type { FleetRuntime, ReadonlyFleetEntity } from '../model/createFleetRuntime'
import type { VehicleDisplayState, VehicleSnapshot } from '../model/types'
import type { InstanceSlotTable } from '../model/instanceSlots'
import { SLOT_BATCH_CAPACITY } from '../model/instanceSlots'
import { useFleetMonitoringStore } from '../model/fleetMonitoringStore'
import {
  LABEL_ANCHOR_Y_M,
  LABEL_HEIGHT_M,
  LABEL_IMPORTANT_MAX,
  LABEL_WIDTH_M,
  shellColorOf,
} from '../scene/fleetAppearance'
import {
  badgeChipUv,
  type LabelCellUv,
  type VehicleLabelAtlas,
} from '../scene/labelAtlas'
import { LABEL_BG_ATTR, LABEL_BG_ATTRIBUTE_NAMES } from '../scene/labelMaterials'
import {
  capImportantLabels,
  isFarImportantRank,
  labelAlertLevel,
  labelChipOf,
  labelImportanceRank,
  labelLevelForPixels,
  type ImportantLabelEntry,
} from '../scene/labelLod'
import { computeVehicleWorldPose } from '../scene/createVehicleGeometry'

/** 一个标签批次的可写对象集合：背景/名称两个 InstancedMesh + 图集 + 属性 */
export interface FleetLabelBatchMeshes {
  readonly background: THREE.InstancedMesh
  readonly text: THREE.InstancedMesh
  readonly atlas: VehicleLabelAtlas
  /** 背景层实例属性（数组序与 LABEL_BG_ATTRIBUTE_NAMES 一致） */
  readonly bgAttrs: THREE.InstancedBufferAttribute[]
  /** 名称层图集 UV 属性 */
  readonly nameAttr: THREE.InstancedBufferAttribute
}

export interface UseFleetLabelFrameSyncOptions {
  /** 高频车队运行时（只读扫描，不消费脏集合） */
  runtime: FleetRuntime
  /** 实例槽位表（与车体共享；标签只渲染已分配槽位的实体） */
  table: InstanceSlotTable
  /** 地图世界变换；null 时不做任何提交（等待地图就绪） */
  worldTransform: WorldTransform | null
  /** 当前已挂载标签批次（数组身份变化触发全量重写） */
  batches: readonly FleetLabelBatchMeshes[]
  /**
   * 标签降级能力开关（SPEC §6.5 行动 1「仅保留重点标签和近景标签」；
   * TASK-014 质量能力接线）：true 时中距离纯名称档（8～20px）隐藏，近景完
   * 整档与远景重点车（含选中/告警）不受影响；默认 false。
   */
  importantLabelsOnly?: boolean
  /** 结构化诊断通道（保留扩展点；当前标签层无采样告警路径） */
  diagnostics?: DiagnosticsReporter
}

/** 单实体的标签渲染缓存（Hook 自有普通对象，绝不进入 React） */
interface LabelEntityCache {
  readonly key: string
  /** 最近一次接触的批次与槽位（删除清理时实体已不在运行时，用缓存值） */
  batch: number
  slot: number
  /** 内容差量依据：快照与显示状态对象引用（不可变替换语义） */
  snapshot: VehicleSnapshot | null
  displayState: VehicleDisplayState | null
  /** 当前矩阵是否非零（可见） */
  shown: boolean
  /** 最近写入的内容档位（-1 = 尚未写入，强制首写） */
  level: number
  /** 最近写入的选中态与告警级（overlay 属性的两个分量） */
  selected: boolean
  alertLevel: 0 | 1 | 2
  /** 名称 UV 是否已写入（单元即槽位，UV 恒定，只需首写） */
  uvWritten: boolean
  /** 最近写入矩阵的锚点（判断位姿是否变化） */
  writtenX: number
  writtenZ: number
  /** 本帧扫描的中间量：锚点位姿、投影档位、远景重点秩、选中态 */
  poseX: number
  poseZ: number
  levelNext: LabelLevelNext
  farRank: number | null
  selectedNext: boolean
}

/** 档位中间值：0 = 待定（远景时可能因重点准入提升为 1） */
type LabelLevelNext = 0 | 1 | 2

interface LabelFrameController {
  caches: Map<string, LabelEntityCache>
  seen: Set<string>
  /** 远景重点候选（平行数字数组，避免逐帧对象分配） */
  farFlat: number[]
  farRank: number[]
  /** [批次] 矩阵脏标记（背景与名称两层网格同步写） */
  matrixDirty: boolean[]
  /** [批次][属性] 背景实例属性脏标记 */
  bgAttrDirty: boolean[][]
  /** [批次] 名称 UV 属性脏标记 */
  nameAttrDirty: boolean[]
  /** 上一次全量重写对应的批次数组身份 */
  lastBatchesIdentity: readonly FleetLabelBatchMeshes[] | null
}

/** 帧循环复用的草稿对象：模块级常量，杜绝每帧分配 */
const scratchMatrix = new THREE.Matrix4()
const scratchPosition = new THREE.Vector3()
const scratchScale = new THREE.Vector3()
const scratchColor = new THREE.Color()
const scratchViewA = new THREE.Vector3()
const scratchViewB = new THREE.Vector3()
const IDENTITY_QUATERNION = new THREE.Quaternion()
const scratch1: number[] = [0]
const scratch2: number[] = [0, 0]
const scratch3: number[] = [0, 0, 0]
const scratch4: number[] = [0, 0, 0, 0]

function createLabelFrameController(): LabelFrameController {
  return {
    caches: new Map(),
    seen: new Set<string>(),
    farFlat: [],
    farRank: [],
    matrixDirty: [],
    bgAttrDirty: [],
    nameAttrDirty: [],
    lastBatchesIdentity: null,
  }
}

export function useFleetLabelFrameSync({
  runtime,
  table,
  worldTransform,
  batches,
  importantLabelsOnly = false,
  diagnostics,
}: UseFleetLabelFrameSyncOptions): void {
  // options 经 ref 透传：useFrame 闭包恒定，数组身份/回调变化不重建帧回调
  const optionsRef = useRef(
    { runtime, table, worldTransform, batches, importantLabelsOnly, diagnostics },
  )
  optionsRef.current = {
    runtime,
    table,
    worldTransform,
    batches,
    importantLabelsOnly,
    diagnostics,
  }

  const controllerRef = useRef<LabelFrameController | null>(null)
  if (controllerRef.current === null) {
    controllerRef.current = createLabelFrameController()
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

  useFrame((state) => {
    const controller = controllerRef.current
    if (controller === null) {
      return
    }
    tickLabelFrame(state, controller, optionsRef.current)
  })
}

/** 单帧标签提交（useFrame 回调本体） */
function tickLabelFrame(
  state: { camera: THREE.Camera; size?: { width: number } },
  controller: LabelFrameController,
  options: {
    runtime: FleetRuntime
    table: InstanceSlotTable
    worldTransform: WorldTransform | null
    batches: readonly FleetLabelBatchMeshes[]
    importantLabelsOnly: boolean
  },
): void {
  const { runtime, table, worldTransform, batches, importantLabelsOnly } = options
  if (worldTransform === null || batches.length === 0) {
    return
  }
  ensureCapacity(controller, batches.length)

  // 批次数组身份变化（首帧/扩批挂载/StrictMode 重挂载）→ 清缓存全量重写
  if (controller.lastBatchesIdentity !== batches) {
    controller.lastBatchesIdentity = batches
    controller.caches.clear()
  }

  const camera = state.camera
  camera.updateMatrixWorld()
  const viewportWidth = state.size?.width ?? 0
  const selectedKey = useFleetMonitoringStore.getState().selectedKey
  const entities = runtime.entities()

  // —— 删除清理（先于内容扫描）：清除消失实体的图集单元与残留矩阵 ——
  controller.seen.clear()
  for (const entity of entities) {
    controller.seen.add(entity.key)
  }
  for (const [key, cache] of controller.caches) {
    if (controller.seen.has(key)) {
      continue
    }
    if (cache.batch < batches.length) {
      // 槽位已被转派（resolve 命中新车主）时矩阵由新车主全量写入，不清零；
      // 图集单元清除总是安全——转派车的名称写入发生在其后的内容扫描
      if (table.resolve(cache.batch, cache.slot) === undefined) {
        zeroLabelMatrix(controller, batches, cache.batch, cache.slot)
      }
      batches[cache.batch].atlas.book.clearCell(cache.slot)
    }
    controller.caches.delete(key)
  }

  // —— PASS 1：内容差量写入 + 投影档位采集 ——
  let farCount = 0
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
        displayState: null,
        shown: false,
        level: -1,
        selected: false,
        alertLevel: 0,
        uvWritten: false,
        writtenX: Number.NaN,
        writtenZ: Number.NaN,
        poseX: 0,
        poseZ: 0,
        levelNext: 0,
        farRank: null,
        selectedNext: false,
      }
      controller.caches.set(entity.key, cache)
    }
    cache.batch = slot.batch
    cache.slot = slot.slot
    cache.farRank = null
    cache.selectedNext = entity.key === selectedKey

    const layoutVisible = entity.snapshot.positionValid && entity.snapshot.dimensionValid
    if (!layoutVisible) {
      // 非法位置/尺寸：不放置标签（与车体同口径），保留缓存等待恢复
      cache.levelNext = 0
      continue
    }

    const contentChanged =
      cache.snapshot !== entity.snapshot || cache.displayState !== entity.displayState
    if (contentChanged) {
      writeContentAttrs(controller, batches, cache, entity)
      cache.snapshot = entity.snapshot
      cache.displayState = entity.displayState
    }

    // 投影档位：以车体长度在屏幕上的像素长度分级（8px/20px，边界含）
    const pose = computeVehicleWorldPose(entity.snapshot, worldTransform)
    cache.poseX = pose.cx
    cache.poseZ = pose.cz
    const projectedPx =
      viewportWidth > 0
        ? projectedBodyLengthPx(
            camera,
            pose.cx,
            LABEL_ANCHOR_Y_M,
            pose.cz,
            entity.snapshot.dimension.length,
            viewportWidth,
          )
        : 0
    cache.levelNext = labelLevelForPixels(projectedPx)
    // 质量降级能力（SPEC §6.5 行动 1）：中距离纯名称档隐藏。抑制发生在远景
    // 重点登记之前——中距离的重点车落入 0 档后仍可经重点通道以名称档保留，
    // 近景完整档（≥20px）不受影响（仅保留重点标签和近景标签）。
    if (importantLabelsOnly && cache.levelNext === 1) {
      cache.levelNext = 0
    }

    // 远景候选登记（<8px，P1-12 白名单：总览只保留 selected + FAULT，
    // 即秩 0/1；STALE/断连/低电量只在近中景显示标签）
    if (cache.levelNext === 0) {
      const rank = labelImportanceRank({
        selected: cache.selectedNext,
        primary: entity.displayState.primary,
        alerts: entity.staticState.alerts,
      })
      if (isFarImportantRank(rank)) {
        const flat = slot.batch * SLOT_BATCH_CAPACITY + slot.slot
        controller.farFlat[farCount] = flat
        controller.farRank[farCount] = rank
        farCount += 1
        cache.farRank = rank
      }
    }
  }

  // —— 远景重点截断：超过上限时按（秩, 扁平槽位）保留前 20 ——
  let kept: Set<number> | null = null
  if (farCount > LABEL_IMPORTANT_MAX) {
    const entries: ImportantLabelEntry[] = []
    for (let i = 0; i < farCount; i += 1) {
      entries.push({ flatSlot: controller.farFlat[i], rank: controller.farRank[i] })
    }
    kept = capImportantLabels(entries, LABEL_IMPORTANT_MAX)
  }

  // —— PASS 2：应用档位 / 选中 / 矩阵 ——
  for (const entity of entities) {
    const cache = controller.caches.get(entity.key)
    if (cache === undefined) {
      continue
    }
    const slot = table.get(entity.key)
    if (slot === undefined || slot.batch >= batches.length) {
      if (cache.shown && cache.batch < batches.length) {
        zeroLabelMatrix(controller, batches, cache.batch, cache.slot)
        cache.shown = false
      }
      continue
    }

    // 档位决策：远景（0 档）只对通过截断的重点车降级显示为「仅名称」
    let level = cache.levelNext
    if (level === 0 && cache.farRank !== null) {
      const flat = slot.batch * SLOT_BATCH_CAPACITY + slot.slot
      if (kept === null || kept.has(flat)) {
        level = 1
      }
    }

    // 内容档位写入（电量条与芯片由 shader 按 aLevel 裁剪）
    if (level !== cache.level) {
      scratch1[0] = level
      writeBgAttr(controller, batches, slot.batch, slot.slot, LABEL_BG_ATTR.level, scratch1)
      cache.level = level
    }

    // 选中态写入（仅变化时；告警级随内容写入维护）
    if (cache.selectedNext !== cache.selected) {
      cache.selected = cache.selectedNext
      scratch2[0] = cache.selected ? 1 : 0
      scratch2[1] = cache.alertLevel
      writeBgAttr(controller, batches, slot.batch, slot.slot, LABEL_BG_ATTR.overlay, scratch2)
    }

    // 矩阵：可见性切换或锚点位姿变化时重写（背景与名称两层同步）
    const shown = level > 0
    if (
      shown !== cache.shown ||
      (shown && (cache.writtenX !== cache.poseX || cache.writtenZ !== cache.poseZ))
    ) {
      if (shown) {
        writeLabelMatrix(controller, batches, slot.batch, slot.slot, cache.poseX, cache.poseZ)
      } else {
        zeroLabelMatrix(controller, batches, slot.batch, slot.slot)
      }
      cache.shown = shown
      cache.writtenX = cache.poseX
      cache.writtenZ = cache.poseZ
    }
  }

  // —— 批次级合并提交：矩阵（两层）、实例属性、图集上载 ——
  for (let b = 0; b < batches.length; b += 1) {
    const batch = batches[b]
    if (controller.matrixDirty[b]) {
      controller.matrixDirty[b] = false
      batch.background.instanceMatrix.needsUpdate = true
      batch.text.instanceMatrix.needsUpdate = true
    }
    for (let a = 0; a < LABEL_BG_ATTRIBUTE_NAMES.length; a += 1) {
      if (controller.bgAttrDirty[b][a]) {
        controller.bgAttrDirty[b][a] = false
        batch.bgAttrs[a].needsUpdate = true
      }
    }
    if (controller.nameAttrDirty[b]) {
      controller.nameAttrDirty[b] = false
      batch.nameAttr.needsUpdate = true
    }
    // 名称图集：一帧内多次重绘合并为一次纹理上载
    batch.atlas.flush()
  }
}

/** 按批次数量扩展脏标记数组（新批次默认无脏） */
function ensureCapacity(controller: LabelFrameController, batchCount: number): void {
  while (controller.matrixDirty.length < batchCount) {
    controller.matrixDirty.push(false)
    controller.bgAttrDirty.push(new Array<boolean>(LABEL_BG_ATTRIBUTE_NAMES.length).fill(false))
    controller.nameAttrDirty.push(false)
  }
}

/**
 * 内容差量写入：底色（主状态色）、电量条填充、告警级、芯片 UV、名称图集
 * 单元与名称 UV。只在快照/显示状态引用变化时被调用。
 */
function writeContentAttrs(
  controller: LabelFrameController,
  batches: readonly FleetLabelBatchMeshes[],
  cache: LabelEntityCache,
  entity: ReadonlyFleetEntity,
): void {
  const { batch, slot } = cache
  if (batch >= batches.length) {
    return
  }
  const primary = entity.displayState.primary

  // 底色 = 主状态车体色（与车体外壳同表，STALE 冻结灰 / 断连深灰）
  scratchColor.set(shellColorOf(primary))
  scratch3[0] = scratchColor.r
  scratch3[1] = scratchColor.g
  scratch3[2] = scratchColor.b
  writeBgAttr(controller, batches, batch, slot, LABEL_BG_ATTR.stateColor, scratch3)

  // 电量条填充：电量未知为 -1（shader 端不绘制），已知归一到 0..1
  const charge = entity.snapshot.battery.batteryCharge
  scratch1[0] = charge === null ? -1 : Math.min(1, Math.max(0, charge / 100))
  writeBgAttr(controller, batches, batch, slot, LABEL_BG_ATTR.charge, scratch1)

  // 告警级 + 选中态（overlay 两分量一并写入，选中值以后续帧差异维护）
  cache.alertLevel = labelAlertLevel(primary, entity.staticState.alerts)
  scratch2[0] = cache.selectedNext ? 1 : 0
  scratch2[1] = cache.alertLevel
  cache.selected = cache.selectedNext
  writeBgAttr(controller, batches, batch, slot, LABEL_BG_ATTR.overlay, scratch2)

  // 状态芯片 UV：FRESH 为业务主状态，STALE/断连为最后已知业务状态副徽标
  const chip = labelChipOf(primary, entity.displayState.secondary)
  const chipUv = badgeChipUv(chip)
  scratch4[0] = chipUv[0]
  scratch4[1] = chipUv[1]
  scratch4[2] = chipUv[2]
  scratch4[3] = chipUv[3]
  writeBgAttr(controller, batches, batch, slot, LABEL_BG_ATTR.chipUv, scratch4)

  // 名称图集：只重绘目标单元（账本内部按内容去重）；UV 恒定只需首写
  batches[batch].atlas.book.ensureCell(slot, entity.snapshot.agvName)
  if (!cache.uvWritten) {
    const uv: LabelCellUv = batches[batch].atlas.cellUv(slot)
    scratch4[0] = uv.u0
    scratch4[1] = uv.v0
    scratch4[2] = uv.u1
    scratch4[3] = uv.v1
    const attr = batches[batch].nameAttr
    ;(attr.array as Float32Array).set(scratch4, slot * 4)
    controller.nameAttrDirty[batch] = true
    cache.uvWritten = true
  }
}

/** 写背景层单个实例属性（values 长度必须等于属性 itemSize） */
function writeBgAttr(
  controller: LabelFrameController,
  batches: readonly FleetLabelBatchMeshes[],
  batch: number,
  slot: number,
  attrIndex: number,
  values: readonly number[],
): void {
  const attr = batches[batch].bgAttrs[attrIndex]
  const base = slot * attr.itemSize
  const array = attr.array as Float32Array
  for (let c = 0; c < attr.itemSize; c += 1) {
    array[base + c] = values[c]
  }
  controller.bgAttrDirty[batch][attrIndex] = true
}

/** 标签矩阵写入：锚点位于车体上方，恒定世界尺寸，旋转为 Identity（billboard） */
function writeLabelMatrix(
  controller: LabelFrameController,
  batches: readonly FleetLabelBatchMeshes[],
  batch: number,
  slot: number,
  x: number,
  z: number,
): void {
  scratchPosition.set(x, LABEL_ANCHOR_Y_M, z)
  scratchScale.set(LABEL_WIDTH_M, LABEL_HEIGHT_M, 1)
  scratchMatrix.compose(scratchPosition, IDENTITY_QUATERNION, scratchScale)
  writeBatchMatrix(controller, batches, batch, slot)
}

/** 标签矩阵清零：零缩放隐藏（与车体同口径，杜绝幽灵标签） */
function zeroLabelMatrix(
  controller: LabelFrameController,
  batches: readonly FleetLabelBatchMeshes[],
  batch: number,
  slot: number,
): void {
  const array = scratchMatrix.elements
  for (let i = 0; i < 15; i += 1) {
    array[i] = 0
  }
  array[15] = 1
  writeBatchMatrix(controller, batches, batch, slot)
}

/** 把草稿矩阵写入批次的背景与名称两层实例缓冲并置脏 */
function writeBatchMatrix(
  controller: LabelFrameController,
  batches: readonly FleetLabelBatchMeshes[],
  batch: number,
  slot: number,
): void {
  const base = slot * 16
  const bg = batches[batch].background.instanceMatrix.array as unknown as number[]
  const text = batches[batch].text.instanceMatrix.array as unknown as number[]
  for (let i = 0; i < 16; i += 1) {
    bg[base + i] = scratchMatrix.elements[i]
    text[base + i] = scratchMatrix.elements[i]
  }
  controller.matrixDirty[batch] = true
}

/**
 * 车体投影长度（像素）：取视空间中沿相机右轴（视图 x 轴）长度为车长的线段，
 * 经投影矩阵后换算为屏幕像素长度。视空间 x 轴即相机右轴，无需额外向量。
 * 位于相机后方或近平面内的点记 0（隐藏）。
 */
function projectedBodyLengthPx(
  camera: THREE.Camera,
  x: number,
  y: number,
  z: number,
  lengthM: number,
  viewportWidth: number,
): number {
  scratchViewA.set(x, y, z).applyMatrix4(camera.matrixWorldInverse)
  if (!(scratchViewA.z < -0.5)) {
    return 0
  }
  scratchViewB.copy(scratchViewA)
  scratchViewB.x += lengthM
  scratchViewA.applyMatrix4(camera.projectionMatrix)
  scratchViewB.applyMatrix4(camera.projectionMatrix)
  return Math.abs(scratchViewB.x - scratchViewA.x) * 0.5 * viewportWidth
}
