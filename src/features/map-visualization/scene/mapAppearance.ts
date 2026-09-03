/**
 * 地图场景视觉常量（SPEC §5.1、§5.4；TASK-004 核心地图 + TASK-005 语义图层）。
 *
 * 职责：集中定义静态地图对象（清屏底色、物理路径、节点站点、充电桩/呼吸灯、
 *       停车地面标识、名称图集与名称四边形）与灯光环境的全部外观常量，供几
 *       何构建与图层组件共同引用，保证同一视觉语言只有一份事实源。
 * 边界：只包含数值与颜色常量，不创建任何 Three.js 对象、不含业务语义推导；
 *       车辆与标签外观属 fleet-monitoring 的 fleetAppearance。
 * 关键不变量：
 * 1. 图层高度阶梯（GRID_Y → PATH_SURFACE_Y → PATH_EDGE_Y → NODE_Y →
 *    NAME_QUAD_Y）单调递增且间隔足够小（厘米级）：静态贴花靠微小高度差
 *    避免 z-fighting，在米制地图尺度下肉眼不可见；
 * 2. 颜色语言沿用原型参考：蓝绿 work 站点、青色 charge、紫色 park、灰色
 *    未知兜底（SPEC §2.1 默认表现）；
 * 3. 名称距离显隐（NEAR/FAR）为平滑过渡区间：近于 NEAR 全显、远于 FAR 全隐、
 *    之间线性淡出（地标名称的可见范围口径）。
 */

/**
 * 场景清屏底色（地图未就绪或失败重试期间页面保持的唯一颜色，SPEC §7.4）。
 * P1-1：提亮至 Reference 色域（Reference 实测 #161b22）。
 */
export const MAP_CLEAR_COLOR = '#14181f'

/**
 * 场景雾（P1-3）：FogExp2 密度 = 该系数 / 地图对角线（当前 ≈ 0.00092/m）。
 * 雾色 = 清屏底色，总览距离（450~800m）下远处对象渐隐进背景；近景
 * （< 100m）雾因子 < 1%，无感知。
 */
export const SCENE_FOG_DENSITY_PER_DIAGONAL = 0.25

/** 图层高度阶梯（世界 y，单位米；见关键不变量 1） */
export const GRID_Y = 0.02
export const PATH_SURFACE_Y = 0.04
export const PATH_EDGE_HALO_Y = 0.052
export const PATH_EDGE_Y = 0.058
export const PATH_ARROW_Y = 0.066
export const NODE_Y = 0.08
/** 名称四边形：高于节点圆台顶（NODE_Y + NODE_TOP_M），文字不被节点遮挡 */
export const NAME_QUAD_Y = 0.19

/* ==================== 物理路径（原型路网复刻） ====================
 * 路网表达对齐路网原型图：暗色路面条带 + 路缘「发光蓝边」+ 黄色方向箭头。
 * 蓝边由两层条带合成——亮色细芯线（颜色乘 BOOST 借 ACES 肩部过曝出「灯管」
 * 感）与加法混合的宽晕圈（贴地微光）；路口以环形蓝边收口，断头端以半圆
 * 弧包边。箭头方向取路径逻辑边的行进方向（优先非回边），沿弧长等距布置。
 */
/** 路面条带宽度（米）：≥ 2× 车宽（0.7m），保持「路 > 车 > 节点」尺度链 */
export const PATH_SURFACE_WIDTH_M = 1.8
/** 路面色：比背景略亮的暗色铺装板，明度阶梯在蓝边与背景之间 */
export const PATH_SURFACE_COLOR = '#2b303a'

/** 蓝边细芯线宽（米）与颜色；BOOST > 1 过曝提亮出霓虹灯管感 */
export const PATH_EDGE_WIDTH_M = 0.07
export const PATH_EDGE_COLOR = '#3fc3ff'
export const PATH_EDGE_BOOST = 1.8
/** 蓝边晕圈宽（米）、颜色与加法混合透明度：贴在路面上的微光溢出（路口
 * 多边界交叠，透明度须压低防加法混合过曝） */
export const PATH_EDGE_HALO_WIDTH_M = 0.26
export const PATH_EDGE_HALO_COLOR = '#1e7fe0'
export const PATH_EDGE_HALO_OPACITY = 0.18

/** 路口补面半径 = 半路宽 × 该系数：蓝边在路口以同半径圆环收口 */
export const JUNCTION_PAD_SCALE = 1.15
/** 路口补面圆盘离散段数（圆环蓝边与补面同段数对齐） */
export const JUNCTION_PAD_SEGMENTS = 24
/** 断头端半圆包边弧的离散段数 */
export const PATH_END_ARC_SEGMENTS = 10

/** 黄色方向箭头外形（米）：全长、杆半宽、头半宽与头长，沿路径切线放置 */
export const PATH_ARROW_LENGTH_M = 0.9
export const PATH_ARROW_SHAFT_HALF_WIDTH_M = 0.1
export const PATH_ARROW_HEAD_HALF_WIDTH_M = 0.24
export const PATH_ARROW_HEAD_LENGTH_M = 0.38
/** 箭头沿弧长的布置间距（米），相位取间距之半（短路径居中一枚） */
export const PATH_ARROW_SPACING_M = 2.2
/** 箭头与路径端部的最小退距（米）：不压路口环与断头端弧（短路径自动缩小） */
export const PATH_ARROW_END_MARGIN_M = 0.45
export const PATH_ARROW_COLOR = '#ffc93c'
export const PATH_ARROW_BOOST = 1.2

/**
 * 节点站点圆盘半径与离散段数（一个 InstancedMesh 渲染全部节点，SPEC §5.1）。
 * NODE_RADIUS_M 是状态色外环的外半径；暗色底座再外扩 NODE_BASE_MARGIN_M，
 * 形成节点整体的暗色外轮廓；段数 20 保证近景圆形轮廓可辨（12 段的
 * 多边形边缘在近景明显）。
 */
export const NODE_RADIUS_M = 0.25
export const NODE_CIRCLE_SEGMENTS = 20
/** 暗色底座超出状态色外环的边距（米）：兼作节点整体的暗色外轮廓 */
export const NODE_BASE_MARGIN_M = 0.04
/** 节点整体外半径（底座外沿，米）：屏幕尺寸淡出的投影口径 */
export const NODE_OUTER_RADIUS_M = NODE_RADIUS_M + NODE_BASE_MARGIN_M

/* ==================== 节点实心圆台 ====================
 * 节点是单层实心圆台：暗色底座 → 状态色实心柱身（顶外沿倒角过曝提亮），
 * 顶面为整块状态色圆盘。以下常量定义半径/高度/倒角与顶点色亮度乘数
 * （最终色 = 实例色 × 乘数），是 nodeStackGeometry 的唯一事实源。
 * 乘数 >1 的「发光面」借助 ACES 色调映射的肩部滚降把实例色推向亮色过曝，
 * 与状态色的辉光观感一致。 */

/** 底座顶面高度（米）：底座自 NODE_Y 起的抬升，形成嵌入地面的台阶感 */
export const NODE_BASE_HEIGHT_M = 0.045
/** 底座底部倒角高度（米）：外沿自下向上的收斜边 */
export const NODE_BASE_CHAMFER_M = 0.02
/** 实心柱身顶面高度（米）：节点堆叠的总高 */
export const NODE_TOP_M = 0.1
/** 柱身顶部倒角高度（米）：顶外沿的斜切亮边 */
export const NODE_TOP_CHAMFER_M = 0.01

/** 暗色层亮度乘数：底座（保持节点色相的深色，比纯黑更协调） */
export const NODE_BASE_STRENGTH = 0.16
/** 柱身亮度乘数：侧壁 = 实例色原样，顶部倒角过曝提亮 */
export const NODE_SIDE_STRENGTH = 1.0
export const NODE_TOP_CHAMFER_STRENGTH = 1.25
/** 顶面亮度乘数：过曝提亮的实心圆盘面 */
export const NODE_TOP_STRENGTH = 1.35

/**
 * 节点屏幕尺寸淡出（P1-5/2.3 的 shader LOD）：投影直径 < start 逐帧变透明、
 * < end 完全消失。总览距离下单个节点盘投影 < 4px，4291 个圆盘叠加成发光
 * 点毯；淡出后总览保持点毯观感，近景（投影 > 10px）不受影响。
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
 *  只影响受光材质，节点/标签等 Unlit 层不受影响；exposure 不动） */
export const DIRECTIONAL_LIGHT_INTENSITY = 1.2
/** 静态阴影相机按灯光空间地图四角包络后的扩展边距（车辆高度与贴图渗漏余量） */
export const LIGHT_SHADOW_MARGIN_M = 6
/** 默认阴影贴图分辨率（可被 config.renderer.shadowMapSize 覆盖，SPEC §5.4） */
export const DEFAULT_SHADOW_MAP_SIZE = 2048

/**
 * 自定义渐变环境（P2-5/9.4）：替代 RoomEnvironment 的「棚拍灯箱」感——
 * 大球面顶点色渐变（天顶冷白 → 地平灰蓝 → 天底深灰蓝）经 PMREM 预滤波为
 * IBL。整体亮度低于灯箱环境，受光车体色的饱和度回血（P1 遗留的「车体偏
 * 浅」即源于 IBL 过亮）；模糊半径 0.04 沿用（静态场景不需要锐利反射）。
 */
export const ENVIRONMENT_ZENITH_COLOR = '#c9d7e8'
export const ENVIRONMENT_HORIZON_COLOR = '#3a4250'
export const ENVIRONMENT_GROUND_COLOR = '#161a21'

/**
 * 页面背景渐变与暗角（P2-6）：Canvas 生成的屏幕空间背景纹理（顶部冷灰蓝 →
 * 底部更深、四角暗角），替代纯色清屏，提供 Reference 的聚焦感。Canvas 不可
 * 用（无头测试环境）时降级为 MAP_CLEAR_COLOR 纯色；雾色仍为清屏底色——雾
 * 把远处对象渐隐进背景中间档，暗角只压屏幕边缘。
 */
export const BACKGROUND_TEXTURE_PX = 512
export const BACKGROUND_TOP_COLOR = '#181d26'
export const BACKGROUND_BOTTOM_COLOR = '#10141b'
/** 四角暗角强度：角点颜色向黑压暗的比例（0 = 无暗角） */
export const BACKGROUND_VIGNETTE_STRENGTH = 0.3

/* ==================== TASK-005 地图业务语义图层 ==================== */

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

/** 名称图集：字体大小/族、单元内边距、画布宽度与高度上限（2 的幂，保证 mipmap） */
export const MAP_NAME_FONT_PX = 20
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
export const PARK_GLYPH_HEIGHT_M = 0.8

/**
 * 地标名称距离显隐区间（米）：近于 near 全显，远于 far 隐藏。
 * 视觉差距分析 P0-5：仓库节点名称已整体移除（Reference 无仓库名称文字，
 * 1185 个名称在中景形成文字海）；区间现服务于停车符号等地标名称。
 */
export const LANDMARK_NAME_FADE_NEAR_M = 30
export const LANDMARK_NAME_FADE_FAR_M = 70
