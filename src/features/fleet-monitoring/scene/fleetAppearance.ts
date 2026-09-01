/**
 * 车辆场景视觉常量（SPEC §2.6、§5.2、§5.4、§7.3；TASK-010）。
 *
 * 职责：集中定义程序化通用 AGV 的全部外观常量——各部件的固定尺寸与颜色、
 *       主状态 → 车体色的映射表、警示灯旋转/闪烁参数、车底假阴影参数——供
 *       几何构建与帧同步层共同引用，保证车辆视觉语言只有一份事实源。
 * 边界：只包含数值与颜色常量及纯映射表，不创建任何 Three.js 对象；地图侧
 *       静态外观属 map-visualization 的 mapAppearance，车辆标签与光环常量
 *       待 TASK-011/012 在本模块扩展。
 * 关键不变量：
 * 1. 主状态色映射覆盖 VehiclePrimaryDisplayState 全部取值且次序与投影规则
 *    一致：STALE 冻结灰、DISCONNECTED 深灰、FRESH 业务色（SPEC §2.6）；
 *    状态不得只靠颜色表达——方向由 +x 方向楔表达、故障由旋转警示灯表达，
 *    文字徽标与光环属后续 Task；
 * 2. 充电色与地图 charge 节点同色系（#31d9e8），执行色与 work 节点同色系，
 *    保持全场景色彩语义统一；
 * 3. 部件固定高度为厘米级经验值（与当前车宽 0.7m 量级协调），不随车辆
 *    长宽缩放——每车尺寸只进入矩阵的 x/z 分量；
 * 4. 警示灯只在 FAULT（FRESH + ONLINE）时旋转闪烁；OFFLINE/STALE 熄灭
 *    （SPEC §5.2），熄灭用零缩放矩阵表达（不存在 instanceColor.a）。
 */

/** 图层高度：车辆贴花 lowest 优先级低于地图名称层，假阴影贴地避免 z-fighting */
export const VEHICLE_SHADOW_Y = 0.012

/** 车底假阴影：比车体略大的半透明椭圆贴片（不使用真实投影，SPEC §5.2） */
export const VEHICLE_SHADOW_LENGTH_RATIO = 1.25
export const VEHICLE_SHADOW_WIDTH_RATIO = 1.7
export const VEHICLE_SHADOW_COLOR = '#000000'
export const VEHICLE_SHADOW_OPACITY = 0.35

/** 底盘：全车长宽 × 固定高度，离地间隙之上（深灰金属） */
export const CHASSIS_CLEARANCE_M = 0.03
export const CHASSIS_HEIGHT_M = 0.05
export const CHASSIS_COLOR = '#2b3038'
export const CHASSIS_METALNESS = 0.55
export const CHASSIS_ROUGHNESS = 0.45

/** 外壳：车体主体，高度固定，长度 = 车长 − 方向楔长（颜色来自主状态） */
export const SHELL_HEIGHT_M = 0.16
export const SHELL_WIDTH_RATIO = 0.96
/** SPEC §5.4 推荐：车体 MeshStandardMaterial metalness≈0.2、roughness≈0.6 */
export const SHELL_METALNESS = 0.2
export const SHELL_ROUGHNESS = 0.6

/** 方向楔：占车长比例（钳制到绝对范围），明确 +x 车头方向 */
export const WEDGE_LENGTH_RATIO = 0.22
export const WEDGE_MIN_LENGTH_M = 0.12
export const WEDGE_MAX_LENGTH_M = 0.5
/** 楔色为主状态色乘以该亮度系数：同色系但更暗，保持一体感 */
export const WEDGE_COLOR_BRIGHTNESS = 0.72

/** 载荷平台（loaded 时显示）：厚度固定，footprint 用 loadLength/loadWidth */
export const PLATFORM_THICKNESS_M = 0.03
export const PLATFORM_COLOR = '#565e6a'
/** 通用托盘（loaded 时显示）：比平台略小的木色块 */
export const PALLET_HEIGHT_M = 0.07
export const PALLET_LENGTH_RATIO = 0.8
export const PALLET_WIDTH_RATIO = 0.8
export const PALLET_COLOR = '#8a6b42'

/** 警示灯：穹顶 + 旋转扫掠叶片的一体信标（真实尺寸，不随车体缩放） */
export const BEACON_DOME_RADIUS_M = 0.055
export const BEACON_DOME_HEIGHT_M = 0.07
export const BEACON_BLADE_LENGTH_M = 0.16
export const BEACON_BLADE_THICKNESS_M = 0.02
export const BEACON_MOUNT_CLEARANCE_M = 0.04
/** FAULT 旋转角速度（弧度/秒）与闪烁频率（Hz）：肉眼明确的旋转+闪烁 */
export const BEACON_SPIN_RAD_PER_S = 4.5
export const BEACON_BLINK_HZ = 1.6
/** 闪烁亮度下限（占比）：最暗时仍可辨认为红色信标 */
export const BEACON_BLINK_MIN_BRIGHTNESS = 0.25
export const BEACON_FAULT_COLOR = '#ff2d2d'
/** 熄灭色仅用于诊断调试参考；熄灭表达为零缩放矩阵（不变量 4） */
export const BEACON_OFF_COLOR = '#3a3f47'

/**
 * 主状态 → 车体基础色（SPEC §2.6 投影顺序）：
 * STALE 冻结灰 > DISCONNECTED 深灰 > FRESH 业务状态色。
 */
export const SHELL_STATE_COLORS: Record<string, string> = {
  // FRESH 业务操作状态
  FAULT: '#e5484d',
  PAUSED: '#c084fc',
  CHARGING: '#31d9e8',
  TRAFFIC_WAIT: '#f5a524',
  EXECUTING: '#3fbf6f',
  IDLE: '#4f8dff',
  UNKNOWN: '#9aa1ac',
  // 数据不可信投影（最后业务状态只作副徽标，属 TASK-011 标签）
  STALE: '#6f7680',
  DISCONNECTED: '#3f444d',
}

/** 取主状态对应的车体色；未知键回退 UNKNOWN 灰（纵深防御） */
export function shellColorOf(primary: string): string {
  return SHELL_STATE_COLORS[primary] ?? SHELL_STATE_COLORS.UNKNOWN
}
