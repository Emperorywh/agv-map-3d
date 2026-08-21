import type { MapBounds } from '../../domain/types'

/**
 * 场景光照纯函数（SPEC §5.3 / §9）：光照 = 1 盏平行光（唯一投影光源）+ 半球光。
 * 本模块计算平行光阴影正交视锥——按建筑 footprint（地图包围盒 + margin，与
 * 建筑外壳同一口径，SPEC §5.2）尺寸推导，保证 shadow map 覆盖整个厂房。
 *
 * 世界 footprint 中心恒为世界原点（calibration offset 取地图包围盒中心，§4.3），
 * 故阴影视锥以原点为中心、边长取 footprint 外接圆半径（对任意光方位保守覆盖，
 * calibration 旋转非零时仍然安全）。
 */

/** 平行光阴影正交视锥参数（世界单位，米） */
export interface DirectionalShadowFrustum {
  /** 光源世界坐标：归一化方向 × 距离，目标为默认原点 */
  position: [number, number, number]
  /** 正交视锥半边长（left/right/top/bottom 取 ±extent） */
  extent: number
  near: number
  far: number
}

/**
 * 计算主平行光的阴影视锥。
 *
 * - extent：footprint 半宽 / 半深的外接圆半径——视锥对齐光方向，footprint 在光空间
 *   的投影不超过该半径，故四边统一取 ±extent 即可保守覆盖；
 * - 距离 / near / far：以场景外接球半径 range = extent + wallHeight 为包络，
 *   光源置于 2·range 处，near/far = distance ∓ range 夹住整个建筑（含墙顶高度）。
 */
export function computeDirectionalShadowFrustum(params: {
  /** 地图包围盒（地图坐标；世界 footprint 与其同尺寸、中心在世界原点） */
  bounds: MapBounds
  /** 建筑相对地图包围盒的外扩边距（与建筑外壳 FACTORY_MARGIN 同值） */
  margin: number
  /** 自场景中心指向光源的方向向量（不要求单位长度，本函数归一化） */
  direction: readonly [number, number, number]
  /** 建筑高度（外墙高），把竖直体量纳入阴影包络 */
  wallHeight: number
}): DirectionalShadowFrustum {
  const { bounds, margin, direction, wallHeight } = params
  const halfWidth = (bounds.maxX - bounds.minX) / 2 + margin
  const halfDepth = (bounds.maxY - bounds.minY) / 2 + margin
  const extent = Math.hypot(halfWidth, halfDepth)
  const range = extent + wallHeight
  const distance = 2 * range
  const dirLength = Math.hypot(direction[0], direction[1], direction[2])
  const scale = distance / dirLength
  return {
    position: [direction[0] * scale, direction[1] * scale, direction[2] * scale],
    extent,
    near: distance - range,
    far: distance + range,
  }
}
