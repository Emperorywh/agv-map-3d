/**
 * 货架只作为静态场景设施，在边缘节点外围生成等距、朝向道路的双排库区。
 * 保留地图业务坐标，用道路控制点包络和设施净空过滤候选位置，不改变导航拓扑。
 */
import type { WorldTransform } from '@/shared/spatial'
import type { ShelfVariant } from '@/shared/industrial/shelfModel'
import type { FactoryLayout } from '../model/factoryLayout'
import type { MapModel } from '../model/types'

export interface ShelfPlacement {
  readonly x: number
  readonly z: number
  readonly rotation: number
  readonly variant: ShelfVariant
}

/**
 * 新托盘外包宽约一点二零三米，轴向摆放时采用零点六一米的半宽避让。
 * 空架共用这一保守范围，确保资源替换后仍保留墙边通道和道路净空。
 */
const SHELF_HALF_EXTENT_M = 0.61

export function buildShelfLayout(map: MapModel, transform: WorldTransform, factory: FactoryLayout): ShelfPlacement[] {
  if (map.nodeList.length === 0) return []
  const bounds = map.sceneBounds
  const placements: ShelfPlacement[] = []
  /**
   * 贝塞尔曲线位于控制点凸包内，使用其外包矩形做保守避让。
   * 这样即使弯道伸出节点范围，外围货架也不会占用现有道路。
   */
  const roads = map.edgeList.map((edge) => {
    const points = [transform.toWorldXZ(edge.sx, edge.sy), transform.toWorldXZ(edge.ex, edge.ey)]
    if (edge.edgeType === 'BEZIER') points.push(transform.toWorldXZ(edge.cx!, edge.cy!), transform.toWorldXZ(edge.dx!, edge.dy!))
    return {
      minX: Math.min(...points.map((p) => p.x)) - 2.5,
      maxX: Math.max(...points.map((p) => p.x)) + 2.5,
      minZ: Math.min(...points.map((p) => p.z)) - 2.5,
      maxZ: Math.max(...points.map((p) => p.z)) + 2.5,
    }
  })
  const facilities = map.nodeList.filter((node) => node.category === 'charge' || node.category === 'park')
    .map((node) => transform.toWorldXZ(node.x, node.y))
  const sides = [
    { alongX: true, start: bounds.minWorldX, end: bounds.maxWorldX, edge: bounds.minWorldZ, sign: -1, rotation: 0 },
    { alongX: true, start: bounds.minWorldX, end: bounds.maxWorldX, edge: bounds.maxWorldZ, sign: 1, rotation: Math.PI },
    { alongX: false, start: bounds.minWorldZ, end: bounds.maxWorldZ, edge: bounds.minWorldX, sign: -1, rotation: Math.PI / 2 },
    { alongX: false, start: bounds.minWorldZ, end: bounds.maxWorldZ, edge: bounds.maxWorldX, sign: 1, rotation: -Math.PI / 2 },
  ]
  for (const side of sides) {
    const span = side.end - side.start
    const columns = Math.min(6, Math.floor((span - 4) / 1.6) + 1)
    if (columns < 1) continue
    const groups = Math.min(2, Math.max(1, Math.floor(span / 18)))
    for (let group = 0; group < groups; group += 1) {
      const center = side.start + span * (group + 1) / (groups + 1)
      for (let row = 0; row < 2; row += 1) for (let column = 0; column < columns; column += 1) {
        const along = center + (column - (columns - 1) / 2) * 1.6
        const outward = side.edge + side.sign * (6 + row * 1.8)
        const x = side.alongX ? along : outward
        const z = side.alongX ? outward : along
        /**
         * 保守包络覆盖当前四个轴向的空架与托盘货物，墙边另留两米检修通道。
         * 被占用的格位直接留空，其余货架保持原有行列对齐，不随机挪动。
         */
        if (x - SHELF_HALF_EXTENT_M < factory.bounds.minWorldX + 2 || x + SHELF_HALF_EXTENT_M > factory.bounds.maxWorldX - 2 ||
          z - SHELF_HALF_EXTENT_M < factory.bounds.minWorldZ + 2 || z + SHELF_HALF_EXTENT_M > factory.bounds.maxWorldZ - 2) continue
        if (roads.some((road) => x + SHELF_HALF_EXTENT_M > road.minX && x - SHELF_HALF_EXTENT_M < road.maxX && z + SHELF_HALF_EXTENT_M > road.minZ && z - SHELF_HALF_EXTENT_M < road.maxZ)) continue
        if (facilities.some((point) => Math.hypot(x - point.x, z - point.z) < 4.5)) continue
        placements.push({ x, z, rotation: side.rotation, variant: (Math.floor(column / 3) + row + group) % 2 === 0 ? 'empty' : 'loaded' })
      }
    }
  }
  return placements
}
