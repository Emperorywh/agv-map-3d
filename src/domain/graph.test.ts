import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { buildRouteGraph, findNearestRoute, findRoute } from './graph'
import { normalizeMapFromJson } from './normalize'
import { buildPolyline } from './polyline'
import type { MapPoint, NormalizedEdge } from './types'

// ---------------------------------------------------------------------------
// 测试夹具：直接构造规范化有向边（LINE 折线）
// ---------------------------------------------------------------------------

function makeEdge(
  id: string,
  from: string,
  to: string,
  overrides?: {
    points?: MapPoint[]
    cost?: number
    maxSpeedFree?: number | null
  },
): NormalizedEdge {
  return {
    id,
    name: id,
    from,
    to,
    geometry: buildPolyline(overrides?.points ?? [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]),
    sFacing: 0,
    eFacing: 0,
    isBackEdge: false,
    cost: overrides?.cost ?? 1,
    maxSpeedLoad: null,
    maxSpeedFree: overrides?.maxSpeedFree ?? null,
    maxRotationSpeedLoad: null,
    maxRotationSpeedFree: null,
    maxAccelerationLoad: null,
    maxAccelerationFree: null,
    maxDecelerationLoad: null,
    maxDecelerationFree: null,
  }
}

describe('graph：邻接表构建（SPEC §7.1）', () => {
  it('按有向边生成出弧邻接表，方向保留、互不合并', () => {
    const graph = buildRouteGraph([
      makeEdge('e1', 'A', 'B'),
      makeEdge('e2', 'B', 'A'),
      makeEdge('e3', 'B', 'C'),
    ])

    expect(graph.arcCount).toBe(3)
    expect(graph.adjacency.get('A')).toHaveLength(1)
    expect(graph.adjacency.get('B')).toHaveLength(2)
    expect(graph.adjacency.get('C')).toBeUndefined()
    const arc = graph.adjacency.get('A')![0]
    expect(arc.edgeId).toBe('e1')
    expect(arc.from).toBe('A')
    expect(arc.to).toBe('B')
    expect(arc.length).toBeCloseTo(10)
  })

  it("权重模式 'lengthOverSpeed'：权重 = 边长 / 限速；限速 null 用缺省速度兜底", () => {
    const graph = buildRouteGraph(
      [
        makeEdge('e1', 'A', 'B', { maxSpeedFree: 2 }),
        makeEdge('e2', 'B', 'C', { maxSpeedFree: null }),
      ],
      { weightMode: 'lengthOverSpeed', defaultSpeed: 2.5 },
    )
    expect(graph.adjacency.get('A')![0].weight).toBeCloseTo(10 / 2)
    expect(graph.adjacency.get('B')![0].weight).toBeCloseTo(10 / 2.5)
  })

  it('限速为 0 / 负数视为无效，用缺省速度兜底', () => {
    const graph = buildRouteGraph(
      [makeEdge('e1', 'A', 'B', { maxSpeedFree: 0 }), makeEdge('e2', 'B', 'C', { maxSpeedFree: -1 })],
      { defaultSpeed: 4 },
    )
    expect(graph.adjacency.get('A')![0].weight).toBeCloseTo(10 / 4)
    expect(graph.adjacency.get('B')![0].weight).toBeCloseTo(10 / 4)
  })

  it("权重模式 'cost'：权重 = 边 cost，与边长无关；负 cost 兜底为非负", () => {
    const graph = buildRouteGraph(
      [makeEdge('e1', 'A', 'B', { cost: 7 }), makeEdge('e2', 'B', 'C', { cost: -3 })],
      { weightMode: 'cost' },
    )
    expect(graph.weightMode).toBe('cost')
    expect(graph.adjacency.get('A')![0].weight).toBe(7)
    expect(graph.adjacency.get('B')![0].weight).toBe(0)
  })
})

describe('graph：Dijkstra 正确性（SPEC §7.1）', () => {
  // A --e1(len10,v1,w10)--> B；A --e2(len4,v2,w2)--> C --e3(len4,v2,w2)--> B
  const edges = () => [
    makeEdge('e1', 'A', 'B', { maxSpeedFree: 1 }),
    makeEdge('e2', 'A', 'C', {
      points: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
      ],
      maxSpeedFree: 2,
    }),
    makeEdge('e3', 'C', 'B', {
      points: [
        { x: 4, y: 0 },
        { x: 8, y: 0 },
      ],
      maxSpeedFree: 2,
    }),
  ]

  it('选出总权重最小路径并给出途经节点 / 边 / 代价 / 长度', () => {
    const graph = buildRouteGraph(edges())
    const result = findRoute(graph, 'A', 'B')
    expect(result.reachable).toBe(true)
    if (!result.reachable) return
    // A→C→B 代价 4 < A→B 代价 10
    expect(result.route.nodeIds).toEqual(['A', 'C', 'B'])
    expect(result.route.edgeIds).toEqual(['e2', 'e3'])
    expect(result.route.cost).toBeCloseTo(4)
    expect(result.route.length).toBeCloseTo(8)
  })

  it("权重模式 'cost' 下按 cost 选路，可与 'lengthOverSpeed' 结论不同", () => {
    const timed = buildRouteGraph(edges(), { weightMode: 'lengthOverSpeed' })
    const costed = buildRouteGraph(
      [
        makeEdge('e1', 'A', 'B', { cost: 100 }),
        makeEdge('e2', 'A', 'C', { cost: 1 }),
        makeEdge('e3', 'C', 'B', { cost: 100 }),
      ],
      { weightMode: 'cost' },
    )
    const byTime = findRoute(timed, 'A', 'B')
    const byCost = findRoute(costed, 'A', 'B')
    expect(byTime.reachable && byTime.route.edgeIds).toEqual(['e2', 'e3'])
    // cost：直达 100 < 经 C 101
    expect(byCost.reachable && byCost.route.edgeIds).toEqual(['e1'])
  })

  it('起点即终点：返回空路径（cost 0），可达', () => {
    const graph = buildRouteGraph(edges())
    const result = findRoute(graph, 'A', 'A')
    expect(result.reachable).toBe(true)
    if (!result.reachable) return
    expect(result.route.nodeIds).toEqual(['A'])
    expect(result.route.edgeIds).toEqual([])
    expect(result.route.cost).toBe(0)
  })

  it('等代价路径按节点 id 字典序确定选择（确定性）', () => {
    const graph = buildRouteGraph([
      makeEdge('e1', 'A', 'B', { maxSpeedFree: 1 }),
      makeEdge('e2', 'A', 'C', { maxSpeedFree: 1 }),
      makeEdge('e3', 'B', 'D', { maxSpeedFree: 1 }),
      makeEdge('e4', 'C', 'D', { maxSpeedFree: 1 }),
    ])
    const result = findRoute(graph, 'A', 'D')
    expect(result.reachable).toBe(true)
    if (!result.reachable) return
    // 两条等代价路径 A→B→D / A→C→D，B < C 字典序优先
    expect(result.route.nodeIds).toEqual(['A', 'B', 'D'])
    expect(result.route.cost).toBeCloseTo(20)
  })
})

describe('graph：不可达处理（SPEC §7.1：返回不可达而非异常）', () => {
  const graph = buildRouteGraph([makeEdge('e1', 'A', 'B')])

  it('反向无边 / 不存在通路：reachable=false，不抛异常', () => {
    const result = findRoute(graph, 'B', 'A')
    expect(result.reachable).toBe(false)
  })

  it('起点或终点不在图中：reachable=false', () => {
    expect(findRoute(graph, 'ZZ', 'A').reachable).toBe(false)
    expect(findRoute(graph, 'A', 'ZZ').reachable).toBe(false)
    expect(findRoute(buildRouteGraph([]), 'A', 'B').reachable).toBe(false)
  })

  it('findNearestRoute：候选为空 / 全部不可达时返回 null', () => {
    expect(findNearestRoute(graph, 'A', [])).toBeNull()
    expect(findNearestRoute(graph, 'A', ['ZZ1', 'ZZ2'])).toBeNull()
    // 起点无任何出边
    expect(findNearestRoute(graph, 'B', ['A', 'C'])).toBeNull()
  })

  it('findNearestRoute：跳过不可达候选，选可达中路径代价最小者', () => {
    // S→X(w1)→T1(w1) 总代价 2；S→T2 直达代价 10；T3 不可达
    const g = buildRouteGraph([
      makeEdge('e1', 'S', 'X', {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
        maxSpeedFree: 1,
      }),
      makeEdge('e2', 'X', 'T1', {
        points: [
          { x: 1, y: 0 },
          { x: 2, y: 0 },
        ],
        maxSpeedFree: 1,
      }),
      makeEdge('e3', 'S', 'T2', { maxSpeedFree: 1 }),
      makeEdge('e4', 'Q', 'T3'),
    ])
    const nearest = findNearestRoute(g, 'S', ['T1', 'T2', 'T3'])
    expect(nearest).not.toBeNull()
    // 路径代价 T1=2 < T2=10 ——“最近”按路径权重代价度量，与欧氏距离无关
    expect(nearest!.target).toBe('T1')
    expect(nearest!.route.cost).toBeCloseTo(2)
    expect(nearest!.route.edgeIds).toEqual(['e1', 'e2'])
  })

  it('findNearestRoute：起点本身在候选中返回原地空路径', () => {
    const nearest = findNearestRoute(graph, 'A', ['A', 'B'])
    expect(nearest).not.toBeNull()
    expect(nearest!.target).toBe('A')
    expect(nearest!.route.edgeIds).toEqual([])
    expect(nearest!.route.cost).toBe(0)
  })
})

describe('graph：真实 map.json 集成（SPEC §4.1 / §7.1）', () => {
  const mapJsonPath = fileURLToPath(new URL('../../public/map.json', import.meta.url))
  const { map } = normalizeMapFromJson(readFileSync(mapJsonPath, 'utf8'))

  it('3043 条有向边全部入邻接表；有向可达性按方向判定', () => {
    const graph = buildRouteGraph(map.edges)
    expect(graph.arcCount).toBe(3043)
    let outgoingArcs = 0
    for (const arcs of graph.adjacency.values()) {
      outgoingArcs += arcs.length
    }
    expect(outgoingArcs).toBe(3043)

    // 任一条真实边的 from → to 必可达（直达弧），路径首尾一致、边链连续
    const edge = map.edges[0]
    const result = findRoute(graph, edge.from, edge.to)
    expect(result.reachable).toBe(true)
    if (!result.reachable) return
    expect(result.route.nodeIds[0]).toBe(edge.from)
    expect(result.route.nodeIds[result.route.nodeIds.length - 1]).toBe(edge.to)
    const edgeById = new Map(map.edges.map((item) => [item.id, item]))
    for (let i = 0; i < result.route.edgeIds.length; i++) {
      const routeEdge = edgeById.get(result.route.edgeIds[i])!
      expect(routeEdge.from).toBe(result.route.nodeIds[i])
      expect(routeEdge.to).toBe(result.route.nodeIds[i + 1])
    }
  })

  it('最近空闲充电位：按路径代价在 11 个 charge 节点中选最近者', () => {
    const graph = buildRouteGraph(map.edges)
    const chargeIds = map.nodes.filter((node) => node.kind === 'charge').map((node) => node.id)
    expect(chargeIds).toHaveLength(11)
    // 取一条直接进入 charge 节点的边，其起点必可达该 charge 节点
    const incoming = map.edges.find((edge) => chargeIds.includes(edge.to))!
    const nearest = findNearestRoute(graph, incoming.from, chargeIds)
    expect(nearest).not.toBeNull()
    expect(chargeIds).toContain(nearest!.target)
    // 最近代价不超过该直达弧的权重（lengthOverSpeed：边长 / 限速，null 兜底缺省 2）
    const speed = incoming.maxSpeedFree !== null && incoming.maxSpeedFree > 0 ? incoming.maxSpeedFree : 2
    expect(nearest!.route.cost).toBeLessThanOrEqual(incoming.geometry.length / speed + 1e-9)
  })
})
