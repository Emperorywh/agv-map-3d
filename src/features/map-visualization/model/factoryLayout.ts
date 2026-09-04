/**
 * 厂房布局是地坪、建筑外壳和相机边界的共同来源，尺寸全部使用世界米制坐标。
 * 先为整张地图留出通行、设备和检修空间，再对齐柱网；不随视口或镜头移动。
 */
import type { SceneBounds } from './types'

export const FACTORY_LAYOUT_CONFIG = Object.freeze({
  circulationWidthM: 6,
  equipmentDepthM: 4,
  maintenanceWidthM: 2,
  /**
   * 外围余量由地图对角线的百分之十六放宽到百分之二十二。
   * 为全图缩远留出屏幕边缘空间，地坪、墙体和相机继续共用这一范围。
   */
  expansionRatio: 0.22,
  columnSpacingM: 8,
  wallHeightM: 12,
  wallThicknessM: 0.3,
  plinthHeightM: 0.9,
  cameraEdgeInsetM: 0.5,
})

/**
 * 四侧墙使用局部横向轴和朝外法线描述，生成器无需为不同朝向重复建模。
 * 地坪铺到外边界，墙体向内生长，墙根不会留下缝隙。
 */
export interface FactoryWall {
  readonly name: string
  readonly x: number
  readonly z: number
  readonly length: number
  readonly rotation: number
  readonly normalX: number
  readonly normalZ: number
}

export interface FactoryLayout {
  /**
   * 保留原地图范围，供缩远时计算全图取景距离。
   * 建筑边界仍由 bounds 提供，两者不能混用，否则会把整个厂房再次包进屏幕。
   */
  readonly mapBounds: SceneBounds
  readonly bounds: SceneBounds
  readonly walls: readonly FactoryWall[]
  readonly config: typeof FACTORY_LAYOUT_CONFIG
}

/**
 * 地图模型不可变，按其包围盒缓存布局，使不同消费方取得同一个只读对象。
 * 弱引用不会阻止旧地图被回收，地图替换后自然生成新的厂房。
 */
const layouts = new WeakMap<SceneBounds, FactoryLayout>()

export function getFactoryLayout(mapBounds: SceneBounds): FactoryLayout {
  const cached = layouts.get(mapBounds)
  if (cached !== undefined) {
    return cached
  }
  const config = FACTORY_LAYOUT_CONFIG
  const margin = Math.max(
    config.circulationWidthM + config.equipmentDepthM + config.maintenanceWidthM,
    mapBounds.diagonal * config.expansionRatio,
  )
  const width = Math.ceil((mapBounds.maxWorldX - mapBounds.minWorldX + margin * 2) / config.columnSpacingM) * config.columnSpacingM
  const depth = Math.ceil((mapBounds.maxWorldZ - mapBounds.minWorldZ + margin * 2) / config.columnSpacingM) * config.columnSpacingM
  const cx = mapBounds.centerWorldX
  const cz = mapBounds.centerWorldZ
  const bounds = Object.freeze({
    minWorldX: cx - width / 2,
    maxWorldX: cx + width / 2,
    minWorldZ: cz - depth / 2,
    maxWorldZ: cz + depth / 2,
    centerWorldX: cx,
    centerWorldZ: cz,
    diagonal: Math.hypot(width, depth),
  })
  const walls = Object.freeze([
    Object.freeze({ name: 'south', x: cx, z: bounds.maxWorldZ, length: width, rotation: 0, normalX: 0, normalZ: 1 }),
    Object.freeze({ name: 'north', x: cx, z: bounds.minWorldZ, length: width, rotation: Math.PI, normalX: 0, normalZ: -1 }),
    Object.freeze({ name: 'east', x: bounds.maxWorldX, z: cz, length: depth, rotation: Math.PI / 2, normalX: 1, normalZ: 0 }),
    Object.freeze({ name: 'west', x: bounds.minWorldX, z: cz, length: depth, rotation: -Math.PI / 2, normalX: -1, normalZ: 0 }),
  ])
  const layout = Object.freeze({ mapBounds, bounds, walls, config })
  layouts.set(mapBounds, layout)
  return layout
}
