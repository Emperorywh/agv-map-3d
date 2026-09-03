/*
 * 道路拓扑重建测试（视觉对齐 P0-5.3；与实现共置）。
 *
 * 职责：用合成地图锁定 buildRoadNetwork 的拓扑合同：
 * 1. 二度节点被合并穿越：连续道路成为单条链，采样点首尾相接无重复；
 * 2. 交叉节点（度数 ≥3）恰一识别，且为链端点；
 * 3. 断头路径（两端度数 1）自成一链；
 * 4. 同节点对的不同几何平行路径不合并（各自成链）；
 * 5. 环路（全部二度节点）成一条链且每条路径只入链一次；
 * 6. 度数按物理路径端计数，正反向重合边不重复计数。
 */
import { describe, expect, it } from 'vitest'
import { createMapModel } from '@/features/map-visualization/model/createMapModel'
import { validateMap } from '@/features/map-visualization/model/validateMap'
import { dedupePhysicalPaths } from '@/features/map-visualization/scene/buildMapGeometry'
import { buildRoadNetwork } from '@/features/map-visualization/scene/roadTopology'
import { makeBezierEdge, makeLineEdge, makeNode } from './fixtures'

function buildModel(raw: {
  nodes: Record<string, unknown>[]
  edges: Record<string, unknown>[]
}) {
  const { mapModel } = createMapModel(
    validateMap({
      nodes: raw.nodes,
      edges: raw.edges,
      zones: [],
      nodeEdgeGroups: [],
    }),
  )
  const physical = dedupePhysicalPaths(mapModel)
  return { mapModel, network: buildRoadNetwork(mapModel, physical) }
}

describe('buildRoadNetwork：链合并与交叉识别', () => {
  it('十字交叉：四条路径各自成链、全部止于交叉节点（交叉节点不穿越合并）', () => {
    // a—x—b 与 c—x—d（x 四岔）：只有二度节点才被穿越合并，x 保持链端点
    const { network } = buildModel({
      nodes: [
        makeNode({ id: 'a', x: 0, y: 0 }),
        makeNode({ id: 'x', x: 5, y: 0 }),
        makeNode({ id: 'b', x: 10, y: 0 }),
        makeNode({ id: 'c', x: 5, y: -5 }),
        makeNode({ id: 'd', x: 5, y: 5 }),
      ],
      edges: [
        makeLineEdge({ id: 'e1', snodeId: 'a', enodeId: 'x', sx: 0, sy: 0, ex: 5, ey: 0 }),
        makeLineEdge({ id: 'e2', snodeId: 'x', enodeId: 'b', sx: 5, sy: 0, ex: 10, ey: 0 }),
        makeLineEdge({ id: 'e3', snodeId: 'c', enodeId: 'x', sx: 5, sy: -5, ex: 5, ey: 0 }),
        makeLineEdge({ id: 'e4', snodeId: 'x', enodeId: 'd', sx: 5, sy: 0, ex: 5, ey: 5 }),
      ],
    })

    expect(network.chains).toHaveLength(4)
    expect(network.junctions).toHaveLength(1)
    expect(network.junctions[0]).toMatchObject({ nodeId: 'x', degree: 4 })
    for (const chain of network.chains) {
      // 每条链恰有一端是交叉节点 x，另一端是叶子节点
      const ends = [chain.startNodeId, chain.endNodeId].sort()
      expect(ends.filter((id) => id === 'x')).toHaveLength(1)
      expect(chain.points).toHaveLength(2)
    }
    // 全部 4 条物理路径各入一条链，无遗漏无重复
    const covered = network.chains.flatMap((chain) => chain.pathIndexes)
    expect(new Set(covered).size).toBe(4)
  })

  it('T 型交叉 + 两侧延伸：链经二度节点合并至交叉节点为止', () => {
    // a—b—x、c—x、x—d：x 三岔（度数 3）→ 链 a→x；c→x 与 x→d 各自成链
    const { network } = buildModel({
      nodes: [
        makeNode({ id: 'a', x: -10, y: 0 }),
        makeNode({ id: 'b', x: -5, y: 0 }),
        makeNode({ id: 'x', x: 0, y: 0 }),
        makeNode({ id: 'c', x: 0, y: 6 }),
        makeNode({ id: 'd', x: 5, y: 0 }),
      ],
      edges: [
        makeLineEdge({ id: 'e1', snodeId: 'a', enodeId: 'b', sx: -10, sy: 0, ex: -5, ey: 0 }),
        makeLineEdge({ id: 'e2', snodeId: 'b', enodeId: 'x', sx: -5, sy: 0, ex: 0, ey: 0 }),
        makeLineEdge({ id: 'e3', snodeId: 'c', enodeId: 'x', sx: 0, sy: 6, ex: 0, ey: 0 }),
        makeLineEdge({ id: 'e4', snodeId: 'x', enodeId: 'd', sx: 0, sy: 0, ex: 5, ey: 0 }),
      ],
    })

    expect(network.chains).toHaveLength(3)
    expect(network.junctions).toHaveLength(1)
    expect(network.junctions[0].degree).toBe(3)
    const merged = network.chains.find((chain) => chain.pathIndexes.length === 2)
    expect(merged).toBeDefined()
    expect(merged!.startNodeId).toBe('a')
    expect(merged!.endNodeId).toBe('x')
    expect(merged!.points).toHaveLength(3)
    expect(network.mergedNodeCount).toBe(1)
  })

  it('二度节点被穿越：链采样点连续且无重复点；mergedNodeCount 正确', () => {
    // a—b—c 直线：b 二度 → 一条链 a→c，点数 = 2 + 2 - 1（共享点去重）
    const { network } = buildModel({
      nodes: [
        makeNode({ id: 'a', x: 0, y: 0 }),
        makeNode({ id: 'b', x: 3, y: 0 }),
        makeNode({ id: 'c', x: 7, y: 0 }),
      ],
      edges: [
        makeLineEdge({ id: 'e1', snodeId: 'a', enodeId: 'b', sx: 0, sy: 0, ex: 3, ey: 0 }),
        makeLineEdge({ id: 'e2', snodeId: 'b', enodeId: 'c', sx: 3, sy: 0, ex: 7, ey: 0 }),
      ],
    })

    expect(network.chains).toHaveLength(1)
    expect(network.junctions).toHaveLength(0)
    expect(network.mergedNodeCount).toBe(1)
    const chain = network.chains[0]
    expect(chain.startNodeId).toBe('a')
    expect(chain.endNodeId).toBe('c')
    expect(chain.points).toHaveLength(3)
    expect(chain.points[0]).toEqual({ x: 0, y: 0 })
    expect(chain.points[1]).toEqual({ x: 3, y: 0 })
    expect(chain.points[2]).toEqual({ x: 7, y: 0 })
  })

  it('断头路径（两端度数 1）自成一链', () => {
    const { network } = buildModel({
      nodes: [
        makeNode({ id: 'a', x: 0, y: 0 }),
        makeNode({ id: 'b', x: 4, y: 0 }),
      ],
      edges: [
        makeLineEdge({ id: 'e1', snodeId: 'a', enodeId: 'b', sx: 0, sy: 0, ex: 4, ey: 0 }),
      ],
    })

    expect(network.chains).toHaveLength(1)
    expect(network.chains[0].startNodeId).toBe('a')
    expect(network.chains[0].endNodeId).toBe('b')
    expect(network.junctions).toHaveLength(0)
    expect(network.nodeDegree.get('a')).toBe(1)
    expect(network.nodeDegree.get('b')).toBe(1)
  })

  it('同节点对的平行不同几何路径：两端节点均为二度 → 合并为一条闭环链', () => {
    // 直线 a→b 与曲线 a→b：a、b 各有两条邻接路径（度数 2）→ 链穿越合并，
    // 几何上构成一条连续（往返）链；不按节点对强行合并或拆分
    const { network } = buildModel({
      nodes: [
        makeNode({ id: 'a', x: 0, y: 0 }),
        makeNode({ id: 'b', x: 3, y: 0 }),
      ],
      edges: [
        makeLineEdge({ id: 'e1', snodeId: 'a', enodeId: 'b', sx: 0, sy: 0, ex: 3, ey: 0 }),
        makeBezierEdge({ id: 'e2', snodeId: 'a', enodeId: 'b', sx: 0, sy: 0, cx: 1, cy: 2, dx: 2, dy: 2, ex: 3, ey: 0 }),
      ],
    })

    expect(network.chains).toHaveLength(1)
    expect(network.chains[0].pathIndexes).toHaveLength(2)
    expect(network.chains[0].startNodeId).toBe(network.chains[0].endNodeId)
    // 每条物理路径只入链一次，采样点无重复：2（直线）+ 24（曲线去共享点）
    const chain = network.chains[0]
    expect(chain.points).toHaveLength(26)
  })

  it('闭环（全部二度节点）成一条链，每条路径只入链一次', () => {
    // a—b—c—d—a 方形环：全部节点二度 → 单条链覆盖 4 条路径
    const { network } = buildModel({
      nodes: [
        makeNode({ id: 'a', x: 0, y: 0 }),
        makeNode({ id: 'b', x: 4, y: 0 }),
        makeNode({ id: 'c', x: 4, y: 4 }),
        makeNode({ id: 'd', x: 0, y: 4 }),
      ],
      edges: [
        makeLineEdge({ id: 'e1', snodeId: 'a', enodeId: 'b', sx: 0, sy: 0, ex: 4, ey: 0 }),
        makeLineEdge({ id: 'e2', snodeId: 'b', enodeId: 'c', sx: 4, sy: 0, ex: 4, ey: 4 }),
        makeLineEdge({ id: 'e3', snodeId: 'c', enodeId: 'd', sx: 4, sy: 4, ex: 0, ey: 4 }),
        makeLineEdge({ id: 'e4', snodeId: 'd', enodeId: 'a', sx: 0, sy: 4, ex: 0, ey: 0 }),
      ],
    })

    expect(network.chains).toHaveLength(1)
    const chain = network.chains[0]
    expect(chain.pathIndexes).toHaveLength(4)
    // 4 条路径 × 2 点 − 4 个共享节点 = 5 个采样点（首尾同点闭合）
    expect(chain.points).toHaveLength(5)
    expect(chain.points[0]).toEqual(chain.points[chain.points.length - 1])
    // 起点与终点同为出发节点（闭合回到起点，不再绕行）
    expect(chain.startNodeId).toBe(chain.endNodeId)
    expect(new Set(chain.pathIndexes).size).toBe(4)
  })

  it('正反向重合逻辑边只产生一条物理路径，度数不重复计数', () => {
    const { network } = buildModel({
      nodes: [
        makeNode({ id: 'a', x: 0, y: 0 }),
        makeNode({ id: 'b', x: 4, y: 0 }),
      ],
      edges: [
        makeLineEdge({ id: 'e1', snodeId: 'a', enodeId: 'b', sx: 0, sy: 0, ex: 4, ey: 0 }),
        makeLineEdge({ id: 'e2', snodeId: 'b', enodeId: 'a', sx: 4, sy: 0, ex: 0, ey: 0, isBackEdge: true }),
      ],
    })

    expect(network.nodeDegree.get('a')).toBe(1)
    expect(network.nodeDegree.get('b')).toBe(1)
    expect(network.chains[0].pathIndexes).toHaveLength(1)
  })
})
