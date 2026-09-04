/**
 * 俯瞰自动取景数学（SPEC §5.5「初始机位按地图包围盒自动取景，俯视角约
 * 45°」；TASK-013；P0-1 按视觉差距分析改为四角投影包络）。
 *
 * 职责：由地图场景包围盒、相机视场角与视口纵横比计算唯一确定的俯瞰机位——
 *       位置、注视目标、近远平面与缩放距离限制；空格俯瞰（SPEC §8）与初始
 *       取景共用同一数学，保证「回地图包围盒中心」与首次进入画面完全一致。
 * 边界：纯函数，无 React、无 Three 场景副作用——调用方负责把结果写入相机
 *       与 OrbitControls；本模块不持有任何相机状态。
 * 关键不变量：
 * 1. 俯视角恒为 45°：位置高度等于水平距离（atan2(y, 水平距) = 45°），方位
 *    角 45°（x/z 方向各偏移一半水平距离，避免完全轴向视角）；
 * 2. 距离按「包围盒四角在当前视口内的投影包络」计算（P0-1）：包围球把长方
 *    形地图当球包络，四周留出大量空气（地图高度占比仅 ~61%）；四角投影把
 *    每个角点变换到相机空间，取「恰好进入视锥」的最近距离并乘 10% 余量——
 *    16:9 视口下高度占比 ≥ 90%（宽度随之 ~72%）。该距离同时被钳制进
 *    [最小距离, 最大距离]，退化小地图（对角线极小）时保证最小距离 < 最大
 *    距离且机位不违反缩放限制；
 * 3. 最大距离恒为对角线 3 倍（SPEC §5.5），且永不允许小于最小距离——两者
 *    冲突时以「最小距离 + 间隔」抬高最大距离，OrbitConstraints 不会塌缩。
 */

/**
 * 相机允许的最近观察距离（米）。
 * 0.25m 相比原来的 2m 提供 8 倍近景放大能力，密集节点与相邻路径可被逐条
 * 检查；该值只限制到目标的径向距离，实际离地高度由相机地面约束另行保证，
 * 不能把这个距离下限当成防止穿地的充分条件。
 */
export const CAMERA_MIN_DISTANCE_M = 0.25

/**
 * 近景模式使用的透视相机近裁剪面（米）。
 * 该值需显著小于最近观察距离，否则继续放大时节点圆台和路径会先被裁掉。
 */
const CAMERA_NEAR_PLANE_M = 0.05

/** 俯瞰取景的包围余量系数：四角投影包络距离 × 该系数 = 10% 边缘呼吸空间 */
const OVERVIEW_FIT_MARGIN = 1.1

/** 退化小地图下最大距离与最小距离之间的保底间隔（米） */
const MIN_MAX_DISTANCE_GAP_M = 1

/** 俯瞰取景结果：调用方按字段写入透视相机与 OrbitControls */
export interface OverviewPose {
  /** 相机世界坐标 */
  readonly position: { readonly x: number; readonly y: number; readonly z: number }
  /** 注视目标（地图包围盒中心，地面高度 0） */
  readonly target: { readonly x: number; readonly z: number }
  readonly near: number
  readonly far: number
  readonly minDistance: number
  readonly maxDistance: number
}

/**
 * 计算俯瞰机位。
 * @param bounds 地图场景包围盒（世界坐标）；对角线 ≤ 0 时按 1m 退化处理
 * @param fovDeg 透视相机垂直视场角（度），取当前相机实际值
 * @param aspect 视口纵横比（宽/高，gl.domElement 实测值）——四角投影的
 *        水平视锥半角由它导出，缺失或非法时按 1 处理（纵深防御）
 */
export function computeOverviewPose(bounds: {
  readonly minWorldX: number
  readonly maxWorldX: number
  readonly minWorldZ: number
  readonly maxWorldZ: number
  readonly centerWorldX: number
  readonly centerWorldZ: number
  readonly diagonal: number
}, fovDeg: number, aspect: number): OverviewPose {
  const diagonal = Math.max(bounds.diagonal, 1)
  const minDistance = CAMERA_MIN_DISTANCE_M
  // SPEC §5.5：最大距离 = 对角线 3 倍；极小地图下保证仍大于最小距离
  const maxDistance = Math.max(
    diagonal * 3,
    minDistance + MIN_MAX_DISTANCE_GAP_M,
  )

  // 45° 俯角 + 45° 方位角的视线方向（单位向量；0.25+0.5+0.25 = 1）
  // 地图角点取地面高度 y=0，故基向量的 y 分量不参与点积，无需显式写出
  const dirX = 0.5
  const dirZ = 0.5
  // 相机空间基：right = normalize(dir × up)，camUp = right × dir（正交）
  const rightX = -Math.SQRT1_2
  const rightZ = Math.SQRT1_2
  const upX = -0.5
  const upZ = -0.5

  const tanHalfV = Math.tan((Math.max(fovDeg, 1) / 2) * (Math.PI / 180))
  const tanHalfH = tanHalfV * Math.max(aspect, 1e-3)

  // 四角（地面高度 y=0）逐一求「恰好进入视锥」的相机距离，取最大者：
  // 角点在相机空间为 (x·right + y·up + z·dir)，深度 = r·dir；约束为
  // |横坐标| ≤ tan(半视场角) × 深度 → 距离 ≥ |横坐标| / tan(半视场角) + 深度
  let fitDistance = 0
  for (const [cx, cz] of [
    [bounds.minWorldX, bounds.minWorldZ],
    [bounds.maxWorldX, bounds.minWorldZ],
    [bounds.minWorldX, bounds.maxWorldZ],
    [bounds.maxWorldX, bounds.maxWorldZ],
  ] as const) {
    const rx = cx - bounds.centerWorldX
    const rz = cz - bounds.centerWorldZ
    const camX = rx * rightX + rz * rightZ
    const camY = rx * upX + rz * upZ
    const depth = rx * dirX + rz * dirZ
    const needX = Math.abs(camX) / tanHalfH + depth
    const needY = Math.abs(camY) / tanHalfV + depth
    fitDistance = Math.max(fitDistance, needX, needY)
  }

  const distance = Math.min(
    Math.max(fitDistance * OVERVIEW_FIT_MARGIN, minDistance * 1.25),
    maxDistance,
  )
  // 45° 俯角 + 45° 方位角：水平距 = 垂直距 = distance/√2，x/z 各占水平距一半
  const vertical = distance / Math.SQRT2
  const horizontal = distance / Math.SQRT2
  return {
    position: {
      x: bounds.centerWorldX + horizontal / Math.SQRT2,
      y: vertical,
      z: bounds.centerWorldZ + horizontal / Math.SQRT2,
    },
    target: { x: bounds.centerWorldX, z: bounds.centerWorldZ },
    near: CAMERA_NEAR_PLANE_M,
    // 远平面覆盖最大距离余量，避免大地图远景被裁剪
    far: Math.max(diagonal * 6, 1000),
    minDistance,
    maxDistance,
  }
}
