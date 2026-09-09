/**
 * 导航场景统一使用米制尺寸和线性发光强度。
 * 地坪纹理参数仍归 mapAppearance，墙板和导航细节在这里集中调节。
 */
import { ROAD_GUIDE_Y } from './mapAppearance'

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
  panel: '#303a42', panelRoughness: 0.57, trim: '#78858b', trimRoughness: 0.32,
  wallHeight: 3.6, wallLamp: '#ffe3b4', wallEmission: 2.5,
})
