/**
 * selectVisibleLabels：标签候选选择纯策略（SPEC §8.3、§5.2、§9.3、§10.1）。
 *
 * 无 React 依赖；相机使用 three PerspectiveCamera（node 环境可测）。
 *
 * 三部分职责：
 * 1. createVisibleLabelSelector —— 单次重算：
 *    - 距离迟滞（§8.3：站点 ≤90 进 / >95 出，普通节点 ≤40/>44，路径 ≤25/>28；
 *      迟滞状态按 label id 跨重算保持，每次重算仅按距离更新，与视锥/遮挡无关）；
 *    - 相机视锥过滤（锚点点测试，投影矩阵 × 即时求逆的视图矩阵，不依赖
 *      renderer 维护的 matrixWorldInverse，帧内位姿无延迟）；
 *    - 类别内按 (distanceSquared, id) 稳定排序，按 LABEL_CATEGORIES 顺序
 *      （station → node → path，application 契约固定）填充保留名额 120/120/60；
 *      遇不透明厂房遮挡跳过并继续该类后续候选（§8.3），被遮挡候选不进入补足池；
 *    - 保留完成后剩余候选按 (distanceSquared, category, id) 稳定排序补足空余，
 *      全局 ≤ LABEL_MAX_COUNT=300（保留名额总和等于上限，不是额外容量）；
 *    - 遮挡检测（§9.3）：内部 Raycaster 只对 TASK-008 暴露的 labelOccluders
 *      引用列表（实墙/墙柱/主梁/檩条；玻璃不在列表中故不遮挡）逐个非递归
 *      raycast，首个命中即判定遮挡；射线终点 = 标签锚点（元数据携带
 *      LABEL_ANCHOR_Y=0.5m 高度），far 取相机到锚点距离，不经过
 *      MapLayer/FactoryLayer 根 group，不开启 R3F 对象事件；
 *    - 预分配（§10.1）：候选对象池/类别桶/补足池/射线与矩阵临时量全部复用，
 *      仅在标签总数超过历史峰值时增长一次，稳态重算零逐帧分配；
 *      out 由调用方预分配（长度 ≥ LABEL_MAX_COUNT），返回选中数量。
 * 2. createLabelSelectionDiffer —— 选中集合差分：只产出 attach（新进入的
 *    元数据）与 detach（退出的 id）变化项，供 LabelLayer 增量 attach/detach，
 *    不清空重建 DOM（§8.3）；内部 Set 复用。
 * 3. createLabelRecalcScheduler —— 重算时机状态机（§8.3/§5.2）：
 *    位移 ≥0.25m 或朝向 ≥0.25° 才重算；阻尼运动期最多 10Hz（被节流的变化
 *    记为待终算）；位姿连续两帧不变（停止）或变化回落到阈值以下时立即执行
 *    最终重算；viewport/地图变化经 forceRecalc 无条件重算。时间源注入，
 *    测试不依赖系统时间（§15.1）。
 */

import { Frustum, Matrix4, Raycaster, Vector3 } from 'three'
import type { Intersection, Object3D, PerspectiveCamera, Quaternion } from 'three'

import { LABEL_CATEGORIES } from '../../../application/factorySceneModel'
import type { LabelCategory, LabelMetadataDto } from '../../../application/factorySceneModel'
import {
  LABEL_CAMERA_ANGLE_DELTA_DEG,
  LABEL_CAMERA_POS_DELTA,
  LABEL_MAX_COUNT,
  LABEL_RECALC_MAX_HZ,
  LABEL_RESERVED_NODE,
  LABEL_RESERVED_PATH,
  LABEL_RESERVED_STATION,
  NODE_ENTER,
  NODE_EXIT,
  PATH_LABEL_ENTER,
  PATH_LABEL_EXIT,
  STATION_ENTER,
  STATION_EXIT,
} from '../../../config/labelPolicy'

// ---------------------------------------------------------------------------
// §8.3 类别策略表（数值全部来自 config/labelPolicy，§13.2）
// ---------------------------------------------------------------------------

interface CategoryPolicy {
  readonly enter: number
  readonly exit: number
  readonly reserved: number
}

const CATEGORY_POLICIES: Record<LabelCategory, CategoryPolicy> = {
  station: { enter: STATION_ENTER, exit: STATION_EXIT, reserved: LABEL_RESERVED_STATION },
  node: { enter: NODE_ENTER, exit: NODE_EXIT, reserved: LABEL_RESERVED_NODE },
  path: { enter: PATH_LABEL_ENTER, exit: PATH_LABEL_EXIT, reserved: LABEL_RESERVED_PATH },
}

/** 类别次序索引：与 application 契约 LABEL_CATEGORIES（§5.1）填充顺序一致 */
const CATEGORY_ORDER: Record<LabelCategory, number> = {
  station: LABEL_CATEGORIES.indexOf('station'),
  node: LABEL_CATEGORIES.indexOf('node'),
  path: LABEL_CATEGORIES.indexOf('path'),
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// ---------------------------------------------------------------------------
// 候选选择器
// ---------------------------------------------------------------------------

export interface VisibleLabelSelectorOptions {
  /**
   * §9.3 不透明厂房遮挡 mesh 引用（TASK-008 FactorySceneSnapshot.labelOccluders：
   * 实墙/墙柱/主梁/檩条；玻璃不在列表中 → 玻璃不遮挡）。选择器只对该列表
   * 逐个 raycast，不接触场景根 group。
   */
  readonly occluders: readonly Object3D[]
}

export interface VisibleLabelSelector {
  /**
   * 重算候选：选中项写入 out（调用方预分配，长度 ≥ LABEL_MAX_COUNT），
   * 返回选中数量（≤ LABEL_MAX_COUNT）。结果按填充顺序排列：
   * 三类保留名额（各类内按 (distanceSquared, id)）→ 补足段
   * （按 (distanceSquared, category, id)）。
   */
  select(
    labels: readonly LabelMetadataDto[],
    camera: PerspectiveCamera,
    out: LabelMetadataDto[],
  ): number
  /** 清空迟滞状态（地图变化时由 LabelLayer 调用，新地图全部重新判定进入距离） */
  reset(): void
}

/** 预分配候选槽：逐次重算就地覆写，稳态零分配（§10.1） */
interface LabelCandidate {
  label: LabelMetadataDto | null
  id: string
  categoryOrder: number
  distanceSquared: number
  distance: number
}

function createCandidate(): LabelCandidate {
  return {
    label: null,
    id: '',
    categoryOrder: 0,
    distanceSquared: 0,
    distance: 0,
  }
}

export function createVisibleLabelSelector(
  options: VisibleLabelSelectorOptions,
): VisibleLabelSelector {
  const { occluders } = options

  /** 迟滞状态：label id → 当前是否在距离带内（§8.3） */
  const hysteresis = new Map<string, boolean>()

  // 预分配临时量（§10.1：相机/标签/遮挡计算使用预分配对象）
  const frustum = new Frustum()
  const viewMatrix = new Matrix4()
  const viewProjectionMatrix = new Matrix4()
  const cameraPosition = new Vector3()
  const anchor = new Vector3()
  const rayDirection = new Vector3()
  const raycaster = new Raycaster()
  const hits: Intersection[] = []

  // 候选对象池：仅在候选总数超历史峰值时增长一次；桶/补足池每次重算清空
  // 长度后重新 push（数组容量保留，仅截断引用，稳态零分配）
  const pool: LabelCandidate[] = []
  let poolUsed = 0
  const buckets: LabelCandidate[][] = LABEL_CATEGORIES.map(() => [])
  const spillover: LabelCandidate[] = []

  let camX = 0
  let camY = 0
  let camZ = 0

  const acquireCandidate = (): LabelCandidate => {
    if (poolUsed === pool.length) pool.push(createCandidate())
    const candidate = pool[poolUsed]
    poolUsed += 1
    return candidate
  }

  /**
   * 遮挡测试：首个命中的遮挡物即判定遮挡。每个候选在一次重算内至多被测试
   * 一次（保留阶段已测的候选要么入选要么被丢弃，进入补足池的必然未测）。
   */
  const isOccluded = (candidate: LabelCandidate): boolean => {
    // 候选已通过视锥过滤 → 距离 ≥ 相机 near（0.1m），射线方向必然非零
    const label = candidate.label as LabelMetadataDto
    const [ax, ay, az] = label.worldPosition
    rayDirection.set(ax - camX, ay - camY, az - camZ).normalize()
    raycaster.set(cameraPosition, rayDirection)
    raycaster.near = 0
    // 射线终点 = 标签锚点（LABEL_ANCHOR_Y=0.5m 高度由元数据携带，§8.2/§8.3）
    raycaster.far = candidate.distance
    for (const occluder of occluders) {
      hits.length = 0
      occluder.raycast(raycaster, hits)
      if (hits.length > 0) return true
    }
    return false
  }

  /** 桶内排序：(distanceSquared, id)（就地排序，无数组分配） */
  const compareBucket = (a: LabelCandidate, b: LabelCandidate): number => {
    if (a.distanceSquared !== b.distanceSquared) return a.distanceSquared - b.distanceSquared
    return compareStrings(a.id, b.id)
  }

  /** 补足段排序：(distanceSquared, category, id)（§8.3） */
  const compareSpillover = (a: LabelCandidate, b: LabelCandidate): number => {
    if (a.distanceSquared !== b.distanceSquared) return a.distanceSquared - b.distanceSquared
    if (a.categoryOrder !== b.categoryOrder) return a.categoryOrder - b.categoryOrder
    return compareStrings(a.id, b.id)
  }

  return {
    select(
      labels: readonly LabelMetadataDto[],
      camera: PerspectiveCamera,
      out: LabelMetadataDto[],
    ): number {
      poolUsed = 0
      for (const bucket of buckets) bucket.length = 0
      spillover.length = 0

      // 帧内即时位姿：controls 在更早的 useFrame 优先级更新了 position/quaternion，
      // matrixWorld 尚未由 renderer 刷新——此处就地重算，视图矩阵即时求逆
      camera.updateMatrixWorld()
      cameraPosition.setFromMatrixPosition(camera.matrixWorld)
      camX = cameraPosition.x
      camY = cameraPosition.y
      camZ = cameraPosition.z
      viewMatrix.copy(camera.matrixWorld).invert()
      viewProjectionMatrix.multiplyMatrices(camera.projectionMatrix, viewMatrix)
      frustum.setFromProjectionMatrix(viewProjectionMatrix)

      // 第一遍：距离迟滞（状态逐标签更新，与视锥/遮挡无关）+ 视锥过滤
      for (const label of labels) {
        const [ax, ay, az] = label.worldPosition
        const dx = ax - camX
        const dy = ay - camY
        const dz = az - camZ
        const distanceSquared = dx * dx + dy * dy + dz * dz
        const distance = Math.sqrt(distanceSquared)
        const policy = CATEGORY_POLICIES[label.category]
        const wasInBand = hysteresis.get(label.id) ?? false
        const inBand = wasInBand ? distance <= policy.exit : distance <= policy.enter
        hysteresis.set(label.id, inBand)
        if (!inBand) continue
        anchor.set(ax, ay, az)
        if (!frustum.containsPoint(anchor)) continue

        const candidate = acquireCandidate()
        candidate.label = label
        candidate.id = label.id
        candidate.categoryOrder = CATEGORY_ORDER[label.category]
        candidate.distanceSquared = distanceSquared
        candidate.distance = distance

        buckets[CATEGORY_ORDER[label.category]].push(candidate)
      }

      // 第二遍：按 LABEL_CATEGORIES 顺序填充保留名额；超额候选进入补足池
      let total = 0
      for (let categoryIndex = 0; categoryIndex < LABEL_CATEGORIES.length; categoryIndex += 1) {
        const policy = CATEGORY_POLICIES[LABEL_CATEGORIES[categoryIndex]]
        const bucket = buckets[categoryIndex]
        bucket.sort(compareBucket)
        let filled = 0
        for (const candidate of bucket) {
          if (filled < policy.reserved) {
            // §8.3：遇实墙/墙柱/主梁/檩条遮挡跳过并继续该类后续候选；
            // 被遮挡候选不属于可见候选，不进入补足池
            if (isOccluded(candidate)) continue
            out[total] = candidate.label as LabelMetadataDto
            total += 1
            filled += 1
          } else {
            // 超出保留名额的候选未经遮挡测试，进入补足池
            spillover.push(candidate)
          }
        }
      }

      // 第三遍：补足空余容量（全局 ≤ LABEL_MAX_COUNT）
      spillover.sort(compareSpillover)
      for (const candidate of spillover) {
        if (total >= LABEL_MAX_COUNT) break
        if (isOccluded(candidate)) continue
        out[total] = candidate.label as LabelMetadataDto
        total += 1
      }

      return total
    },

    reset(): void {
      hysteresis.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// 选中集合差分（§8.3：只 attach/detach 变化项，不清空重建）
// ---------------------------------------------------------------------------

export interface LabelSelectionDiff {
  /** attach 数量（attachOut 前 attachCount 项为新进入的标签元数据，按选中顺序） */
  attachCount: number
  /** detach 数量（detachOut 前 detachCount 项为退出的 label id，按上次选中顺序） */
  detachCount: number
}

export interface LabelSelectionDiffer {
  /**
   * 差分上次与本次选中集合（仅各前 count 项有效）。
   * attachOut / detachOut 由调用方预分配（长度 ≥ LABEL_MAX_COUNT）。
   * 返回值为内部复用对象，就地覆写——调用方不得保留引用跨差分使用。
   */
  diff(
    previous: readonly LabelMetadataDto[],
    previousCount: number,
    next: readonly LabelMetadataDto[],
    nextCount: number,
    attachOut: LabelMetadataDto[],
    detachOut: string[],
  ): LabelSelectionDiff
}

export function createLabelSelectionDiffer(): LabelSelectionDiffer {
  const previousIds = new Set<string>()
  const result: LabelSelectionDiff = { attachCount: 0, detachCount: 0 }

  return {
    diff(
      previous: readonly LabelMetadataDto[],
      previousCount: number,
      next: readonly LabelMetadataDto[],
      nextCount: number,
      attachOut: LabelMetadataDto[],
      detachOut: string[],
    ): LabelSelectionDiff {
      previousIds.clear()
      for (let i = 0; i < previousCount; i += 1) previousIds.add(previous[i].id)

      let attachCount = 0
      for (let i = 0; i < nextCount; i += 1) {
        const label = next[i]
        if (!previousIds.delete(label.id)) {
          attachOut[attachCount] = label
          attachCount += 1
        }
      }

      // 剩余 id = 退出项；Set 保持插入序（上次选中顺序）
      let detachCount = 0
      for (const id of previousIds) {
        detachOut[detachCount] = id
        detachCount += 1
      }

      result.attachCount = attachCount
      result.detachCount = detachCount
      return result
    },
  }
}

// ---------------------------------------------------------------------------
// 重算时机调度（§8.3：阈值 / 10Hz 节流 / 停止即终算；§5.2 位姿超阈值才重算）
// ---------------------------------------------------------------------------

export interface LabelRecalcSchedulerOptions {
  /** 单调毫秒时钟（生产 performance.now；测试注入假时钟，§15.1 不依赖系统时间） */
  readonly now: () => number
}

export interface LabelRecalcScheduler {
  /**
   * 每个实际重绘帧喂入当前相机位姿，返回本帧是否应执行候选重算：
   * - 首次调用或 forceRecalc 后：无条件重算；
   * - 位移 ≥ LABEL_CAMERA_POS_DELTA 或朝向 ≥ LABEL_CAMERA_ANGLE_DELTA_DEG：
   *   距上次重算 ≥ 1000/LABEL_RECALC_MAX_HZ ms 才重算（运动期 ≤10Hz）；
   * - 被节流的变化记为待终算：位姿连续两帧不变（停止）或变化回落到阈值
   *   以下时，下一帧立即执行最终重算（不受 10Hz 限制）。
   */
  onFrame(position: { x: number, y: number, z: number }, quaternion: Quaternion): boolean
  /** viewport 尺寸或地图变化：下一帧无条件重算（§8.3） */
  forceRecalc(): void
}

const MIN_RECALC_INTERVAL_MS = 1000 / LABEL_RECALC_MAX_HZ
const DEG_PER_RAD = 180 / Math.PI

export function createLabelRecalcScheduler(
  options: LabelRecalcSchedulerOptions,
): LabelRecalcScheduler {
  const { now } = options

  let hasRecalc = false
  let forced = false
  let pendingFinal = false
  let lastRecalcTime = 0

  // 上次重算位姿与上一帧位姿（预分配标量字段，无逐帧对象分配）
  let recalcPosX = 0
  let recalcPosY = 0
  let recalcPosZ = 0
  let recalcQuatX = 0
  let recalcQuatY = 0
  let recalcQuatZ = 0
  let recalcQuatW = 1
  let hasSeen = false
  let seenPosX = 0
  let seenPosY = 0
  let seenPosZ = 0
  let seenQuatX = 0
  let seenQuatY = 0
  let seenQuatZ = 0
  let seenQuatW = 1

  const commit = (
    position: { x: number, y: number, z: number },
    quaternion: Quaternion,
    time: number,
  ): void => {
    recalcPosX = position.x
    recalcPosY = position.y
    recalcPosZ = position.z
    recalcQuatX = quaternion.x
    recalcQuatY = quaternion.y
    recalcQuatZ = quaternion.z
    recalcQuatW = quaternion.w
    lastRecalcTime = time
    hasRecalc = true
    forced = false
    pendingFinal = false
  }

  return {
    onFrame(position, quaternion): boolean {
      const time = now()
      if (!hasRecalc || forced) {
        commit(position, quaternion, time)
        return true
      }

      const dx = position.x - recalcPosX
      const dy = position.y - recalcPosY
      const dz = position.z - recalcPosZ
      const positionDelta = Math.sqrt(dx * dx + dy * dy + dz * dz)
      const dot = Math.min(
        1,
        Math.abs(
          quaternion.x * recalcQuatX
          + quaternion.y * recalcQuatY
          + quaternion.z * recalcQuatZ
          + quaternion.w * recalcQuatW,
        ),
      )
      const angleDeltaDeg = 2 * Math.acos(dot) * DEG_PER_RAD
      const moved = positionDelta >= LABEL_CAMERA_POS_DELTA
        || angleDeltaDeg >= LABEL_CAMERA_ANGLE_DELTA_DEG
      const stopped = hasSeen
        && position.x === seenPosX
        && position.y === seenPosY
        && position.z === seenPosZ
        && quaternion.x === seenQuatX
        && quaternion.y === seenQuatY
        && quaternion.z === seenQuatZ
        && quaternion.w === seenQuatW

      seenPosX = position.x
      seenPosY = position.y
      seenPosZ = position.z
      seenQuatX = quaternion.x
      seenQuatY = quaternion.y
      seenQuatZ = quaternion.z
      seenQuatW = quaternion.w
      hasSeen = true

      if (!moved) {
        // 变化回落到阈值以下（含阻尼尾段微动）：有待终算立即终算
        if (pendingFinal) {
          commit(position, quaternion, time)
          return true
        }
        return false
      }
      // §8.3：停止时立即执行最终重算（位姿连续两帧不变，不受 10Hz 限制）
      if (stopped) {
        commit(position, quaternion, time)
        return true
      }
      // 阻尼运动期最多 10Hz
      if (time - lastRecalcTime >= MIN_RECALC_INTERVAL_MS) {
        commit(position, quaternion, time)
        return true
      }
      pendingFinal = true
      return false
    },

    forceRecalc(): void {
      forced = true
    },
  }
}
