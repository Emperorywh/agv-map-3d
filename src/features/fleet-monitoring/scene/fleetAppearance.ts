/**
 * 车辆场景视觉常量（SPEC §2.6、§5.1～§5.4、§6.4、§7.2、§7.3；TASK-010/011）。
 *
 * 职责：集中定义程序化通用 AGV 的全部外观常量——各部件的固定尺寸与颜色、
 *       主状态 → 车体色的映射表、警示灯旋转/闪烁参数、车底假阴影参数、车辆
 *       标签的尺寸、LOD 投影阈值、重点标签上限与边框配色——供几何构建、图
 *       集与材质共同引用，保证车辆视觉语言只有一份事实源。
 * 边界：只包含数值与颜色常量及纯映射表，不创建任何 Three.js 对象；地图侧
 *       静态外观属 map-visualization 的 mapAppearance。
 * 关键不变量：
 * 1. 主状态色映射覆盖 VehiclePrimaryDisplayState 全部取值且次序与投影规则
 *    一致：STALE 冻结灰、DISCONNECTED 深灰、FRESH 业务色（SPEC §2.6）；
 *    状态不得只靠颜色表达——方向由 +x 方向楔表达、故障由旋转警示灯表达、
 *    文字由图集化标签表达（TASK-011）；
 * 2. 车辆灯带、地面投光与标签共用业务指定的状态配色，
 *    未指定的在线、连接中断与数据未知状态沿用现有颜色；
 * 3. 部件固定高度为厘米级经验值（与当前车宽 0.7m 量级协调），不随车辆
 *    长宽缩放——每车尺寸只进入矩阵的 x/z 分量；
 * 4. 警示灯只在 FAULT（FRESH + ONLINE）时旋转闪烁；OFFLINE/STALE 熄灭
 *    （SPEC §5.2），熄灭用零缩放矩阵表达（不存在 instanceColor.a）；
 * 5. 标签保留原有投影阈值与重点上限，可见面板统一显示两行摘要，
 *    远景最多二十个重点标签（优先级截断属 labelLod）；
 * 6. 标签边框配色（选中蓝 / L1 黄 / L2 红）为告警语义在标签内的表达口径；
 *    透明贴花按 renderOrder 分层：假阴影(0.012) → 标签(10/11)，互不 z-fight。
 */

import type { VehiclePrimaryDisplayState } from '../model/types'

/** 图层高度：车辆贴花 lowest 优先级低于地图名称层，假阴影贴地避免 z-fighting */
export const VEHICLE_SHADOW_Y = 0.012

/** 车底假阴影：比车体略大的半透明椭圆贴片（不使用真实投影，SPEC §5.2） */
export const VEHICLE_SHADOW_LENGTH_RATIO = 1.25
export const VEHICLE_SHADOW_WIDTH_RATIO = 1.7
export const VEHICLE_SHADOW_COLOR = '#000000'
export const VEHICLE_SHADOW_OPACITY = 0.35

/**
 * 底盘：全车长宽 × 固定高度，离地间隙之上（深灰金属）。
 * P1-6「深色底围」：0.05 → 0.09——加高的深色底盘带在深色外壳（状态色）下方
 * 形成可见的暗色基座，对齐 Reference「深色底盘 + 饱和色外壳」的双色比例，
 * 不新增部件（底围 = 底盘本体）。
 */
export const CHASSIS_CLEARANCE_M = 0.03
export const CHASSIS_HEIGHT_M = 0.09
export const CHASSIS_COLOR = '#2b3038'
export const CHASSIS_METALNESS = 0.55
export const CHASSIS_ROUGHNESS = 0.45

/** 车轮（P1-6）：真实尺寸固定（同信标的「不随车体缩放」模式），
 *  四只合并为一份几何；布局只给中心与 1:1:1 缩放。 */
export const WHEEL_RADIUS_M = 0.06
export const WHEEL_THICKNESS_M = 0.045
/** 轮距：沿车长方向 ±0.5m（1.8m 基准车的 0.55 倍轴距）、车宽方向 ±0.28m */
export const WHEEL_OFFSET_X_M = 0.5
export const WHEEL_OFFSET_Z_M = 0.28
export const WHEEL_COLOR = '#15181d'
export const WHEEL_METALNESS = 0.4
export const WHEEL_ROUGHNESS = 0.7

/** 外壳：车体主体，高度固定，长度 = 车长 − 方向楔长（颜色来自主状态） */
export const SHELL_HEIGHT_M = 0.16
export const SHELL_WIDTH_RATIO = 0.96
/** SPEC §5.4 推荐：车体 MeshStandardMaterial metalness≈0.2、roughness≈0.6 */
export const SHELL_METALNESS = 0.2
export const SHELL_ROUGHNESS = 0.6

/**
 * 方向箭头（P2-7，前「方向楔」）：占车长比例（钳制到绝对范围），明确 +x
 * 车头方向；几何为带尾部凹口的细长箭头棱柱（俯视「➤」轮廓）。
 */
export const WEDGE_LENGTH_RATIO = 0.22
export const WEDGE_MIN_LENGTH_M = 0.12
export const WEDGE_MAX_LENGTH_M = 0.5
/** 箭头色为主状态色乘以该亮度系数：同色系但更暗，保持一体感（P2-7 起作用于箭头形） */
export const WEDGE_COLOR_BRIGHTNESS = 0.72

/** 载荷平台（loaded 时显示）：厚度固定，footprint 用 loadLength/loadWidth */
export const PLATFORM_THICKNESS_M = 0.03
export const PLATFORM_COLOR = '#565e6a'
/** 通用托盘（loaded 时显示）：比平台略小的木色块 */
export const PALLET_HEIGHT_M = 0.07
export const PALLET_LENGTH_RATIO = 0.8
export const PALLET_WIDTH_RATIO = 0.8
export const PALLET_COLOR = '#8a6b42'

/**
 * 载货纸箱（P1-6，loaded 时显示）：托盘之上叠两只不同高度的纸箱色小盒
 * （一份合并几何，footprint 随载荷尺寸缩放、堆叠高度固定）。
 */
export const CARGO_STACK_HEIGHT_M = 0.16
export const CARGO_LENGTH_RATIO = 0.8
export const CARGO_WIDTH_RATIO = 0.8
export const CARGO_COLOR = '#c09a66'
export const CARGO_METALNESS = 0.0
export const CARGO_ROUGHNESS = 0.9

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
/** 熄灭色仅用于诊断调试参考；熄灭表达为零缩放矩阵（不变量 4） */
export const BEACON_OFF_COLOR = '#3a3f47'

/**
 * 按业务提供的色值配置状态灯，内部派生状态映射到对应的 RobotStatus。
 * 大灯、地面光斑与标签共用此表，历史名称保留以兼容现有调用点。
 */
export const SHELL_STATE_COLORS: Record<VehiclePrimaryDisplayState, string> = {
  // FRESH 业务操作状态
  FAULT: '#590016',
  ONLINE: '#4aa3ff',
  AVOIDING: '#FBC02D',
  BRAKED: '#FF0000',
  PAUSED: '#38D2D2',
  CHARGING: '#C8C81A',
  TRAFFIC_WAIT: '#9F7AEA',
  EXECUTING: '#48BB78',
  IDLE: '#4299E1',
  UNKNOWN: '#9aa1ac',
  // 数据不可信投影（最后业务状态只作副徽标，属 TASK-011 标签）
  STALE: '#6f7680',
  DISCONNECTED: '#98A2B2',
  CONNECTION_BROKEN: '#98a9d8',
}

/**
 * 故障信标直接复用异常状态色，避免与同车大灯、地面投光出现色彩分歧。
 * 保留既有闪烁节奏，仅让配色跟随统一的业务颜色表。
 */
export const BEACON_FAULT_COLOR = SHELL_STATE_COLORS.FAULT

/**
 * 状态色查表只接受自身属性，未知键继续回退灰色。
 * 保留字符串入口供既有标签与预览使用，不让对象原型属性混入颜色。
 */
export function shellColorOf(primary: string): string {
  return Object.hasOwn(SHELL_STATE_COLORS, primary)
    ? SHELL_STATE_COLORS[primary as VehiclePrimaryDisplayState] : SHELL_STATE_COLORS.UNKNOWN
}

/**
 * 状态文字与配色共用主状态键，近景标签使用中文辅助识别相近色系。
 * 离线与连接中断独立命名，过期继续作为数据可信度提示保留。
 */
export const VEHICLE_STATE_LABELS: Record<VehiclePrimaryDisplayState, string> = {
  ONLINE: '在线', IDLE: '空闲', TRAFFIC_WAIT: '交管', EXECUTING: '执行中',
  CHARGING: '充电', AVOIDING: '避障', FAULT: '异常', BRAKED: '抱闸',
  DISCONNECTED: '离线', CONNECTION_BROKEN: '连接中断', PAUSED: '暂停',
  STALE: '数据过期', UNKNOWN: '未知',
}

/* ==================== 车辆标签外观（SPEC §5.1、§6.4、§7.2；TASK-011） ==================== */

/**
 * 参考图采用两行悬浮面板，宽高比为二比一，宽度保持接近默认车长。
 * 增加的高度容纳车辆编号、电量条和速度，图集单元同步使用相同比例。
 */
export const LABEL_HEIGHT_M = 0.96
export const LABEL_ASPECT = 2
/** 标签世界宽度：由名称单元宽高比推出（帧同步与测试共用同一事实源） */
export const LABEL_WIDTH_M = LABEL_HEIGHT_M * LABEL_ASPECT
/**
 * 标签锚点高于工业平台、托盘和纸箱顶面，避免载货时遮住箱体。
 * 屏幕尺寸由帧同步层限制，靠近车辆也不会出现巨幅标签。
 */
export const LABEL_ANCHOR_Y_M = 1.3

/**
 * 浅白半透明底板搭配蓝色信息，贴近参考图的轻量悬浮效果。
 * 状态圆点仍取真实业务颜色，正常电量条与文字共用蓝色。
 */
export const LABEL_BACKGROUND_COLOR = '#f3f6ff'
export const LABEL_TEXT_COLOR = '#395cc7'
/** 状态圆点几何（P0-6，标签背景 shader 内 SDF 绘制，颜色取 aStateColor）：
 *  圆心/半径以标签 UV 表达——u 为宽度分量（0..1，全宽 = 高度的 ASPECT 倍），
 *  v 为高度分量（0..1）；半径按高度计，绘制时 u 距离乘 ASPECT 还原等比圆。 */
export const LABEL_STATE_DOT_CENTER_U = 0.89
export const LABEL_STATE_DOT_CENTER_V = 0.76
export const LABEL_STATE_DOT_RADIUS_V = 0.062

/**
 * 保留原有八像素、二十像素投影分档，供可见性优先级使用。
 * 可见面板统一展示双行信息；低于八像素仍只保留重点车辆。
 */
export const LABEL_NAME_MIN_PX = 8
export const LABEL_FULL_MIN_PX = 20
/** 远景重点标签上限：按优先级截断，最多 20 个（SPEC §6.4） */
export const LABEL_IMPORTANT_MAX = 20

/**
 * 浅色面板选中时显示蓝色边框，告警继续使用黄色和红色。
 * 电量条颜色按电量档位在 shader 内取值（同阈值常量）。
 */
export const LABEL_BORDER_SELECTED_COLOR = '#5275ec'
export const LABEL_BORDER_L1_COLOR = '#ffd21e'
export const LABEL_BORDER_L2_COLOR = '#ff2d2d'

/**
 * 正常电量使用参考图的蓝色，低电量仍按原有阈值使用黄、红提示。
 * 保留电量语义，避免视觉调整掩盖需要关注的车辆。
 */
export const LABEL_BATTERY_OK_COLOR = '#4169e8'
export const LABEL_BATTERY_LOW_COLOR = '#f5a524'
export const LABEL_BATTERY_CRITICAL_COLOR = '#ff2d2d'

/**
 * 标签字体栈：与地图名称同一族（中文可用）。字体常量在 fleet-monitoring 内
 * 独立声明——map-visualization 的 mapAppearance 属另一 Feature 的内部模块，
 * 跨 Feature 只允许公开入口导入（SPEC §12.2），此处不做深层引用。
 */
export const LABEL_FONT_FAMILY =
  '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif'
