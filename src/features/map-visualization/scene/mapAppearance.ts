/**
 * 地图场景视觉常量（SPEC §5.1、§5.4；TASK-004 核心地图 + TASK-005 语义图层）。
 *
 * 职责：集中定义静态地图对象（清屏底色、物理路径、节点站点、充电桩/呼吸灯、
 *       停车地面标识、名称图集与名称四边形）与灯光环境的全部外观常量，供几
 *       何构建与图层组件共同引用，保证同一视觉语言只有一份事实源。
 * 边界：只包含数值与颜色常量，不创建任何 Three.js 对象、不含业务语义推导；
 *       车辆与标签外观属 fleet-monitoring 的 fleetAppearance。
 * 关键不变量：
 * 1. 图层高度阶梯（GRID_Y → PATH_SURFACE_Y → PATH_CENTERLINE_Y →
 *    NODE_Y → NAME_QUAD_Y）单调递增且间隔足够小（厘米级）：静态贴花靠微小
 *    高度差避免 z-fighting，在米制地图尺度下肉眼不可见；
 * 2. 颜色语言沿用原型参考：深灰路径、蓝绿 work 站点、青色 charge、紫色
 *    park、灰色未知兜底（SPEC §2.1 默认表现）；
 * 3. 尺度链保持「路 > 车 > 节点」的包含关系（视觉差距分析 P0-3）：路面宽度
 *    ≥ 2× 车宽（0.7m），节点直径 ≤ 路宽的 1/3——节点是嵌在路口里的小圆点，
 *    不随缩放变化；
 * 4. 名称距离显隐（NEAR/FAR）为平滑过渡区间：近于 NEAR 全显、远于 FAR 全隐、
 *    之间线性淡出（地标名称的可见范围口径）。
 */

/**
 * 场景清屏底色（地图未就绪或失败重试期间页面保持的唯一颜色，SPEC §7.4）。
 * P1-1：提亮至 Reference 色域（Reference 实测 #161b22，取 #14181f 保持
 * 「路面 > 背景」的明度阶梯）。
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
export const PATH_CENTERLINE_Y = 0.06
export const NODE_Y = 0.08
/** 名称四边形：高于节点圆台顶（NODE_Y + NODE_RING_TOP_M），文字不被节点遮挡 */
export const NAME_QUAD_Y = 0.19

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

/* ==================== 道路拓扑重建（视觉对齐 P0-5.3） ====================
 * 此前每条物理路径独立成条带并在两端补圆帽：真实地图的大量相邻短路径在
 * 同一交叉口叠加多个圆片，形成花瓣、鼓包与交叉纹理。P0-5.3 从拓扑层重建：
 * 二度节点处合并连续链、只在断头端补圆帽、每个交叉节点只补一个路口圆盘。
 * 路口内部（圆盘半径范围）不绘制虚线中线。 */
/** 路口补面半径 = 半路宽 × 该系数：略大于半路宽，读作圆角路口垫 */
export const JUNCTION_PAD_SCALE = 1.5
/** 路口补面圆盘离散段数（路口是近景焦点，比端帽 16 段更圆） */
export const JUNCTION_PAD_SEGMENTS = 24

/**
 * 节点站点圆盘半径与离散段数（一个 InstancedMesh 渲染全部节点，SPEC §5.1）。
 * NODE_RADIUS_M 是状态色外环的外半径；暗色底座再外扩 NODE_BASE_MARGIN_M，
 * 整体外径（NODE_OUTER_RADIUS_M ≤ 0.5× 半路宽，P0-3）保持「嵌在路口里的
 * 小圆点」尺度链不被立体化破坏；段数 20 保证近景圆形轮廓可辨（12 段的
 * 多边形边缘在近景明显）。
 */
export const NODE_RADIUS_M = 0.25
export const NODE_CIRCLE_SEGMENTS = 20
/** 暗色底座超出状态色外环的边距（米）：兼作节点整体的「嵌 into 路面」暗轮廓 */
export const NODE_BASE_MARGIN_M = 0.04
/** 节点整体外半径（底座外沿，米）：屏幕尺寸淡出的投影口径 */
export const NODE_OUTER_RADIUS_M = NODE_RADIUS_M + NODE_BASE_MARGIN_M

/* ==================== 节点多层同心圆台（视觉对齐 P2-8） ====================
 * 原型（docs/prototypes/agv-3d-scene-prototype.png）的节点是标志性的同心圆
 * 立体结构：暗色底座 → 状态色发光外环 → 暗色内台面 → 亮色中心圆盘，四层
 * 圆台堆叠、边缘带倒角。以下常量逐层定义半径/高度/倒角与顶点色亮度乘数
 * （最终色 = 实例色 × 乘数），是 nodeStackGeometry 的唯一事实源。
 * 乘数 >1 的「发光层」借助 ACES 色调映射的肩部滚降把实例色推向亮色过曝，
 * 与原型外环与中心盘的辉光观感一致。 */

/** 底座顶面高度（米）：底座自 NODE_Y 起的抬升，形成嵌入路面的台阶感 */
export const NODE_BASE_HEIGHT_M = 0.045
/** 底座底部倒角高度（米）：外沿自下向上的收斜边 */
export const NODE_BASE_CHAMFER_M = 0.02
/** 状态色外环顶面高度（米）：节点堆叠的总高 */
export const NODE_RING_TOP_M = 0.1
/** 外环顶部倒角高度（米）：顶外沿的斜切亮边 */
export const NODE_RING_CHAMFER_M = 0.01
/** 外环内半径比例（× NODE_RADIUS_M）：环带宽度与内部开口 */
export const NODE_RING_INNER_RATIO = 0.64
/** 暗色内台顶面高度（米）：外环与中心盘之间的暗色环形台面 */
export const NODE_SHELF_TOP_M = 0.055
/** 中心圆盘半径比例（× NODE_RADIUS_M）与顶面高度（米）：顶面与外环持平，
 *  低角度下中心盘不被外环内壁遮挡（原型中心高光始终可见） */
export const NODE_CENTER_RADIUS_RATIO = 0.4
export const NODE_CENTER_TOP_M = 0.1

/** 暗色层亮度乘数：底座（保持节点色相的深色，比纯黑更协调） */
export const NODE_BASE_STRENGTH = 0.16
/** 暗色层亮度乘数：内台面（比底座再暗半档，拉开层次） */
export const NODE_SHELF_STRENGTH = 0.13
/** 外环亮度乘数：侧壁与顶环 = 实例色原样，顶部倒角过曝提亮 */
export const NODE_RING_STRENGTH = 1.0
export const NODE_RING_CHAMFER_STRENGTH = 1.25
/** 外环内壁亮度乘数：背光内壁压暗，形成环带的体积感 */
export const NODE_RING_INNER_WALL_STRENGTH = 0.4
/** 中心盘亮度乘数：侧壁略暗、顶面过曝提亮（原型中心的高光圆盘） */
export const NODE_CENTER_SIDE_STRENGTH = 0.9
export const NODE_CENTER_TOP_STRENGTH = 1.35

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
