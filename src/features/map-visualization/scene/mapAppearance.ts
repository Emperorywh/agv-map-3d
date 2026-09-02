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
 * 1. 图层高度阶梯（GROUND_Y → GRID_Y → EXCLUSIVE_OUTLINE_Y → PATH_SURFACE_Y →
 *    PATH_CENTERLINE_Y → LANDMARK_PAD_Y → NODE_Y → NAME_QUAD_Y）单调递增且
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

/** 场景清屏底色（地图未就绪或失败重试期间页面保持的唯一颜色，SPEC §7.4） */
export const MAP_CLEAR_COLOR = '#0c0e12'

/** 工业地坪颜色与粗糙度（MeshStandardMaterial，接收阴影） */
export const GROUND_COLOR = '#16191f'
export const GROUND_ROUGHNESS = 0.95
export const GROUND_METALNESS = 0.05

/** 地面按地图包围盒向四周扩展的边距（SPEC §5.1：加 10m） */
export const GROUND_MARGIN_M = 10

/** 网格刻线间距与颜色（工业地坪的参考刻线，5m 间隔） */
export const GROUND_GRID_SPACING_M = 5
export const GROUND_GRID_COLOR = '#232830'

/** 图层高度阶梯（世界 y，单位米；见关键不变量 1） */
export const GROUND_Y = 0
export const GRID_Y = 0.02
/** 独占区蓝色外沿：位于路面之下、网格之上，只露出宽出路面的边缘 */
export const EXCLUSIVE_OUTLINE_Y = 0.03
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
export const PATH_SURFACE_COLOR = '#363c45'
/** 路径中线颜色（比路面略亮的细线，引导视觉） */
export const PATH_CENTERLINE_COLOR = '#4b525c'

/**
 * 节点站点圆盘半径与离散段数（一个 InstancedMesh 渲染全部节点，SPEC §5.1）。
 * 半径 ≤ 0.5× 半路宽（P0-3）：节点是嵌在路口里的小圆点；段数 20 保证近景
 * 圆形轮廓可辨（12 段的多边形边缘在近景明显）。
 */
export const NODE_RADIUS_M = 0.25
export const NODE_CIRCLE_SEGMENTS = 20

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

/* ==================== TASK-005 地图业务语义图层 ==================== */

/**
 * 独占区蓝色外沿条带总宽度：比路面（1.8m）宽出蓝色边缘（SPEC §2.3），
 * 路面加宽后同步放大，保证每侧露出 ~0.3m 的可见蓝边。
 */
export const EXCLUSIVE_OUTLINE_WIDTH_M = 2.4
export const EXCLUSIVE_OUTLINE_COLOR = '#4f8dff'
/** 低透明度：外沿只是空间提示，不得遮蔽路面与节点（SPEC §2.3） */
export const EXCLUSIVE_OUTLINE_OPACITY = 0.3

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

/** 仓库地面标识方垫边长（浅黄）与停车点方垫边长（紫色），透明度共用 */
export const WAREHOUSE_PAD_SIZE_M = 1.1
export const PARK_PAD_SIZE_M = 1.4
export const LANDMARK_PAD_OPACITY = 0.32

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
