/**
 * 道路展示分级只消费物理路径与业务类别，不回写节点、逻辑边或寻路索引。
 * 缺少车道元数据时推导主路、支路与设施接入；分级不再过滤路径或弱化引导线。
 * 可用逻辑边 ID 显式覆盖分级；同一物理路径冲突时选择较窄级别，全部路径仍可见。
 */
import type { MapModel } from '../model/types'
import type { PhysicalPathIndex } from './buildMapGeometry'
import type { RoadNetwork } from './roadTopology'
import { ROAD_MAIN_MIN_LENGTH_M, ROAD_ACCESS_MAX_LENGTH_M, ROAD_CONTINUATION_COS } from './mapAppearance'

export type RoadRole = 'main' | 'branch' | 'access'
export type RoadRoleOverrides = ReadonlyMap<string, RoadRole>

interface Incident {
  readonly pathIndex: number
  readonly dx: number
  readonly dy: number
}

/**
 * 沿端点实际切向寻找互为最佳的直行延续，不用节点名称、限速或反向标记猜主路。
 * 分岔处只延续近共线的一对路径，短接入线不会因为连接主路而被一并升级。
 */
export function classifyRoadPaths(
  model: MapModel,
  physical: PhysicalPathIndex,
  network: RoadNetwork,
  overrides: RoadRoleOverrides = new Map(),
): ReadonlyMap<number, RoadRole> {
  const roles = new Map<number, RoadRole>()
  const incidents = new Map<string, Incident[]>()
  const lengths = new Map<number, number>()
  const explicit = new Set<number>()
  const rank: Record<RoadRole, number> = { main: 0, branch: 1, access: 2 }

  for (const path of physical.physicalPaths) {
    const edge = model.edges.get(path.representativeEdgeId)
    if (edge === undefined) continue
    const nodes = [model.nodes.get(edge.snodeId), model.nodes.get(edge.enodeId)]
    const isolated = nodes.every((node) => node !== undefined && (network.nodeDegree.get(node.id) ?? 0) <= 1)
    const access = nodes.some((node) => node !== undefined && (
      node.category === 'warehouse' || node.category === 'charge' || node.category === 'park' ||
      (isolated && model.nodeVisualRoles.get(node.id) === 'storage-slot' && edge.length <= ROAD_ACCESS_MAX_LENGTH_M)
    ))
    const configured = path.logicalEdgeIds.map((id) => overrides.get(id))
      .filter((role): role is RoadRole => role !== undefined)
      .sort((a, b) => rank[b] - rank[a])[0]
    roles.set(path.index, configured ?? (access ? 'access' : 'branch'))
    if (configured !== undefined) explicit.add(path.index)
    let length = 0
    for (let i = 1; i < path.points.length; i += 1) {
      length += Math.hypot(path.points[i].x - path.points[i - 1].x, path.points[i].y - path.points[i - 1].y)
    }
    lengths.set(path.index, length)
    if (roles.get(path.index) === 'access') continue
    const first = path.points[0]
    const sourceFirst = Math.hypot(first.x - edge.sx, first.y - edge.sy) < 1e-6
    for (const atStart of [true, false]) {
      const points = atStart ? path.points : [...path.points].reverse()
      const origin = points[0]
      const next = points.find((p) => Math.hypot(p.x - origin.x, p.y - origin.y) > 1e-6)
      if (next === undefined) continue
      const nodeId = atStart === sourceFirst ? edge.snodeId : edge.enodeId
      const distance = Math.hypot(next.x - origin.x, next.y - origin.y)
      const list = incidents.get(nodeId) ?? []
      list.push({ pathIndex: path.index, dx: (next.x - origin.x) / distance, dy: (next.y - origin.y) / distance })
      incidents.set(nodeId, list)
    }
  }

  /**
   * 仓储接入常先经过一两个 work 控制点，再抵达 warehouse，原始度数并非一。
   * 在排除设施边后识别这类短末梢，整段长度受限，不能沿叶子递归剥掉整条巷道。
   */
  for (const [nodeId, list] of incidents) {
    if (list.length !== 1 || model.nodeVisualRoles.get(nodeId) !== 'storage-slot') continue
    const stub: number[] = []
    let length = 0
    let cursor = nodeId
    let next: Incident | undefined = list[0]
    while (next !== undefined && !stub.includes(next.pathIndex)) {
      if (explicit.has(next.pathIndex)) break
      stub.push(next.pathIndex)
      length += lengths.get(next.pathIndex) ?? 0
      if (length > ROAD_ACCESS_MAX_LENGTH_M) break
      const path = physical.physicalPaths[next.pathIndex]
      const edge = model.edges.get(path.representativeEdgeId)!
      cursor = edge.snodeId === cursor ? edge.enodeId : edge.snodeId
      const neighbors = incidents.get(cursor) ?? []
      if (neighbors.length !== 2) {
        for (const index of stub) roles.set(index, 'access')
        break
      }
      const previousIndex: number = next.pathIndex
      next = neighbors.find((incident) => incident.pathIndex !== previousIndex)
    }
  }

  const continuations = new Map<number, Set<number>>()
  for (const allIncidents of incidents.values()) {
    const list = allIncidents.filter((incident) => roles.get(incident.pathIndex) !== 'access')
    const best = new Map<Incident, Incident>()
    for (const a of list) {
      let score = ROAD_CONTINUATION_COS
      for (const b of list) {
        const alignment = -(a.dx * b.dx + a.dy * b.dy)
        if (a.pathIndex !== b.pathIndex && alignment > score) {
          best.set(a, b)
          score = alignment
        }
      }
    }
    for (const [a, b] of best) {
      if (best.get(b) !== a) continue
      const neighbors = continuations.get(a.pathIndex) ?? new Set<number>()
      neighbors.add(b.pathIndex)
      continuations.set(a.pathIndex, neighbors)
    }
  }

  /**
   * 连续长度按原始折线弧长累计；只改变视觉级别，曲线采样和逻辑方向保持原状。
   * 显式配置的路径不参与自动升级，孤立短边默认保留为支路。
   */
  const visited = new Set<number>()
  for (const [seed, role] of roles) {
    if (role === 'access' || visited.has(seed)) continue
    const run: number[] = []
    const pending = [seed]
    let length = 0
    while (pending.length > 0) {
      const index = pending.pop()!
      if (visited.has(index)) continue
      visited.add(index)
      run.push(index)
      length += lengths.get(index) ?? 0
      pending.push(...continuations.get(index) ?? [])
    }
    if (length >= ROAD_MAIN_MIN_LENGTH_M) {
      for (const index of run) {
        if (!explicit.has(index)) roles.set(index, 'main')
      }
    }
  }
  return roles
}
