/**
 * 地图场景视觉常量（SPEC §5.1、§5.4；TASK-004 核心地图部分）。
 *
 * 职责：集中定义 TASK-004 范围内静态地图对象（清屏底色、工业地坪、网格刻线、
 *       物理路径、节点站点）与灯光环境的全部外观常量，供几何构建与图层组件
 *       共同引用，保证同一视觉语言只有一份事实源。
 * 边界：只包含数值与颜色常量，不创建任何 Three.js 对象、不含业务语义推导；
 *       仓库/充电/停车地标与独占区外观属 TASK-005，暂不在此定义。
 * 关键不变量：
 * 1. 图层高度阶梯（GROUND_Y → GRID_Y → PATH_SURFACE_Y → PATH_CENTERLINE_Y →
 *    NODE_Y）单调递增且间隔足够小（厘米级）：静态贴花靠微小高度差避免 z-fighting，
 *    在米制地图尺度下肉眼不可见；
 * 2. 颜色语言沿用原型参考：深色工业地坪、深灰路径、蓝绿 work 站点、浅黄仓库、
 *    青色 charge、紫色 park、灰色未知兜底（SPEC §2.1 默认表现）；
 * 3. 几何宽度/半径按 AGV 尺寸量级取值（车宽 0.7m），不随缩放变化。
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
export const PATH_SURFACE_Y = 0.04
export const PATH_CENTERLINE_Y = 0.06
export const NODE_Y = 0.08

/** 物理路径路面条带宽度与颜色（深灰路面，Unlit 双面保证任意绕序可见） */
export const PATH_SURFACE_WIDTH_M = 0.5
export const PATH_SURFACE_COLOR = '#363c45'
/** 路径中线颜色（比路面略亮的细线，引导视觉） */
export const PATH_CENTERLINE_COLOR = '#4b525c'

/** 节点站点圆盘半径与离散段数（一个 InstancedMesh 渲染全部节点，SPEC §5.1） */
export const NODE_RADIUS_M = 0.35
export const NODE_CIRCLE_SEGMENTS = 12

/** 节点颜色表：按归一类别取色，unknown 使用灰色通用兜底（SPEC §2.1） */
export const NODE_COLORS: Record<'work' | 'warehouse' | 'charge' | 'park' | 'unknown', string> = {
  work: '#3fb3a4',
  warehouse: '#e3cf7a',
  charge: '#31d9e8',
  park: '#b07af5',
  unknown: '#757c88',
}

/** 方向光强度与环境贴图强度（ACESFilmic 色调映射下的经验取值） */
export const DIRECTIONAL_LIGHT_INTENSITY = 2.2
/** 静态阴影相机在地图包围盒之外的扩展边距（保证全图阴影覆盖） */
export const LIGHT_SHADOW_MARGIN_M = 20
/** 默认阴影贴图分辨率（可被 config.renderer.shadowMapSize 覆盖，SPEC §5.4） */
export const DEFAULT_SHADOW_MAP_SIZE = 2048
