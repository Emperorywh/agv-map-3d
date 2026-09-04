/**
 * 节点半径布局只处理密集节点之间的显示避让，不再承担方向箭头布局。
 * 空间哈希限制查询范围，原始坐标、节点身份和业务角色始终不变。
 */
import type { WorldTransform } from '@/shared/spatial'
import type { MapModel } from '../model/types'
import { NODE_NEIGHBOR_RADIUS_RATIO, NODE_OUTER_RADIUS_M } from './mapAppearance'

const GRID_CELL_M = 1
const LENGTH_EPSILON_M = 1e-6

interface PointXZ {
  readonly x: number
  readonly z: number
}

interface OccupiedDisc extends PointXZ {
  readonly radius: number
}

/**
 * 圆心只入一个桶，查询时按半径扩展范围；跨桶边界同样参与避让。
 * 索引拥有构建阶段的数据，返回的邻域不修改已登记节点。
 */
class DiscGrid {
  private readonly cells = new Map<string, OccupiedDisc[]>()

  add(disc: OccupiedDisc): void {
    const key = `${Math.floor(disc.x / GRID_CELL_M)},${Math.floor(disc.z / GRID_CELL_M)}`
    const cell = this.cells.get(key)
    if (cell === undefined) {
      this.cells.set(key, [disc])
    } else {
      cell.push(disc)
    }
  }

  *near(point: PointXZ, distance: number): IterableIterator<OccupiedDisc> {
    const minX = Math.floor((point.x - distance) / GRID_CELL_M)
    const maxX = Math.floor((point.x + distance) / GRID_CELL_M)
    const minZ = Math.floor((point.z - distance) / GRID_CELL_M)
    const maxZ = Math.floor((point.z + distance) / GRID_CELL_M)
    for (let x = minX; x <= maxX; x += 1) {
      for (let z = minZ; z <= maxZ; z += 1) {
        yield* this.cells.get(`${x},${z}`) ?? []
      }
    }
  }
}

export class NodeMarkerLayout {
  readonly nodes = new Map<string, OccupiedDisc>()

  constructor(mapModel: MapModel, worldTransform: WorldTransform) {
    const neighbors = new DiscGrid()
    for (const node of mapModel.nodeList) {
      const point = worldTransform.toWorldXZ(node.x, node.y)
      const disc = { ...point, radius: NODE_OUTER_RADIUS_M }
      this.nodes.set(node.id, disc)
      neighbors.add(disc)
    }
    /**
     * 只搜索足以影响默认半径的邻域；精确重合点保留默认半径，由深度与语义
     * 显隐处理，不将全部节点缩成零，也不修改节点身份或拓扑。
     */
    const searchDistance = NODE_OUTER_RADIUS_M / NODE_NEIGHBOR_RADIUS_RATIO
    for (const [id, point] of this.nodes) {
      let radius = NODE_OUTER_RADIUS_M
      for (const neighbor of neighbors.near(point, searchDistance)) {
        const distance = Math.hypot(point.x - neighbor.x, point.z - neighbor.z)
        if (distance > LENGTH_EPSILON_M) {
          radius = Math.min(radius, distance * NODE_NEIGHBOR_RADIUS_RATIO)
        }
      }
      const disc = { x: point.x, z: point.z, radius }
      this.nodes.set(id, disc)
    }
  }
}
