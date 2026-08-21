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
/** ribbon 拐角 miter 长度上限（相对半宽的倍数，防脱节） */
export const RIBBON_MITER_LIMIT = 2
/** 虚线标识（倒车方向边缘 / 单向 back 整条）实段长 / 间隔 / 线宽 */
export const RIBBON_DASH_LENGTH = 0.6
export const RIBBON_DASH_GAP = 0.4
export const RIBBON_DASH_WIDTH = 0.12
/** 虚线与箭头相对 ribbon 表面的附加抬升（防同网格内重叠 z-fighting） */
export const RIBBON_OVERLAY_LIFT = 0.005
/** 单向走廊箭头沿弧长的布置间距（短于间距的走廊至少 1 个） */
export const CORRIDOR_ARROW_SPACING = 8
/** 单向箭头尺寸：长 × 宽 */
export const CORRIDOR_ARROW_LENGTH = 0.9
export const CORRIDOR_ARROW_WIDTH = 0.6
/** 静态地图几何分帧构建：每帧处理的走廊数（SPEC §4.4 避免长任务） */
export const MAP_GEOMETRY_CHUNK_SIZE = 512

// ---- 走廊配对（SPEC §6.1），单位：米 ----
/** 配对边几何偏差阈值：超过则取较短者渲染并 console 警告计数 */
export const CORRIDOR_GEOMETRY_TOLERANCE = 0.3

// ---- 节点渲染（SPEC §6.3），单位：米；尺寸层级 work > charge > park > node ----
/** work 方形台：边长 / 高（最大、最醒目） */
export const NODE_WORK_PLATFORM_SIZE = 1.4
export const NODE_WORK_PLATFORM_HEIGHT = 0.26
/** work 图标色块：边长 / 高（位于方台顶面之上，俯视呈 45° 菱形） */
export const NODE_WORK_ICON_SIZE = 0.8
export const NODE_WORK_ICON_HEIGHT = 0.22
/** charge 六边形台：外接圆半径 / 高（大） */
export const NODE_CHARGE_RADIUS = 0.62
export const NODE_CHARGE_HEIGHT = 0.2
/** park 中小圆点：半径 / 高 */
export const NODE_PARK_RADIUS = 0.3
export const NODE_PARK_HEIGHT = 0.12
/** node 小圆点：半径 / 高（最小） */
export const NODE_NAV_RADIUS = 0.15
export const NODE_NAV_HEIGHT = 0.07
/** node 类整类隐藏的相机距离阈值：相机距关注点超过该值时整类隐藏（常量可调） */
export const NODE_NAV_HIDE_DISTANCE = 150
/** 节点材质轻微 emissive 强度（schematic 高饱和 + 轻微 emissive，SPEC §5.1） */
export const NODE_EMISSIVE_INTENSITY = 0.35

// ---- 标签（SPEC §6.4），单位：米 / 像素 ----
/** 标签字高（世界单位，米）：quad 高度，字符宽度按字形宽高比换算 */
export const LABEL_FONT_WORLD_HEIGHT = 1.0
/** 标签锚点离地高度（标签 quad 中心的 y 坐标，浮于节点造型之上） */
export const LABEL_ANCHOR_HEIGHT = 0.8
/** 图集单元格边长（像素）：每个去重字符占一格 */
export const LABEL_ATLAS_CELL_SIZE = 64
/** 图集格内绘制字号（像素，格内留白防 mipmap 渗色） */
export const LABEL_ATLAS_FONT_SIZE = 52
/** 图集绘制字体族（需覆盖中文） */
export const LABEL_FONT_FAMILY = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif'
/** 图集纹理边长上限（像素，2 的幂；超出容量的字符截断并警告计数，SPEC §10） */
export const LABEL_ATLAS_MAX_SIZE = 2048
/**
 * 透视模式距离分级（相机 → 关注点距离，米）：按标签等级 [关键 work/charge, park, node]
 * 各等级的最大可见距离——> 80m 全部隐藏；20~80m 仅 work/charge；≤ 20m 全部显示。
 */
export const LABEL_PERSPECTIVE_MAX_DISTANCE: readonly [number, number, number] = [80, 20, 20]
/**
 * 正交俯视视野宽度分级（米）：各等级最大可见视野宽度——视野 > 160m 仅 work/charge；
 * 60~160m 加 park；≤ 60m 全部显示。等级 0 不限宽（Infinity），保证全图俯视关键标签可读。
 */
export const LABEL_ORTHO_MAX_VIEW_WIDTH: readonly [number, number, number] = [
  Number.POSITIVE_INFINITY,
  160,
  60,
]

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
