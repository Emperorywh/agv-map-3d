/**
 * 地图场景视觉常量（SPEC §5.1、§5.4；TASK-004 核心地图 + TASK-005 语义图层）。
 *
 * 职责：集中定义静态地图对象（清屏底色、物理路径、充电桩/呼吸灯、
 *       停车地面标识、名称图集与名称四边形）与灯光环境的全部外观常量，供几
 *       何构建与图层组件共同引用，保证同一视觉语言只有一份事实源。
 * 边界：只包含数值与颜色常量，不创建任何 Three.js 对象、不含业务语义推导；
 *       车辆与标签外观属 fleet-monitoring 的 fleetAppearance。
 * 关键不变量：
 * 1. 图层高度阶梯（GRID_Y → ROAD_SURFACE_Y → ROAD_BOUNDARY_Y → ROAD_GUIDE_Y →
 *    NAME_QUAD_Y）单调递增且间隔足够小（厘米级）：静态贴花靠微小
 *    高度差避免 z-fighting，在米制地图尺度下肉眼不可见；
 * 2. 颜色语言沿用原型参考：青色 charge、紫色 park、灰色
 *    未知兜底（SPEC §2.1 默认表现）；
 * 3. 名称距离显隐（NEAR/FAR）为平滑过渡区间：近于 NEAR 全显、远于 FAR 全隐、
 *    之间线性淡出（地标名称的可见范围口径）。
 */

/**
 * 场景清屏底色（地图未就绪或失败重试期间页面保持的唯一颜色，SPEC §7.4）。
 * 与厂房灰色墙板共用色系，加载间隙和远处雾色不再回落到黑色。
 */
export const FACTORY_WALL_COLOR = '#bdc2c4'
export const MAP_CLEAR_COLOR = FACTORY_WALL_COLOR

/**
 * 室内只保留很弱的距离空气感，密度按厂房对角线归一化。
 * 雾色与墙板一致，保留远侧墙柱和设备轮廓，不向黑色背景衰减。
 */
export const SCENE_FOG_DENSITY_PER_DIAGONAL = 0.055

/** 图层高度阶梯（世界 y，单位米；见关键不变量 1） */
export const GRID_Y = 0.02
export const ROAD_SURFACE_Y = 0.045
export const ROAD_BOUNDARY_Y = 0.064
export const ROAD_GUIDE_Y = 0.068
export const ROAD_JUNCTION_Y = 0.074
/** 名称四边形：高于停车 slab、光晕与道路贴花的顶端，文字不被遮挡 */
export const NAME_QUAD_Y = 0.24

/* ==================== 道路与引导层 ====================
 * 宽度仅是展示包络，不代表调度车道宽度；所有路径均绘制路面与清晰引导线。
 * 灰蓝路面配连续白边，蓝色引导沿真实轨迹，不再使用黄色标线或方向箭头。
 */
export const ROAD_MAIN_WIDTH_M = 1.5
export const ROAD_BRANCH_WIDTH_M = 0.8
export const ROAD_BOUNDARY_WIDTH_M = 0.065
export const ROAD_MAIN_MIN_LENGTH_M = 12
export const ROAD_ACCESS_MAX_LENGTH_M = 3
export const ROAD_CONTINUATION_COS = Math.cos(Math.PI / 9)
export const ROAD_SURFACE_COLOR = '#465762'
export const ROAD_SURFACE_OPACITY = 0.32
export const ROAD_BOUNDARY_COLOR = '#e6edf0'
export const ROAD_GUIDE_COLOR = '#65b7db'
/**
 * 引导线统一加宽并提高透明度，不因路径分级在普通观察距离下消失。
 * 保持蓝色实线且不绘制箭头，原有调度方向仍由业务模型负责。
 */
export const ROAD_GUIDE_WIDTH_M = 0.065
export const ROAD_GUIDE_OPACITY = 0.9

/**
 * 关键路口以稀疏静态光点定位，不把全部调度节点铺成发光点阵。
 * 光晕保持在地面贴花高度。
 */
export const ROAD_JUNCTION_SPACING_M = 6
export const ROAD_JUNCTION_RADIUS_M = 0.34
export const ROAD_JUNCTION_COLOR = '#99ddf5'

/* ==================== 语义符号（充电柜闪电标识沿用的符号笔画口径） ====================
 * 符号使用原生几何，不依赖字体或纹理加载；微量抬升用于避开贴附面的深度冲突。 */

export const NODE_SYMBOL_STROKE = 0.13
export const NODE_SYMBOL_LIFT_M = 0.002

/**
 * 节点颜色表直接覆盖五种 type；普通节点为中性灰蓝，未知节点另行灰色兜底。
 * 保留既有站点配色，并由轮廓与图标补足不依赖颜色的语义识别。
 */
export const NODE_COLORS: Record<import('../model/types').NodeCategory, string> = {
  node: '#9cabb6',
  // work 青绿比原型降一档饱和度（P0-3/5.1）：总览下 3045 个高饱和圆盘喧宾夺主
  work: '#35948a',
  warehouse: '#e3cf7a',
  charge: '#31d9e8',
  park: '#b07af5',
  unknown: '#757c88',
}

/**
 * 主光配合顶部柔光形成清晰的受光面和阴影面，保持灰色设备的轮廓。
 * 只影响受光材质，名称和标签等自发光图层不受影响。
 */
export const DIRECTIONAL_LIGHT_INTENSITY = 1.8
/** 静态阴影相机按灯光空间地图四角包络后的扩展边距（车辆高度与贴图渗漏余量） */
export const LIGHT_SHADOW_MARGIN_M = 6
/** 默认阴影贴图分辨率（可被 config.renderer.shadowMapSize 覆盖，SPEC §5.4） */
export const DEFAULT_SHADOW_MAP_SIZE = 2048

/**
 * 顶部柔光、冷灰内墙和混凝土地面的反射色经预滤波生成环境光。
 * 暗部仍保留明度，车体与墙柱不再像置于黑色摄影棚中。
 */
export const ENVIRONMENT_ZENITH_COLOR = '#dce0e2'
export const ENVIRONMENT_HORIZON_COLOR = '#a4aaad'
export const ENVIRONMENT_GROUND_COLOR = '#8b9296'

/**
 * 背景使用接近厂房墙板的冷灰渐变，四角叠加轻暗角（P2-6）。
 * 常规机位由实体地坪和内墙填满画面，高位总览用背景衬托厂房外轮廓；
 * 暗角只提供轻微的聚焦感，避免浅灰背景下四角发灰蒙。
 */
export const BACKGROUND_TEXTURE_PX = 512
export const BACKGROUND_TOP_COLOR = '#c8cdcf'
export const BACKGROUND_BOTTOM_COLOR = FACTORY_WALL_COLOR
/** 四角暗角强度：角点颜色向黑压暗的比例（0 = 无暗角） */
export const BACKGROUND_VIGNETTE_STRENGTH = 0.12

/* ==================== TASK-005 地图业务语义图层 ==================== */

/**
 * 充电塔中心距停靠定位点两米，沿用既有设施布局和朝向停靠点的变换。
 * 这是展示层的米制退让距离；只移动设施，不改变调度节点与车辆上报位置。
 */
export const CHARGE_CABINET_OFFSET_M = 2

/**
 * 充电塔发光底环（P2-1/8.4）：贴地圆环叠加低频亮度脉冲。
 * 环径略大于塔基（塔身半径约 0.74m），落在地面光斑范围之内；总览下投影
 * 过小时整体淡出——59 处充电设施不变成排闪烁光源（与节点 LOD 同一策略），
 * 近景恢复呼吸感。环为无光照贴花，不进地坪倒影、不投影。
 */
export const CHARGE_RING_INNER_RADIUS_M = 0.85
export const CHARGE_RING_OUTER_RADIUS_M = 1.05
/** 底环抬升：略高于地面光斑（+0.006）避免共面闪烁 */
export const CHARGE_RING_LIFT_M = 0.007
export const CHARGE_RING_OPACITY = 0.32
/** 底环总览淡出区间（投影像素）：小于 start 开始淡出，end 以下完全隐藏 */
export const CHARGE_RING_FADE_START_PX = 8
export const CHARGE_RING_FADE_END_PX = 2.5
/** 底环脉冲：正弦周期（秒）与最暗亮度比例 */
export const CHARGE_RING_PULSE_PERIOD_S = 2.4
export const CHARGE_RING_PULSE_MIN_BRIGHTNESS = 0.35

/** 停车点 slab 足迹边长（紫色） */
export const PARK_PAD_SIZE_M = 1.4

/**
 * 停车点凸起 slab（P2-2/8.5）：紫色薄板抬升 3~5cm + 微光光晕（加法混合的
 * 外沿贴面），形态此前已对，属纯外观微调。
 */
export const PARK_SLAB_HEIGHT_M = 0.04
export const PARK_SLAB_OPACITY = 0.5
/** 光晕：slab 外沿放大比例、抬升高度与加法混合透明度（暗地面上的微光） */
export const PARK_SLAB_HALO_SIZE_RATIO = 1.35
export const PARK_SLAB_HALO_LIFT_M = 0.006
export const PARK_SLAB_HALO_OPACITY = 0.14

/** 名称图集：字体大小/族、单元内边距、画布宽度与高度上限（2 的幂，保证 mipmap）
 *  字体 96px：图集现仅服务停车 P 字形（P0-5 移除仓库名称后），字形四边形世界
 *  高 1m，低分辨率源图放大后描边糊成深色块——96px 保证近景 P 清锐可读 */
export const MAP_NAME_FONT_PX = 96
export const MAP_NAME_FONT_FAMILY =
  '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif'
export const MAP_NAME_PADDING_PX = 6
export const MAP_NAME_CANVAS_WIDTH = 4096
export const MAP_NAME_CANVAS_MAX_HEIGHT = 4096

/** 名称文字颜色：停车符号白色（紫色 slab 之上） */
export const PARK_GLYPH_COLOR = '#ffffff'
/** 名称描边颜色：深色底图上保证任意底色可读 */
export const NAME_STROKE_COLOR = 'rgba(8, 10, 14, 0.9)'

/** 名称四边形世界高度（米）：宽度 = 单元宽高比 × 高度，随文字长度自适应 */
export const PARK_GLYPH_HEIGHT_M = 1.0

/**
 * 停车字形沿 +z 的锚点偏移（米）：字形四边形以停车点为中心平铺时，默认
 * 45° 机位下 slab 会遮住字形主体。+z 朝向默认可读侧，偏移 0.2m 让白色 P
 * 完整露在 slab 前半幅（slab 足迹 ±0.7m，字形 z ∈ [−0.3, +0.7]）。
 */
export const PARK_GLYPH_OFFSET_Z_M = 0.2

/**
 * 地标名称距离显隐区间（米）：近于 near 全显，远于 far 隐藏。
 * 视觉差距分析 P0-5：仓库节点名称已整体移除（Reference 无仓库名称文字，
 * 1185 个名称在中景形成文字海）；区间现服务于停车符号等地标名称。
 */
export const LANDMARK_NAME_FADE_NEAR_M = 30
export const LANDMARK_NAME_FADE_FAR_M = 70

/* ==================== 程序化地坪（地面平面 + Canvas 程序纹理） ====================
 * 浅灰涂层工业地坪以柔光和模糊倒影形成层次，保留低对比磨损与结构分缝。
 * 纹理只提供微观变化，接触明暗和场景反射由地坪材质独立处理。
 * 纹理按世界尺寸平铺（一张贴图覆盖 GROUND_TEXTURE_TILE_M 米），不整图拉伸；
 * 地面细节刻意保持低对比，不与车辆和路线抢视觉重心。
 */

/**
 * 地坪表面高度：略低于 y=0（充电光环、停车 slab 底面、车轮接地点所在高度）。
 * 亚厘米偏移在米制地图尺度下不可见，同时保证既有贴花不与地面共面 z-fight。
 */
export const GROUND_SURFACE_Y = -0.008

/** 程序纹理边长（px，2 的幂保证 mipmap）与整张贴图覆盖的世界尺寸（米） */
export const GROUND_TEXTURE_PX = 1024
export const GROUND_TEXTURE_TILE_M = 12
/** 地坪分缝间距（米）：实际车间接缝尺度；纹理内画 2×2 缝格，降低颗粒重复感 */
export const GROUND_SEAM_SPACING_M = 6

/**
 * 浅灰抛光涂层保持轻微冷色，明度与室内灯光一起校准。
 * 纯色回退使用同一底色，降低画质时也保持地坪的整体材质方向。
 */
export const GROUND_BASE_COLOR = '#adb5ba'
export const GROUND_FALLBACK_COLOR = '#adb5ba'
/** 斑驳明暗两色：与底色同色系、低对比，叠出「深浅变化」而非花斑 */
export const GROUND_MOTTLE_LIGHT_COLOR = '#b0b6ba'
export const GROUND_MOTTLE_DARK_COLOR = '#929b9f'
/** 大尺度云斑 + 中尺度色块各画两遍（明/暗），数量为每遍的渐变个数 */
export const GROUND_MOTTLE_LARGE_COUNT = 26
export const GROUND_MOTTLE_MID_COUNT = 90
/** 渐变半径占纹理边长的比例区间与不透明度上限（径向渐变衰变到 0） */
export const GROUND_MOTTLE_RADIUS_MIN_RATIO = 0.03
export const GROUND_MOTTLE_RADIUS_MAX_RATIO = 0.32
/**
 * 抛光涂层只保留极轻的底色起伏，避免重复云斑形成水泥灰雾。
 * 颗粒、磨损与分缝同时减弱，把层次主要交给物体倒影。
 */
export const GROUND_MOTTLE_ALPHA = 0.003

/** 细颗粒：1px 明暗斑点数量与不透明度上限（近看是混凝土骨料，远看融为灰面） */
export const GROUND_GRAIN_COUNT = 24000
export const GROUND_GRAIN_ALPHA = 0.006
/** 稀疏较大深色磨损点：数量与不透明度上限 */
export const GROUND_SPECK_COUNT = 1400
export const GROUND_SPECK_ALPHA = 0.006
/** 磨损划痕：数量、长度占边长比例区间与不透明度上限（明暗随机：抛亮/积灰） */
export const GROUND_SCUFF_COUNT = 46
export const GROUND_SCUFF_LENGTH_MIN_RATIO = 0.05
export const GROUND_SCUFF_LENGTH_MAX_RATIO = 0.16
export const GROUND_SCUFF_ALPHA = 0.004

/** 接缝：缝宽（px）与暗缝/外侧受光亮边的不透明度 */
export const GROUND_SEAM_WIDTH_PX = 1
export const GROUND_SEAM_DARK_COLOR = '#262b31'
/**
 * 接缝保持建筑尺度，但只在近处隐约可见。
 * 降低亮边，避免浅色地坪出现规则的网格感。
 */
export const GROUND_SEAM_DARK_ALPHA = 0.025
export const GROUND_SEAM_LIGHT_ALPHA = 0.008

/**
 * 粗糙度直接存入贴图灰度，材质乘子保持一。
 * 平滑涂层提供干净高光，实体倒影的柔化由反射纹理独立控制。
 */
export const GROUND_ROUGHNESS_BASE = 0.18
export const GROUND_ROUGHNESS_VARIATION = 0.006
/** 凹凸强度（接缝下陷 + 颗粒微起伏；bumpMap 灰度即相对高度） */
/**
 * 封闭涂层近似平整，微观凹凸不应在远景形成细碎条纹。
 * 保留极小起伏，避免改变既有纹理资源和释放流程。
 */
export const GROUND_BUMP_SCALE = 0.00004

/**
 * 涂层地坪保持非金属材质，环境强度控制顶部柔光。
 * 实体倒影由独立的平面反射补充，关闭反射时仍保留标准材质受光。
 */
export const GROUND_METALNESS = 0
export const GROUND_ENV_INTENSITY = 0.7

/** 各向异性过滤上限：掠射角下接缝与颗粒不糊（实际取 renderer 能力的较小值） */
export const GROUND_TEXTURE_MAX_ANISOTROPY = 8

/** 程序纹理的固定随机种子：同版本视觉稳定，刷新与重建不复现随机差异 */
export const GROUND_TEXTURE_SEED = 20260904

/**
 * 地面图层的最高世界高度：标线、停车贴花和名称贴花都属于地面包络。
 * 相机离地保护使用真实渲染高度，而不是假设所有图层都落在 y=0；充电桩等
 * 竖直地标不属于这个包络，避免它们限制整张地图的近景观察。
 */
export const MAP_GROUND_TOP_Y = Math.max(
  GRID_Y,
  ROAD_SURFACE_Y,
  ROAD_BOUNDARY_Y,
  ROAD_GUIDE_Y,
  ROAD_JUNCTION_Y,
  PARK_SLAB_HEIGHT_M + PARK_SLAB_HALO_LIFT_M,
  NAME_QUAD_Y,
)
