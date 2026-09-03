/**
 * 地图场景视觉常量（SPEC §5.1、§5.4；TASK-004 核心地图 + TASK-005 语义图层）。
 *
 * 职责：集中定义静态地图对象（清屏底色、工业地坪、网格刻线、物理路径、节点
 *       站点、充电桩/呼吸灯、仓库与停车地面标识、独占区蓝色外沿、名称图集与
 *       名称四边形）与灯光环境的全部外观常量，供几何构建与图层组件共同引用，
 *       保证同一视觉语言只有一份事实源。
 * 边界：只包含数值与颜色常量，不创建任何 Three.js 对象、不含业务语义推导；
 *       车辆、标签与光环外观属 fleet-monitoring 的 fleetAppearance。
 * 关键不变量：
 * 1. 图层高度阶梯（GROUND_Y → GRID_Y → EXCLUSIVE_OUTLINE_Y → EXCLUSIVE_FILL_Y →
 *    PATH_SURFACE_Y → PATH_CENTERLINE_Y → LANDMARK_PAD_Y →
 *    NODE_Y → NAME_QUAD_Y）单调递增且
 *    间隔足够小（厘米级）：静态贴花靠微小高度差避免 z-fighting，在米制地图
 *    尺度下肉眼不可见；独占区外沿位于路面之下，只露出比路面宽出的边缘；
 * 2. 颜色语言沿用原型参考：深色工业地坪、深灰路径、蓝绿 work 站点、浅黄仓库、
 *    青色 charge、紫色 park、灰色未知兜底（SPEC §2.1 默认表现）；独占区为
 *    低透明度蓝色（SPEC §2.3）；
 * 3. 尺度链保持「路 > 车 > 节点」的包含关系（视觉差距分析 P0-3）：路面宽度
 *    ≥ 2× 车宽（0.7m），节点直径 ≤ 路宽的 1/3——节点是嵌在路口里的小圆点，
 *    不随缩放变化；
 * 4. 名称距离显隐（NEAR/FAR）为平滑过渡区间：近于 NEAR 全显、远于 FAR 全隐、
 *    之间线性淡出，独占区名称比地标名称可见范围更大（SPEC §2.3 远距离隐藏）。
 */

/**
 * 场景清屏底色（地图未就绪或失败重试期间页面保持的唯一颜色，SPEC §7.4）。
 * P1-1：提亮至 Reference 色域（Reference 实测 #161b22，取 #14181f 保持
 * 「路面 > 地面 > 背景」的明度阶梯），消除纯黑背景把地坪衬成孤岛的观感。
 */
export const MAP_CLEAR_COLOR = '#14181f'

/** 工业地坪颜色与粗糙度（MeshStandardMaterial，接收阴影）。
 *  P1-1：#16191f → #1e232b，对齐 Reference 地面 #242931 的深灰蓝档位，
 *  让深灰路面重新「浮」在地面上。 */
export const GROUND_COLOR = '#1e232b'
export const GROUND_ROUGHNESS = 0.95
export const GROUND_METALNESS = 0.05

/**
 * 地面按地图包围盒向四周扩展的边距（P1-3：10m → 90m）。271m 的地图只留
 * 10m 边距时地坪边缘入画形成「黑色孤岛」；实机验证 50m 在 16:9 总览下
 * 菱形四角仍露背景，90m 使地坪边缘在总览取景下整体出画，残余边界由雾融
 * 进背景色。
 */
export const GROUND_MARGIN_M = 90

/* ==================== 工业地坪贴图（P1-2，替代 5m 方格刻线） ====================
 * 此前 5m LineBasicMaterial 刻线在总览呈「方格纸」、近景却因 1px 不可见。
 * 改为一张 5m 平铺 Canvas 贴图（1m 细线 + 5m 分缝，均为低对比乘色）：
 * 总览下 mipmap 均化为近纯色不再喧宾夺主，近景露出细密工业地坪纹理。 */
/** 贴图一格对应的世界尺寸（米）：一格 = 5m 分缝包围 5×5 个 1m 细线格 */
export const GROUND_TILE_M = 5
/** 贴图分辨率（像素/格，2 的幂）：1px ≈ 2cm，足够表达细线 */
export const GROUND_TILE_TEXTURE_PX = 256
/** 细线间隔（米）：1m 细刻线 */
export const GROUND_FINE_LINE_SPACING_M = 1
/** 细线亮度乘数（×地坪色）：与地面明度差 ≤ 8%，低对比不抢戏 */
export const GROUND_FINE_LINE_STRENGTH = 0.93
/** 5m 分缝亮度乘数：比细线深一档，表达工业地坪的分块 */
export const GROUND_SEAM_STRENGTH = 0.86

/**
 * 场景雾（P1-3）：FogExp2 密度 = 该系数 / 地图对角线（当前 ≈ 0.00092/m）。
 * 雾色 = 清屏底色，总览距离（450~800m）下远处地面渐隐进背景（远角雾因子
 * ~40%、近缘 ~16%），配合 90m 地坪边距彻底消除「黑色孤岛」；近景
 * （< 100m）雾因子 < 1%，无感知。
 */
export const SCENE_FOG_DENSITY_PER_DIAGONAL = 0.25

/** 图层高度阶梯（世界 y，单位米；见关键不变量 1） */
export const GROUND_Y = 0
export const GRID_Y = 0.02
/** 独占区蓝色外沿：位于路面之下、网格之上，只露出宽出路面的边缘 */
export const EXCLUSIVE_OUTLINE_Y = 0.03
/** 独占区半透明面填充（P1-7）：略高于外沿、路面之下，整块区域着色 */
export const EXCLUSIVE_FILL_Y = 0.035
export const PATH_SURFACE_Y = 0.04
export const PATH_CENTERLINE_Y = 0.06
/** 仓库/停车地面标识方垫：略低于节点圆盘，让节点圆点叠在垫面之上 */
export const LANDMARK_PAD_Y = 0.07
export const NODE_Y = 0.08
/** 名称四边形：略高于节点圆盘，保证文字不被节点或垫面遮挡 */
export const NAME_QUAD_Y = 0.09

/**
 * 物理路径路面条带宽度与颜色（深灰路面，Unlit 双面保证任意绕序可见）。
 * 宽度 ≥ 2× 车宽（0.7m，视觉差距分析 P0-3）：恢复「路 > 车 > 节点」尺度链，
 * 让路面读作「面」而不是连接节点的「线」。
 */
export const PATH_SURFACE_WIDTH_M = 1.8
/** 路面中心色（P1-4：#363c45 → #3f444d，随方向光降档提亮，贴回 Reference 档位） */
export const PATH_SURFACE_COLOR = '#3f444d'
/** 路径中线颜色（比路面略亮的细线，引导视觉） */
export const PATH_CENTERLINE_COLOR = '#4b525c'

/* ==================== 虚线中线（P1-4） ====================
 * Reference 的道路以「路面与地面的明度对比」形成铺装板边界（路面明显比地
 * 面亮），无需额外描边——路缘暗色边线方案实机验证后放弃：路口处各路径的
 * 边线相互交叉或断头，形成杂乱的花瓣轮廓，收益不抵成本。P1-4 保留虚线中
 * 线（1m 实 0.6m 空）与路面提亮（#363c45 → #3f444d）。 */
/** 中线虚线：实段与空段长度（米） */
export const CENTERLINE_DASH_ON_M = 1.0
export const CENTERLINE_DASH_OFF_M = 0.6

/**
 * 节点站点圆盘半径与离散段数（一个 InstancedMesh 渲染全部节点，SPEC §5.1）。
 * 半径 ≤ 0.5× 半路宽（P0-3）：节点是嵌在路口里的小圆点；段数 20 保证近景
 * 圆形轮廓可辨（12 段的多边形边缘在近景明显）。
 */
export const NODE_RADIUS_M = 0.25
export const NODE_CIRCLE_SEGMENTS = 20

/**
 * 节点暗描边（P2-3/5.1）：盘外一圈几何内环（宽度 + 暗色顶点色），Reference 的
 * 节点有清晰的「嵌 into 路面」轮廓。描边颜色 = 实例色 × 该亮度乘数（顶点色与
 * 实例颜色在着色器中相乘）——保持节点色相的深描边比纯黑更协调。
 */
export const NODE_OUTLINE_WIDTH_M = 0.04
export const NODE_OUTLINE_STRENGTH = 0.22

/**
 * 节点屏幕尺寸淡出（P1-5/2.3 的 shader LOD）：投影直径 < start 逐帧变透明、
 * < end 完全消失。总览距离下单个节点盘投影 < 4px，4291 个圆盘叠加成发光
 * 点毯盖住路网骨架；淡出后总览回归路网，近景（投影 > 10px）不受影响。
 * 纯 GPU 实现（顶点着色器推导投影尺寸），不触碰静态实例缓冲。
 */
export const NODE_FADE_START_PX = 3.5
export const NODE_FADE_END_PX = 1.5

/** 节点颜色表：按归一类别取色，unknown 使用灰色通用兜底（SPEC §2.1） */
export const NODE_COLORS: Record<'work' | 'warehouse' | 'charge' | 'park' | 'unknown', string> = {
  // work 青绿比原型降一档饱和度（P0-3/5.1）：总览下 3045 个高饱和圆盘喧宾夺主
  work: '#35948a',
  warehouse: '#e3cf7a',
  charge: '#31d9e8',
  park: '#b07af5',
  unknown: '#757c88',
}

/** 方向光强度与环境贴图强度（P0-7：2.2 过曝把受光车体色洗白，降档回血；
 *  只影响受光材质，节点/标签/路面等 Unlit 层不受影响；exposure 不动） */
export const DIRECTIONAL_LIGHT_INTENSITY = 1.2
/** 静态阴影相机按灯光空间地图四角包络后的扩展边距（车辆高度与贴图渗漏余量） */
export const LIGHT_SHADOW_MARGIN_M = 6
/** 默认阴影贴图分辨率（可被 config.renderer.shadowMapSize 覆盖，SPEC §5.4） */
export const DEFAULT_SHADOW_MAP_SIZE = 2048

/**
 * 自定义渐变环境（P2-5/9.4）：替代 RoomEnvironment 的「棚拍灯箱」感——
 * 大球面顶点色渐变（天顶冷白 → 地平灰蓝 → 天底深灰蓝）经 PMREM 预滤波为
 * IBL。整体亮度低于灯箱环境，受光车体色的饱和度回血（P1 遗留的「车体偏
 * 浅」即源于 IBL 过亮）；模糊半径 0.04 沿用（工业地坪不需要锐利反射）。
 */
export const ENVIRONMENT_ZENITH_COLOR = '#c9d7e8'
export const ENVIRONMENT_HORIZON_COLOR = '#3a4250'
export const ENVIRONMENT_GROUND_COLOR = '#161a21'

/**
 * 页面背景渐变与暗角（P2-6）：Canvas 生成的屏幕空间背景纹理（顶部冷灰蓝 →
 * 底部更深、四角暗角），替代纯色清屏，提供 Reference 的聚焦感。Canvas 不可
 * 用（无头测试环境）时降级为 MAP_CLEAR_COLOR 纯色；雾色仍为清屏底色——雾
 * 把远处地面渐隐进背景中间档，暗角只压屏幕边缘。
 */
export const BACKGROUND_TEXTURE_PX = 512
export const BACKGROUND_TOP_COLOR = '#181d26'
export const BACKGROUND_BOTTOM_COLOR = '#10141b'
/** 四角暗角强度：角点颜色向黑压暗的比例（0 = 无暗角） */
export const BACKGROUND_VIGNETTE_STRENGTH = 0.3

/* ==================== TASK-005 地图业务语义图层 ==================== */

/**
 * 独占区蓝色外沿条带总宽度：比路面（1.8m）宽出蓝色边缘（SPEC §2.3），
 * 路面加宽后同步放大，保证每侧露出 ~0.3m 的可见蓝边。
 */
export const EXCLUSIVE_OUTLINE_WIDTH_M = 2.4
export const EXCLUSIVE_OUTLINE_COLOR = '#4f8dff'
/** 低透明度：外沿只是空间提示，不得遮蔽路面与节点（SPEC §2.3） */
export const EXCLUSIVE_OUTLINE_OPACITY = 0.3

/**
 * 独占区半透明面填充（P1-7/8.1 路线 2）：成员物理路径采样点的凸包多边形，
 * 沿边外扩 padding 后整块填充。当前地图的独占区均为细长走廊形（48×6m 等），
 * 凸包与真实路网形状高度贴合；填充位于路面之下（EXCLUSIVE_FILL_Y），路面
 * 保持不透明覆盖，Reference 观感为「半透明蓝色区域 + 亮色描边」。
 */
export const EXCLUSIVE_FILL_COLOR = '#37465e'
export const EXCLUSIVE_FILL_OPACITY = 0.5
export const EXCLUSIVE_FILL_PADDING_M = 1.2

/** 充电桩立柱尺寸（宽×深×高，米）与颜色（青色，与 charge 节点同色系） */
export const CHARGE_PILE_WIDTH_M = 0.4
export const CHARGE_PILE_DEPTH_M = 0.28
export const CHARGE_PILE_HEIGHT_M = 0.9
export const CHARGE_PILE_COLOR = '#2fd3e2'

/** 充电桩底部光环：内半径略小于节点圆盘（r=0.25），外半径露出青色圆环 */
export const CHARGE_RING_INNER_M = 0.3
export const CHARGE_RING_OUTER_M = 0.6
export const CHARGE_RING_COLOR = '#31d9e8'
export const CHARGE_RING_OPACITY = 0.4

/** 低频呼吸灯：灯球直径、呼吸周期（秒）与最暗亮度（装饰动画可整体关闭） */
export const CHARGE_LIGHT_SIZE_M = 0.16
export const CHARGE_LIGHT_PERIOD_S = 2.4
export const CHARGE_LIGHT_MIN_BRIGHTNESS = 0.25
export const CHARGE_LIGHT_COLOR = '#5cf0ff'

/* ==================== 充电桩表达增强（P2-1/8.4） ==================== */

/**
 * 桩身闪电贴花（P2-1）：单格 Canvas 图集 + 桩身四面贴花四边形。方形贴花、
 * 柱面外扩间距防 z-fighting；Canvas 不可用（无头测试环境）时贴花整体降级
 * 为不创建（缺贴花不缺充电桩语义）。
 */
export const CHARGE_BOLT_CELL_PX = 128
export const CHARGE_BOLT_HEIGHT_M = 0.34
export const CHARGE_BOLT_COLOR = '#8df6ff'
export const CHARGE_BOLT_FACE_OFFSET_M = 0.006

/**
 * 充电元素总览 LOD（P2-1/8.4）：59 处充电桩的立柱/光环/贴花在总览成排发光
 * 抢戏，与节点 LOD（P1-5）同款 shader 淡出——按「立柱高度」的投影尺寸在
 * [end, start] 像素区间平滑淡出，桩/环/贴花同步隐现保持语义成组。
 */
export const CHARGE_FADE_START_PX = 7
export const CHARGE_FADE_END_PX = 2.5

/** 底环脉冲（P2-1）：与呼吸灯同周期随动呼吸，最暗亮度高于灯球（环是弱陪衬） */
export const CHARGE_RING_PULSE_MIN_BRIGHTNESS = 0.55

/** 仓库地面标识方垫边长（浅黄），贴地平面（透明度与停车共用旧档位口径） */
export const WAREHOUSE_PAD_SIZE_M = 1.1
/** 停车点 slab 足迹边长（紫色）：与旧方垫一致，形态由凸起与光晕增强（P2-2） */
export const PARK_PAD_SIZE_M = 1.4
export const LANDMARK_PAD_OPACITY = 0.32

/**
 * 停车点凸起 slab（P2-2/8.5）：紫色薄板抬升 3~5cm + 微光光晕（加法混合的
 * 外沿贴面），形态此前已对，属纯外观微调；仓库方垫保持贴地平面不变。
 */
export const PARK_SLAB_HEIGHT_M = 0.04
export const PARK_SLAB_OPACITY = 0.5
/** 光晕：slab 外沿放大比例、抬升高度与加法混合透明度（暗地面上的微光） */
export const PARK_SLAB_HALO_SIZE_RATIO = 1.35
export const PARK_SLAB_HALO_LIFT_M = 0.006
export const PARK_SLAB_HALO_OPACITY = 0.14

/** 名称图集：字体大小/族、单元内边距、画布宽度与高度上限（2 的幂，保证 mipmap） */
export const MAP_NAME_FONT_PX = 20
export const MAP_NAME_FONT_FAMILY =
  '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif'
export const MAP_NAME_PADDING_PX = 6
export const MAP_NAME_CANVAS_WIDTH = 4096
export const MAP_NAME_CANVAS_MAX_HEIGHT = 4096

/** 名称文字颜色：独占区浅蓝、停车符号白色（紫色方垫之上） */
export const GROUP_NAME_COLOR = '#7db2ff'
export const PARK_GLYPH_COLOR = '#ffffff'
/** 名称描边颜色：深色底图上保证任意底色可读 */
export const NAME_STROKE_COLOR = 'rgba(8, 10, 14, 0.9)'

/** 名称四边形世界高度（米）：宽度 = 单元宽高比 × 高度，随文字长度自适应 */
export const GROUP_NAME_HEIGHT_M = 1.6
export const PARK_GLYPH_HEIGHT_M = 0.8

/**
 * 地标名称距离显隐区间（米）：近于 near 全显，远于 far 隐藏。
 * 视觉差距分析 P0-5：仓库节点名称已整体移除（Reference 无仓库名称文字，
 * 1185 个名称在中景形成文字海）；区间现服务于停车符号等地标名称。
 */
export const LANDMARK_NAME_FADE_NEAR_M = 30
export const LANDMARK_NAME_FADE_FAR_M = 70
/** 独占区名称距离显隐区间：分组名称语义层级更高，可见范围更大 */
export const GROUP_NAME_FADE_NEAR_M = 40
export const GROUP_NAME_FADE_FAR_M = 90
