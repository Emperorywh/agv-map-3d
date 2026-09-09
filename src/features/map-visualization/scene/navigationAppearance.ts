/**
 * 导航场景统一使用米制尺寸和线性发光强度。
 * 地坪纹理参数仍归 mapAppearance，墙板和导航细节在这里集中调节。
 */
import { FACTORY_WALL_COLOR, ROAD_GUIDE_Y } from './mapAppearance'

export const NAVIGATION_STYLE = Object.freeze({
  clear: '#178fff', reserved: '#ffc36a', waiting: '#ffc36a', blocked: '#ff505b',
  routeWidth: 0.038, haloWidth: 0.32, washWidth: 1.1, emission: 1.65,
  /**
   * 中心引导弱化为辅助线，两侧边界承担道路轮廓；箭头与节点位于铺装上方。
   * 双向箭头按路宽的四分之一分列，缩放时保持真实尺寸与车道比例。
   */
  guideOpacity: 0.22, routeY: ROAD_GUIDE_Y, arrowY: ROAD_GUIDE_Y + 0.012, arrowSpacing: 2.6, arrowLength: 0.31,
  arrowOffsetRatio: 0.25, nodeY: ROAD_GUIDE_Y + 0.026, nodeRadius: 0.19, nodeCore: 0.06,
  nodeRingWidth: 0.014, nodeHalo: 0.42,
  bloomStrength: 0.12, bloomRadius: 0.25, bloomThreshold: 1.2,
  /**
   * 墙高继续服务原有建筑布局，相机和灯光沿用同一米制尺寸。
   * 玻璃、框架和局部灯带的外观参数由下方独立配置集中管理。
   */
  wallHeight: 3.6,
})

/**
 * 烟熏玻璃采用普通透明混合，粗糙度只控制表面高光，不会模糊后方物体。
 * 面板、实体框架和光源分开配置；玻璃不自发光，也不启用物理透射通道。
 */
export const WALL_MATERIAL_STYLE = Object.freeze({
  glass: { color: FACTORY_WALL_COLOR, opacity: 0.35, roughness: 0.25, metalness: 0, envIntensity: 0.72, thickness: 0.1, bevel: 0.012 },
  frame: { color: '#273847', roughness: 0.4, metalness: 0.72 },
  trim: { color: '#536879', roughness: 0.32, metalness: 0.8 },
  base: { color: '#111c2b', roughness: 0.48, metalness: 0.55 },
  lamp: { color: '#138bcb', emission: 2.0, roughness: 0.32 },
  core: { color: '#54c9e7', emission: 2.2, roughness: 0.28 },
  /**
   * 玻璃统一排在地面贴花之后、车辆标签之前，保证路径先被玻璃适度压暗。
   * 所有墙向的面板进入同一个排序批次，由当前绘制相机决定远近顺序。
   */
  glassRenderOrder: 9,
})
