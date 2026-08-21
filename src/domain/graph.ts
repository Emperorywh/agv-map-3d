/**
 * 路径规划图（SPEC §7.1）：由 NormalizedMap 有向边构建邻接表 + Dijkstra 最短路径。
 *
 * - 权重二选一、构建期常量切换：'lengthOverSpeed' = 边长 / 限速（maxSpeedFree，
 *   null 或非正数用缺省速度兜底）；'cost' = 直接使用边 cost；
 * - 起点不可达目标时返回 { reachable: false }（findNearestRoute 返回 null），不抛异常；
 * - “最近目标”（如最近空闲充电位）按同一路径权重代价度量，不用欧氏距离（SPEC §7.1）。
 *
 * domain 层纯 TS：不 import three / react / config（SPEC §12），缺省速度等以参数注入。
 */

import type { NormalizedEdge } from './types'

/** 规划权重模式（SPEC §7.1 二选一，常量切换） */
export type GraphWeightMode = 'lengthOverSpeed' | 'cost'

/** 权重模式缺省值 */
export const DEFAULT_GRAPH_WEIGHT_MODE: GraphWeightMode = 'lengthOverSpeed'
/**
 * 'lengthOverSpeed' 模式下边限速为 null / 非正数时的缺省速度（m/s）。
 * 实测 2984/3043 条边速度字段为 null（SPEC §7.2），缺省兜底为必需。
 */
export const DEFAULT_GRAPH_SPEED = 2

export interface BuildRouteGraphOptions {
  /** 权重模式，缺省 DEFAULT_GRAPH_WEIGHT_MODE */
  weightMode?: GraphWeightMode
  /** 边限速 null 兜底速度（m/s），缺省 DEFAULT_GRAPH_SPEED */
  defaultSpeed?: number
}

/** 邻接表中的一条出弧（对应一条有向边） */
export interface GraphArc {
  /** 有向边 id */
  edgeId: string
  /** 弧起点节点 id */
  from: string
  /** 弧终点节点 id */
  to: string
  /** 边几何长度（米） */
  length: number
  /** 规划权重（构建期按 weightMode 固化，恒 ≥ 0） */
  weight: number
}

/** 路径规划图：节点 id → 出弧列表的邻接表 */
export interface RouteGraph {
  /** 构建期固化的权重模式 */
  readonly weightMode: GraphWeightMode
  /** 邻接表（仅含有出边的节点） */
  readonly adjacency: ReadonlyMap<string, readonly GraphArc[]>
  /** 弧总数（= 输入有向边数） */
  readonly arcCount: number
}

/** 从有向边构建邻接表（确定性：弧顺序与输入边顺序一致） */
export function buildRouteGraph(
  edges: readonly NormalizedEdge[],
  options?: BuildRouteGraphOptions,
): RouteGraph {
  const weightMode = options?.weightMode ?? DEFAULT_GRAPH_WEIGHT_MODE
  const defaultSpeed = options?.defaultSpeed ?? DEFAULT_GRAPH_SPEED

  const adjacency = new Map<string, GraphArc[]>()
  let arcCount = 0
  for (const edge of edges) {
    const speedLimit =
      edge.maxSpeedFree !== null && edge.maxSpeedFree > 0 ? edge.maxSpeedFree : defaultSpeed
    const rawWeight = weightMode === 'cost' ? edge.cost : edge.geometry.length / speedLimit
    const arc: GraphArc = {
      edgeId: edge.id,
      from: edge.from,
      to: edge.to,
      length: edge.geometry.length,
      // 负权重会破坏 Dijkstra 前提，脏数据兜底为非负（确定性）
      weight: Math.max(0, rawWeight),
    }
    let arcs = adjacency.get(edge.from)
    if (arcs === undefined) {
      arcs = []
      adjacency.set(edge.from, arcs)
    }
    arcs.push(arc)
    arcCount++
  }
  return { weightMode, adjacency, arcCount }
}

/** 一条可行路径（途经节点含起点与终点，边按行驶顺序） */
export interface Route {
  /** 途经节点 id（含起点、终点；原地路径仅含起点一项） */
  nodeIds: string[]
  /** 途经有向边 id（行驶顺序；原地路径为空数组） */
  edgeIds: string[]
  /** 总权重代价（按图 weightMode 口径） */
  cost: number
  /** 总几何长度（米） */
  length: number
}

/** 路径查询结果：不可达时 reachable=false，不抛异常（SPEC §7.1） */
export type RouteResult = { readonly reachable: true; readonly route: Route } | { readonly reachable: false }

/**
 * Dijkstra 单源最短路径：from → to。
 * from === to 时返回空路径（cost 0）；from / to 不在图中或不可达时返回 reachable=false。
 */
export function findRoute(graph: RouteGraph, from: string, to: string): RouteResult {
  if (from === to) {
    return { reachable: true, route: { nodeIds: [from], edgeIds: [], cost: 0, length: 0 } }
  }
  const settled = dijkstra(graph, from, (node) => node === to)
  const dist = settled.dist.get(to)
  if (dist === undefined) {
    return { reachable: false }
  }
  return { reachable: true, route: reconstructRoute(settled.prev, from, to, dist) }
}

/**
 * 单源 Dijkstra 到候选集合中“最近”的目标（按路径权重代价，不用欧氏距离，SPEC §7.1）。
 * 候选全部不可达或候选集为空时返回 null；from 本身在候选中时返回原地空路径。
 */
export function findNearestRoute(
  graph: RouteGraph,
  from: string,
  targets: readonly string[],
): { readonly target: string; readonly route: Route } | null {
  if (targets.length === 0) {
    return null
  }
  // 排序去重：等代价时按 id 字典序取先者，保证选择确定性
  const candidates = [...new Set(targets)].sort()
  if (candidates.includes(from)) {
    return { target: from, route: { nodeIds: [from], edgeIds: [], cost: 0, length: 0 } }
  }
  const remaining = new Set(candidates)
  const settled = dijkstra(graph, from, (node) => {
    remaining.delete(node)
    return remaining.size === 0
  })
  let bestTarget: string | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const target of candidates) {
    const dist = settled.dist.get(target)
    if (dist !== undefined && dist < bestDist) {
      bestDist = dist
      bestTarget = target
    }
  }
  if (bestTarget === null) {
    return null
  }
  return { target: bestTarget, route: reconstructRoute(settled.prev, from, bestTarget, bestDist) }
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/** Dijkstra 沉降结果 */
interface DijkstraSettled {
  /** 节点 → 最短代价 */
  dist: Map<string, number>
  /** 节点 → 到达它的前驱节点与弧（起点无前驱） */
  prev: Map<string, { node: string; arc: GraphArc }>
}

/**
 * 单源 Dijkstra（二叉堆）。
 * @param shouldStop 每次沉降节点后调用，返回 true 提前终止（目标已确定 / 候选集收敛）
 */
function dijkstra(
  graph: RouteGraph,
  source: string,
  shouldStop: (node: string) => boolean,
): DijkstraSettled {
  const dist = new Map<string, number>([[source, 0]])
  const prev = new Map<string, { node: string; arc: GraphArc }>()
  const heap = new MinHeap()
  heap.push(source, 0)

  while (heap.size > 0) {
    const { node, priority } = heap.pop()
    // 堆中过期条目（已被更小代价沉降）跳过
    if (priority > (dist.get(node) ?? Number.POSITIVE_INFINITY)) {
      continue
    }
    if (shouldStop(node)) {
      break
    }
    const arcs = graph.adjacency.get(node)
    if (arcs === undefined) {
      continue
    }
    for (const arc of arcs) {
      const nextDist = priority + arc.weight
      if (nextDist < (dist.get(arc.to) ?? Number.POSITIVE_INFINITY)) {
        dist.set(arc.to, nextDist)
        prev.set(arc.to, { node, arc })
        heap.push(arc.to, nextDist)
      }
    }
  }
  return { dist, prev }
}

/** 由前驱表回溯路径（起点 → 目标） */
function reconstructRoute(
  prev: Map<string, { node: string; arc: GraphArc }>,
  from: string,
  to: string,
  cost: number,
): Route {
  const nodeIds: string[] = [to]
  const edgeIds: string[] = []
  let length = 0
  let cursor = to
  while (cursor !== from) {
    const entry = prev.get(cursor)
    if (entry === undefined) {
      // 不会到达：调用方已确认目标已沉降；防御性返回空路径
      break
    }
    edgeIds.push(entry.arc.edgeId)
    length += entry.arc.length
    cursor = entry.node
    nodeIds.push(cursor)
  }
  nodeIds.reverse()
  edgeIds.reverse()
  return { nodeIds, edgeIds, cost, length }
}

/**
 * 二叉最小堆：按 (代价, 节点 id 字典序) 排序。
 * 代价相等时按节点 id 次序弹出，保证等代价路径选择的确定性。
 */
class MinHeap {
  private nodes: string[] = []
  private priorities: number[] = []

  get size(): number {
    return this.nodes.length
  }

  push(node: string, priority: number): void {
    this.nodes.push(node)
    this.priorities.push(priority)
    let i = this.nodes.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.less(i, parent)) {
        this.swap(i, parent)
        i = parent
      } else {
        break
      }
    }
  }

  pop(): { node: string; priority: number } {
    const topNode = this.nodes[0]
    const topPriority = this.priorities[0]
    const last = this.nodes.length - 1
    this.swap(0, last)
    this.nodes.pop()
    this.priorities.pop()
    let i = 0
    const n = this.nodes.length
    for (;;) {
      const left = 2 * i + 1
      const right = left + 1
      let smallest = i
      if (left < n && this.less(left, smallest)) smallest = left
      if (right < n && this.less(right, smallest)) smallest = right
      if (smallest === i) break
      this.swap(i, smallest)
      i = smallest
    }
    return { node: topNode, priority: topPriority }
  }

  private less(a: number, b: number): boolean {
    const pa = this.priorities[a]
    const pb = this.priorities[b]
    return pa !== pb ? pa < pb : this.nodes[a] < this.nodes[b]
  }

  private swap(a: number, b: number): void {
    ;[this.nodes[a], this.nodes[b]] = [this.nodes[b], this.nodes[a]]
    ;[this.priorities[a], this.priorities[b]] = [this.priorities[b], this.priorities[a]]
  }
}
