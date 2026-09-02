/**
 * 俯瞰自动取景数学（SPEC §5.5「初始机位按地图包围盒自动取景，俯视角约
 * 45°」；TASK-013）。
 *
 * 职责：由地图场景包围盒与相机视场角计算唯一确定的俯瞰机位——位置、注视
 *       目标、近远平面与缩放距离限制；空格俯瞰（SPEC §8）与初始取景共用
 *       同一数学，保证「回地图包围盒中心」与首次进入画面完全一致。
 * 边界：纯函数，无 React、无 Three 场景副作用——调用方负责把结果写入相机
 *       与 OrbitControls；本模块不持有任何相机状态。
 * 关键不变量：
 * 1. 俯视角恒为 45°：位置高度等于水平距离（atan2(y, 水平距) = 45°），方位
 *    角 45°（x/z 方向各偏移一半水平距离，避免完全轴向视角）；
 * 2. 距离按垂直视场角包络包围球：distance ≥ (对角线/2) / tan(fov/2)，再乘
 *    少量余量；该距离同时被钳制进 [最小距离, 最大距离]，退化小地图（对角
 *    线极小）时保证最小距离 < 最大距离且机位不违反缩放限制；
 * 3. 最大距离恒为对角线 3 倍（SPEC §5.5），且永不允许小于最小距离——两者
 *    冲突时以「最小距离 + 间隔」抬高最大距离，OrbitConstraints 不会塌缩。
 */

/** 相机允许的最近距离（米，SPEC §5.5） */
export const CAMERA_MIN_DISTANCE_M = 2

/** 俯瞰取景的包围余量系数：包络距离 × 该系数，留出边缘呼吸空间 */
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
 */
export function computeOverviewPose(bounds: {
  readonly centerWorldX: number
  readonly centerWorldZ: number
  readonly diagonal: number
}, fovDeg: number): OverviewPose {
  const diagonal = Math.max(bounds.diagonal, 1)
  const minDistance = CAMERA_MIN_DISTANCE_M
  // SPEC §5.5：最大距离 = 对角线 3 倍；极小地图下保证仍大于最小距离
  const maxDistance = Math.max(
    diagonal * 3,
    minDistance + MIN_MAX_DISTANCE_GAP_M,
  )
  // 垂直视场包络包围球：半对角线 / tan(半视场角)，再留余量
  const halfFovRad = (Math.max(fovDeg, 1) / 2) * (Math.PI / 180)
  const fitDistance = (diagonal / 2) / Math.tan(halfFovRad)
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
    near: 0.5,
    // 远平面覆盖最大距离余量，避免大地图远景被裁剪
    far: Math.max(diagonal * 6, 1000),
    minDistance,
    maxDistance,
  }
}
