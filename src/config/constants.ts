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
/** 立柱方形截面边长（柱高同外墙 WALL_HEIGHT） */
export const COLUMN_SIZE = 0.4
/**
 * 柱位避让阈值：候选柱位与走廊中心线距离小于该值则不放置
 * （已含 ribbon 半宽 RIBBON_WIDTH/2 与柱截面余量，保证立柱不压在通道上）
 */
export const COLUMN_CORRIDOR_CLEARANCE = 2
/** 地坪浅网格刻线间距 */
export const FLOOR_GRID_STEP = 10
/** 网格刻线抬升高度（低于 ribbon 的 RIBBON_LIFT，防与地坪 z-fighting） */
export const FLOOR_GRID_LIFT = 0.01
/** 天窗带：带宽 / 带间距（带中心到带中心）/ 相对外墙的内缩 */
export const SKYLIGHT_STRIP_WIDTH = 3
export const SKYLIGHT_STRIP_SPACING = 12
export const SKYLIGHT_EDGE_INSET = 6
/** 天窗带相对屋顶面的抬升（防同面 z-fighting） */
export const SKYLIGHT_LIFT = 0.02

// ---- 内部元素（SPEC §5.3），单位：米 ----
/** 货架 / 工作台放置采样网格单元边长（候选点取单元中心，中心对齐单元边长整数倍） */
export const SHELF_CELL_SIZE = 2.4
/**
 * 放置阈值：候选点与最近走廊中心线距离大于该值才放置（SPEC §5.3；
 * 已含 ribbon 半宽 RIBBON_WIDTH/2 与货架半深余量，保证货架不压通道并留出 aisle）
 */
export const SHELF_CORRIDOR_CLEARANCE = 3
/** 货架 / 工作台相对外墙的内缩（不贴墙、不挡卷帘门） */
export const SHELF_WALL_INSET = 1.6
/** 货架 / 工作台与卷帘门中心的最小间距（留出斑马线与进出空间） */
export const SHELF_DOOR_CLEARANCE = 4.5
/** 货架 / 工作台与 charge 节点的最小间距（不压充电位色块与充电桩） */
export const SHELF_CHARGE_CLEARANCE = 3.2
/** 成排布置的最短连续单元数（短于该数的零散候选不成排、不放置） */
export const SHELF_MIN_RUN_CELLS = 3
/** 货架排尺寸：深 / 高（排长度 = 连续单元数 × 单元边长），低多边形方盒 */
export const SHELF_ROW_DEPTH = 1.1
export const SHELF_ROW_HEIGHT = 1.9
/** 工作台排尺寸：深 / 高 */
export const WORKBENCH_ROW_DEPTH = 1.2
export const WORKBENCH_ROW_HEIGHT = 0.85

/** 充电桩相对 charge 节点的侧向偏移（沿节点 angle 朝向的左侧，SPEC §5.3 节点旁） */
export const CHARGE_PILE_OFFSET = 1.6
/** 充电桩占位体尺寸：宽 × 高 × 深（与 public/assets/charging-pile.gltf 一致） */
export const CHARGING_PILE_WIDTH = 0.44
export const CHARGING_PILE_HEIGHT = 1.33
export const CHARGING_PILE_DEPTH = 0.3
/** 地面充电位色块尺寸：长（沿节点 angle）× 宽 */
export const CHARGE_SPOT_LENGTH = 2.4
export const CHARGE_SPOT_WIDTH = 1.8
/** 装卸区色块尺寸（work 节点，方形，随节点 angle 旋转） */
export const LOADING_AREA_SIZE = 2.2
/** 区域色块抬升（充电位 / 装卸区常压在通道上，须高于 ribbon 及其 overlay 0.025） */
export const AREA_BLOCK_LIFT = 0.03
/** 区域色块不透明度（半透明色洗，不盖死通道底色） */
export const AREA_BLOCK_OPACITY = 0.4

/** 通道两侧边缘线：相对 ribbon 边缘的外扩间隙 / 线宽 */
export const LANE_LINE_GAP = 0.04
export const LANE_LINE_WIDTH = 0.08
/** 地面标线抬升（边缘线 / 斑马线贴地坪：高于网格刻线 0.01、低于 ribbon 0.02，防 z-fighting） */
export const MARKING_LIFT = 0.015

/** 吊灯阵列（SPEC §5.3 仅发光体）：灯距 / 相对外墙内缩 / 自屋檐下垂距离 / 灯盘半径 / 厚度 */
export const CHANDELIER_SPACING = 12
export const CHANDELIER_EDGE_INSET = 3
export const CHANDELIER_DROP = 0.8
export const CHANDELIER_RADIUS = 0.5
export const CHANDELIER_THICKNESS = 0.12

/** 卷帘门（SPEC §5.2 外墙长边各 2 扇、固定关闭）：门洞净宽 / 净高 */
export const ROLLER_DOOR_WIDTH = 3
export const ROLLER_DOOR_HEIGHT = 3
/** 卷帘门沿长边的布置位置（相对侧长的比例，每条长边 2 处） */
export const ROLLER_DOOR_FRACTIONS: readonly number[] = [0.25, 0.75]
/** 门框截面：立柱宽 / 横梁高 / 前后进深（与 public/assets/roller-door-frame.gltf 一致） */
export const ROLLER_DOOR_POST_SIZE = 0.2
export const ROLLER_DOOR_BEAM_HEIGHT = 0.3
export const ROLLER_DOOR_FRAME_DEPTH = 0.3
/** 门框相对墙面的内缩（门框背面不贴墙，防 z-fighting） */
export const ROLLER_DOOR_INSET = 0.16
/** 固定关闭门扇板：厚度 / 横肋沿高度间距 / 肋条凸出面板的高度 */
export const ROLLER_DOOR_PANEL_THICKNESS = 0.05
export const ROLLER_DOOR_RIB_SPACING = 0.3
export const ROLLER_DOOR_RIB_HEIGHT = 0.06
/** 卷帘门内侧斑马线：条宽 / 间隔 / 条数 / 首条距墙内缩；条长同门洞净宽 */
export const ZEBRA_STRIPE_WIDTH = 0.35
export const ZEBRA_STRIPE_GAP = 0.25
export const ZEBRA_STRIPE_COUNT = 5
export const ZEBRA_START_INSET = 0.3

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

// ---- AGV（SPEC §7），单位：米 ----
/** AGV 车体 footprint：长（沿车头方向，本地 +Z）× 宽（叉车示意比例，SPEC §7.3 / §15.4） */
export const AGV_BODY_LENGTH = 1.6
export const AGV_BODY_WIDTH = 1.0
/** 模拟台数上限（SPEC §7.1 上限按 100 设计；实例容量按实际台数分配，该值仅为规模约束） */
export const AGV_MAX_COUNT = 100
/** 默认模拟 AGV 数量 */
export const AGV_DEFAULT_COUNT = 20
/** 倒车速度相对正向的系数 */
export const AGV_BACK_SPEED_FACTOR = 0.5
/** 底盘高度（底面贴地 y=0） */
export const AGV_CHASSIS_HEIGHT = 0.18
/** 顶盖尺寸：长（沿车头方向）× 宽 × 高；中心略偏车尾 */
export const AGV_COVER_LENGTH = 1.0
export const AGV_COVER_WIDTH = 0.7
export const AGV_COVER_HEIGHT = 0.24
/** 顶盖中心向车尾（本地 -Z）的偏移 */
export const AGV_COVER_REAR_OFFSET = 0.1
/** 方向楔形（车头斜楔，薄边指向本地 +Z 车头）：长 × 宽 × 高 */
export const AGV_WEDGE_LENGTH = 0.5
export const AGV_WEDGE_WIDTH = 0.7
export const AGV_WEDGE_HEIGHT = 0.22
/** 前灯尺寸：宽 × 高 × 深（成对，略凸出车头端面） */
export const AGV_HEADLIGHT_WIDTH = 0.14
export const AGV_HEADLIGHT_HEIGHT = 0.08
export const AGV_HEADLIGHT_DEPTH = 0.05
/** 前灯横向安装位置（距车体中线）与安装高度 */
export const AGV_HEADLIGHT_INSET = 0.32
export const AGV_HEADLIGHT_LIFT = 0.1
/** 顶部状态色环（SPEC §7.3 实例色）：半径 / 管径 / 环底相对顶盖顶面的抬升 */
export const AGV_STATUS_RING_RADIUS = 0.3
export const AGV_STATUS_RING_TUBE = 0.045
export const AGV_STATUS_RING_LIFT = 0.04
/** 编号标签（复用 SPEC §6.4 图集批渲染）：世界字高 / 锚点离地高度（浮于车体与色环之上） */
export const AGV_LABEL_FONT_HEIGHT = 0.55
export const AGV_LABEL_ANCHOR_HEIGHT = 1.05

// ---- 电量模型（SPEC §7.1，纯模拟值）----
/** 低电量阈值（百分比） */
export const BATTERY_LOW_THRESHOLD = 20
/** 行驶耗电（百分比 / 米） */
export const BATTERY_DRAIN_PER_METER = 0.05
/** 充电恢复（百分比 / 秒） */
export const BATTERY_CHARGE_PER_SECOND = 2

// ---- 模拟器（SPEC §7.1 / §7.2，注入 domain 层模拟器的应用层取值）----
/** 模拟器随机种子（SPEC §15.5 种子常量，调试时可固定；同一种子行为完全可复现） */
export const SIM_SEED = 20260821
/** 装卸停留时长（秒，SPEC §7.1 停留 N 秒） */
export const SIM_LOAD_UNLOAD_SECONDS = 3
/** IDLE 决策重试间隔（秒）：无空闲充电位 / 规划失败后的重试冷却 */
export const SIM_IDLE_RETRY_SECONDS = 1
/** 固定仿真步长（秒）：渲染循环以 1/60s 累积器驱动 stepSimulator，帧间隔大时多步（SPEC §7.1 与帧率解耦） */
export const SIM_FIXED_DT = 1 / 60
/** 单帧最大仿真推进时长（秒）：钳制帧间隔，防后台标签页恢复后长时间追帧（漏走的时间直接丢弃） */
export const SIM_MAX_FRAME_DELTA = 0.25
/** AGV 快照写入 store 的低频周期（秒）：面板低频节流读取（SPEC §9），每帧路径不进 store */
export const SIM_SNAPSHOT_INTERVAL = 0.5
/** 路径规划权重模式（SPEC §7.1 二选一常量切换）：'lengthOverSpeed' = 边长/限速；'cost' = 直接 cost */
export const SIM_GRAPH_WEIGHT_MODE: 'lengthOverSpeed' | 'cost' = 'lengthOverSpeed'
/**
 * 边限速 / 加速度 / 角速度字段为 null 时的缺省值（SPEC §7.2 缺省兜底；
 * 实测 2984/3043 条边速度字段为 null、旋转速度全为 null，兜底为必需）
 */
export const SIM_DEFAULT_MAX_SPEED = 2
export const SIM_DEFAULT_ACCELERATION = 0.8
export const SIM_DEFAULT_DECELERATION = 1.2
/** 原地旋转缺省角速度（rad/s） */
export const SIM_DEFAULT_ROTATION_SPEED = Math.PI / 2

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

// ---- 光照与阴影（SPEC §5.3 / §9：1 盏平行光 + 半球光，≤1024 shadow map）----
/** 半球光强度（环境基调光，不产生阴影） */
export const HEMISPHERE_LIGHT_INTENSITY = 0.9
/** 主平行光强度（唯一投影光源） */
export const DIRECTIONAL_LIGHT_INTENSITY = 1.2
/**
 * 主平行光方向（自场景中心指向光源的向量，不要求单位长度，由渲染层归一化）：
 * 方位 +x +z、仰角约 53°——阳光侧外墙把阴影带投进室内地坪，示意建筑体量。
 */
export const DIRECTIONAL_LIGHT_DIRECTION: readonly [number, number, number] = [2, 3, 1]
/** 主平行光 shadow map 边长（SPEC §9 预算：≤1024） */
export const SHADOW_MAP_SIZE = 1024
