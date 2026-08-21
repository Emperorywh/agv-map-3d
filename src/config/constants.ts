/**
 * 尺寸 / 阈值常量（SPEC §5.2 / §6 / §7 / §8 / §9）的唯一存放处。
 * 本文件为骨架：随后续任务（建筑、ribbon、模拟器、相机）落地按需扩展。
 * config 为叶子层，不依赖任何其他层。
 */

// ---- 建筑外壳（SPEC §5.2），单位：米 ----
/** 建筑包围盒相对地图包围盒四周的外扩边距 */
export const FACTORY_MARGIN = 8
/** 外墙高度 */
export const WALL_HEIGHT = 6
/** 立柱阵列柱距 */
export const COLUMN_SPACING = 12

// ---- 地图渲染（SPEC §6.2），单位：米 ----
/** 走廊 ribbon 宽度 */
export const RIBBON_WIDTH = 1.5
/** ribbon 抬升高度（防 z-fighting） */
export const RIBBON_LIFT = 0.02
/** BEZIER 自适应细分弦高差容差 */
export const BEZIER_TOLERANCE = 0.05

// ---- AGV（SPEC §7）----
/** AGV 车体尺寸：宽 × 深（叉车示意比例） */
export const AGV_BODY_WIDTH = 1.6
export const AGV_BODY_DEPTH = 1.0
/** 默认模拟 AGV 数量（上限按 100 设计） */
export const AGV_DEFAULT_COUNT = 20
/** 倒车速度相对正向的系数 */
export const AGV_BACK_SPEED_FACTOR = 0.5

// ---- 电量模型（SPEC §7.1，纯模拟值）----
/** 低电量阈值（百分比） */
export const BATTERY_LOW_THRESHOLD = 20
/** 行驶耗电（百分比 / 米） */
export const BATTERY_DRAIN_PER_METER = 0.05
/** 充电恢复（百分比 / 秒） */
export const BATTERY_CHARGE_PER_SECOND = 2

// ---- 相机（SPEC §8.1）----
/** Orbit 极角限制（弧度）：防穿地 / 防翻转 */
export const CAMERA_POLAR_MIN_RAD = (5 * Math.PI) / 180
export const CAMERA_POLAR_MAX_RAD = (85 * Math.PI) / 180
/** Orbit 距离限制（米） */
export const CAMERA_DISTANCE_MIN = 5
export const CAMERA_DISTANCE_MAX = 400
/** 模式切换过渡时长（秒） */
export const CAMERA_TRANSITION_SECONDS = 0.5

// ---- 遮挡（SPEC §5.5）----
/** 立柱自动淡出的相机俯角阈值（弧度） */
export const COLUMN_FADE_PITCH_RAD = (60 * Math.PI) / 180

// ---- 性能（SPEC §9）----
/** 渲染分辨率 DPR 封顶 */
export const MAX_DEVICE_PIXEL_RATIO = 2
