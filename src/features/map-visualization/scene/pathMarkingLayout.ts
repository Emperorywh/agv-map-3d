/**
 * 密集路网的静态标记布局：节点按最近邻限径，箭头按弧长、邻近节点和箭头避让。
 * 所有计算只在地图构建时进行；空间哈希限制邻域查询，不进入逐帧渲染循环。
 * 布局只改变可视标记，业务坐标、路径形状及逻辑方向始终保留。
 */
import type { WorldTransform } from '@/shared/spatial'
import type { MapModel } from '../model/types'
import {
  NODE_NEIGHBOR_RADIUS_RATIO,
  NODE_OUTER_RADIUS_M,
  PATH_DIRECTION_ARROW_HEAD_HALF_WIDTH_M,
  PATH_DIRECTION_ARROW_HEAD_LENGTH_M,
  PATH_DIRECTION_ARROW_LENGTH_M,
  PATH_DIRECTION_ARROW_POSITION_RATIO,
  PATH_DIRECTION_ARROW_SCALES,
  PATH_DIRECTION_ARROW_SHAFT_HALF_WIDTH_M,
  PATH_MARKING_CLEARANCE_M,
} from './mapAppearance'

/**
 * 使用保守圆形包络覆盖箭头全部顶点，保证不同朝向的标记也不会相交。
 * 最大查询距离小于网格边长；极短边和完全重合节点不产生零除或无效几何。
 */
const ARROW_RADIUS_M = Math.max(
  Math.hypot(PATH_DIRECTION_ARROW_LENGTH_M / 2, PATH_DIRECTION_ARROW_SHAFT_HALF_WIDTH_M),
  Math.hypot(
    PATH_DIRECTION_ARROW_LENGTH_M / 2 - PATH_DIRECTION_ARROW_HEAD_LENGTH_M,
    PATH_DIRECTION_ARROW_HEAD_HALF_WIDTH_M,
  ),
)
const GRID_CELL_M = 1
const LENGTH_EPSILON_M = 1e-6
const CANDIDATE_RATIOS = [0, 0.1, -0.1, 0.2, -0.2, 0.3, 0.4, -0.3, 0.5, 0.6, 0.7] as const

interface PointXZ {
  readonly x: number
  readonly z: number
}

interface OccupiedDisc extends PointXZ {
  readonly radius: number
}

export interface PathArrowPlacement {
  readonly center: PointXZ
  readonly forward: PointXZ
  readonly scale: number
  /** 该箭头代表的逻辑方向是否为反向边（isBackEdge=true，渲染为红色） */
  readonly backEdge: boolean
}

/** 一个逻辑方向及其颜色语义：direction 只决定朝向与候选位置，backEdge 决定颜色 */
export interface PathArrowDirectionSpec {
  readonly direction: 1 | -1
  readonly backEdge: boolean
}

/**
 * 圆心只入一个桶，查询时按半径扩展范围；跨桶边界同样参与避让。
 * 索引拥有构建阶段的数据，返回的邻域不修改已登记节点或箭头。
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

/**
 * 缓存每条折线的累计弧长，所有候选共用该表，曲线沿真实采样折线取切向。
 * 零长采样段被跳过，避免贝塞尔端部重复点产生非有限方向。
 */
function sampleAt(
  points: readonly PointXZ[],
  cumulative: readonly number[],
  distance: number,
): { center: PointXZ; tangent: PointXZ } | null {
  for (let i = 1; i < points.length; i += 1) {
    const length = cumulative[i] - cumulative[i - 1]
    if (length <= LENGTH_EPSILON_M || distance > cumulative[i]) {
      continue
    }
    const a = points[i - 1]
    const b = points[i]
    const t = (distance - cumulative[i - 1]) / length
    return {
      center: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t },
      tangent: { x: (b.x - a.x) / length, z: (b.z - a.z) / length },
    }
  }
  return null
}

/**
 * 圆形包络之间必须留出固定间隙，避免斜向箭头的尖角相碰。
 * 节点采用最终显示半径，包含与当前路径没有拓扑连接的邻近节点。
 */
function overlaps(a: OccupiedDisc, b: OccupiedDisc): boolean {
  return Math.hypot(a.x - b.x, a.z - b.z) <
    a.radius + b.radius + PATH_MARKING_CLEARANCE_M
}

export class PathMarkingLayout {
  readonly nodes = new Map<string, OccupiedDisc>()
  private readonly occupied = new DiscGrid()

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
      this.occupied.add(disc)
    }
  }

  /**
   * 每条物理路径的方向标记作为整体布局；双向边仅在两枚均可放下时提交。
   * 候选按偏好位置、缩小等级稳定搜索，任何失败尝试都不污染占用索引。
   */
  placeArrows(
    points: readonly PointXZ[],
    directions: readonly PathArrowDirectionSpec[],
  ): PathArrowPlacement[] {
    if (points.length < 2 || directions.length === 0) {
      return []
    }
    const cumulative = [0]
    for (let i = 1; i < points.length; i += 1) {
      cumulative.push(cumulative[i - 1] + Math.hypot(
        points[i].x - points[i - 1].x,
        points[i].z - points[i - 1].z,
      ))
    }
    const total = cumulative[cumulative.length - 1]
    if (total <= LENGTH_EPSILON_M) {
      return []
    }
    /**
     * 先扣除首尾节点的显示半径，把候选放在真正可用的弧长区间内。
     * 候选包含区间两端，避免极短边仅因固定采样比例而漏掉可行位置。
     */
    const startRadius = this.endpointRadius(points[0])
    const endRadius = this.endpointRadius(points[points.length - 1])

    for (const scale of PATH_DIRECTION_ARROW_SCALES) {
      const radius = ARROW_RADIUS_M * scale
      const inset = radius + PATH_MARKING_CLEARANCE_M
      const start = startRadius + inset
      const end = total - endRadius - inset
      if (end < start) {
        continue
      }
      const candidates = directions.map(({ direction, backEdge }) => {
        const result: PathArrowPlacement[] = []
        for (const offset of CANDIDATE_RATIOS) {
          const fromStart = PATH_DIRECTION_ARROW_POSITION_RATIO + offset
          const ratio = direction === 1 ? fromStart : 1 - fromStart
          const distance = start + (end - start) * Math.max(0, Math.min(1, ratio))
          const sample = sampleAt(points, cumulative, distance)
          if (sample === null) {
            continue
          }
          const disc = { ...sample.center, radius }
          const searchDistance = radius + Math.max(NODE_OUTER_RADIUS_M, ARROW_RADIUS_M) +
            PATH_MARKING_CLEARANCE_M
          let blocked = false
          for (const other of this.occupied.near(disc, searchDistance)) {
            if (overlaps(disc, other)) {
              blocked = true
              break
            }
          }
          if (!blocked) {
            result.push({
              center: sample.center,
              forward: { x: sample.tangent.x * direction, z: sample.tangent.z * direction },
              scale,
              backEdge,
            })
          }
        }
        return result
      })
      for (const first of candidates[0]) {
        const second = candidates[1]?.find((candidate) => !overlaps(
          { ...first.center, radius },
          { ...candidate.center, radius },
        ))
        if (directions.length === 2 && second === undefined) {
          continue
        }
        const placements = second === undefined ? [first] : [first, second]
        for (const placement of placements) {
          this.occupied.add({ ...placement.center, radius })
        }
        return placements
      }
    }
    return []
  }

  /**
   * 起止点可能有多个重合节点，按最大显示外径预留空间。
   * 仅查询同坐标附近的桶；拓扑之外的其他节点仍由后续完整邻域避让处理。
   */
  private endpointRadius(point: PointXZ): number {
    let radius = 0
    for (const disc of this.occupied.near(point, LENGTH_EPSILON_M)) {
      if (Math.hypot(point.x - disc.x, point.z - disc.z) <= LENGTH_EPSILON_M) {
        radius = Math.max(radius, disc.radius)
      }
    }
    return radius
  }
}
