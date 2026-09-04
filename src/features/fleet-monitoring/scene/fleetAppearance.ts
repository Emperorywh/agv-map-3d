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
 * 2. 充电色与地图 charge 节点同色系（#31d9e8），执行色与 work 节点同色系，
 *    保持全场景色彩语义统一；
 * 3. 部件固定高度为厘米级经验值（与当前车宽 0.7m 量级协调），不随车辆
 *    长宽缩放——每车尺寸只进入矩阵的 x/z 分量；
 * 4. 警示灯只在 FAULT（FRESH + ONLINE）时旋转闪烁；OFFLINE/STALE 熄灭
 *    （SPEC §5.2），熄灭用零缩放矩阵表达（不存在 instanceColor.a）；
 * 5. 标签 LOD 阈值与重点上限来自 SPEC §6.4：投影 ≥8px 显示名称、≥20px 增加
 *    电量条与完整状态，远景最多 20 个重点标签（优先级截断属 labelLod）；
 * 6. 标签边框配色（选中白 / L1 黄 / L2 红）为告警语义在标签内的表达口径；
 *    透明贴花按 renderOrder 分层：假阴影(0.012) → 标签(10/11)，互不 z-fight。
 */

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
export const BEACON_FAULT_COLOR = '#ff2d2d'
/** 熄灭色仅用于诊断调试参考；熄灭表达为零缩放矩阵（不变量 4） */
export const BEACON_OFF_COLOR = '#3a3f47'

/**
 * 主状态只作用于局部指示灯和标签，浅灰车壳不再消费这份颜色表。
 * 继续保留过期灰、离线深灰和故障红的投影语义，普通运行采用蓝绿色。
 */
export const SHELL_STATE_COLORS: Record<string, string> = {
  // FRESH 业务操作状态
  FAULT: '#e5484d',
  PAUSED: '#c084fc',
  CHARGING: '#31d9e8',
  TRAFFIC_WAIT: '#f5a524',
  EXECUTING: '#10b8a7',
  IDLE: '#538d9a',
  UNKNOWN: '#9aa1ac',
  // 数据不可信投影（最后业务状态只作副徽标，属 TASK-011 标签）
  STALE: '#6f7680',
  DISCONNECTED: '#3f444d',
}

/** 取主状态对应的车体色；未知键回退 UNKNOWN 灰（纵深防御） */
export function shellColorOf(primary: string): string {
  return SHELL_STATE_COLORS[primary] ?? SHELL_STATE_COLORS.UNKNOWN
}

/* ==================== 车辆标签外观（SPEC §5.1、§6.4、§7.2；TASK-011） ==================== */

/**
 * 标签四边形世界尺寸：高度固定，宽度 = 高度 × 名称单元宽高比（256×64 = 4:1）。
 * 标签锚点高于车顶与警示灯（约 0.25m），近景不遮挡车体主体。
 * 高度 0.48（P0-6）：宽度 1.92m = 默认车长 1.8m 的 1.07×，对齐 Reference 的
 * 「芯片宽 ≈ 车长 1.1×」（v1 曾建议 0.6 → 过度裁剪文字可读性）。
 */
export const LABEL_HEIGHT_M = 0.48
export const LABEL_ASPECT = 4
/** 标签世界宽度：由名称单元宽高比推出（帧同步与测试共用同一事实源） */
export const LABEL_WIDTH_M = LABEL_HEIGHT_M * LABEL_ASPECT
/**
 * 标签锚点高于工业平台、托盘和纸箱顶面，避免载货时遮住箱体。
 * 屏幕尺寸由帧同步层限制，靠近车辆也不会出现巨幅标签。
 */
export const LABEL_ANCHOR_Y_M = 1.0

/**
 * 标签背景底色（P0-6）：Reference 为深灰黑底 + 白色 ID + 左上角状态色小圆点
 * + 底部电量条——状态信息由「点」承载，不由「底」承载；此前背景取
 * 状态色 × 0.72，60 台 IDLE 车形成 60 个亮蓝芯片群落。
 */
export const LABEL_BACKGROUND_COLOR = '#1a1f26'
/** 状态圆点几何（P0-6，标签背景 shader 内 SDF 绘制，颜色取 aStateColor）：
 *  圆心/半径以标签 UV 表达——u 为宽度分量（0..1，全宽 = 高度的 ASPECT 倍），
 *  v 为高度分量（0..1）；半径按高度计，绘制时 u 距离乘 ASPECT 还原等比圆。 */
export const LABEL_STATE_DOT_CENTER_U = 0.04
export const LABEL_STATE_DOT_CENTER_V = 0.78
export const LABEL_STATE_DOT_RADIUS_V = 0.055

/**
 * LOD 投影阈值（SPEC §6.4，边界含）：车体投影长度 ≥8px 显示全部名称，
 * ≥20px 增加电量条和完整状态芯片；低于 8px 仅重点车可见（远景）。
 */
export const LABEL_NAME_MIN_PX = 8
export const LABEL_FULL_MIN_PX = 20
/** 远景重点标签上限：按优先级截断，最多 20 个（SPEC §6.4） */
export const LABEL_IMPORTANT_MAX = 20

/**
 * 标签边框配色（SPEC §7.3 的标签内表达）：选中白、L1 黄、L2 红。
 * 电量条颜色按电量档位在 shader 内取值（同阈值常量）。
 */
export const LABEL_BORDER_SELECTED_COLOR = '#ffffff'
export const LABEL_BORDER_L1_COLOR = '#ffd21e'
export const LABEL_BORDER_L2_COLOR = '#ff2d2d'

/** 电量条颜色：与告警阈值同口径（<15 红、[15,30) 黄、≥30 绿） */
export const LABEL_BATTERY_OK_COLOR = '#3fbf6f'
export const LABEL_BATTERY_LOW_COLOR = '#f5a524'
export const LABEL_BATTERY_CRITICAL_COLOR = '#ff2d2d'

/**
 * 标签字体栈：与地图名称同一族（中文可用）。字体常量在 fleet-monitoring 内
 * 独立声明——map-visualization 的 mapAppearance 属另一 Feature 的内部模块，
 * 跨 Feature 只允许公开入口导入（SPEC §12.2），此处不做深层引用。
 */
export const LABEL_FONT_FAMILY =
  '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif'
