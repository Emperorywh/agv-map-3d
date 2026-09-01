/**
 * Mock 有向寻路单元测试（TASK-008：严格方向、代价回退物理长度、最近充电点）。
 */
import { describe, expect, it } from 'vitest'
import {
  findDirectedPath,
  findNearestChargePath,
} from '@/features/mock-simulation/model/pathfinding'
import { buildModel, makeLineEdge, makeNode } from './fixtures'

/** 有向链 A→B→C（无反向边）：验证 Dijkstra 不借道逆向 */
function buildDirectedChain() {
  return buildModel({
    nodes: [
      makeNode({ id: 'a', x: 0, y: 0 }),
      makeNode({ id: 'b', x: 10, y: 0 }),
      makeNode({ id: 'c', x: 20, y: 0 }),
    ],
    edges: [
      makeLineEdge({ id: 'e-ab', sx: 0, sy: 0, ex: 10, ey: 0, snodeId: 'a', enodeId: 'b' }),
      makeLineEdge({ id: 'e-bc', sx: 10, sy: 0, ex: 20, ey: 0, snodeId: 'b', enodeId: 'c' }),
    ],
  })
}

describe('findDirectedPath', () => {
  it('沿有向边正方向可达', () => {
    const model = buildDirectedChain()
    const path = findDirectedPath(model, 'a', 'c')
    expect(path).not.toBeNull()
    expect(path!.edgeIds).toEqual(['e-ab', 'e-bc'])
    expect(path!.totalCost).toBeCloseTo(20, 9)
  })

  it('单向不可达返回 null（不逆行、不瞬移）', () => {
    const model = buildDirectedChain()
    expect(findDirectedPath(model, 'c', 'a')).toBeNull()
    expect(findDirectedPath(model, 'c', 'b')).toBeNull()
  })

  it('起点即目标返回空路径（代价 0）', () => {
    const model = buildDirectedChain()
    const path = findDirectedPath(model, 'b', 'b')
    expect(path).not.toBeNull()
    expect(path!.edgeIds).toEqual([])
    expect(path!.totalCost).toBe(0)
  })

  it('跨弱连通分量不可达', () => {
    const model = buildModel({
      nodes: [
        makeNode({ id: 'a', x: 0, y: 0 }),
        makeNode({ id: 'b', x: 5, y: 0 }),
        makeNode({ id: 'x', x: 100, y: 100 }),
        makeNode({ id: 'y', x: 105, y: 100 }),
      ],
      edges: [
        makeLineEdge({ id: 'e-ab', sx: 0, sy: 0, ex: 5, ey: 0, snodeId: 'a', enodeId: 'b' }),
        makeLineEdge({ id: 'e-xy', sx: 100, sy: 100, ex: 105, ey: 100, snodeId: 'x', enodeId: 'y' }),
      ],
    })
    expect(findDirectedPath(model, 'a', 'y')).toBeNull()
    expect(model.components).toHaveLength(2)
  })

  it('代价非法（非正/非有限）时回退物理长度选择路径', () => {
    // 直达边长 10 但业务代价非法；绕行两段各长 4+4、代价合法 3+3
    const model = buildModel({
      nodes: [
        makeNode({ id: 'a', x: 0, y: 0 }),
        makeNode({ id: 'b', x: 10, y: 0 }),
        makeNode({ id: 'm', x: 5, y: 4 }),
      ],
      edges: [
        makeLineEdge({
          id: 'e-direct', sx: 0, sy: 0, ex: 10, ey: 0,
          cost: -1, snodeId: 'a', enodeId: 'b',
        }),
        makeLineEdge({
          id: 'e-am', sx: 0, sy: 0, ex: 5, ey: 4,
          cost: 3, snodeId: 'a', enodeId: 'm',
        }),
        makeLineEdge({
          id: 'e-mb', sx: 5, sy: 4, ex: 10, ey: 0,
          cost: 3, snodeId: 'm', enodeId: 'b',
        }),
      ],
    })
    const path = findDirectedPath(model, 'a', 'b')
    expect(path!.edgeIds).toEqual(['e-am', 'e-mb'])
    expect(path!.totalCost).toBe(6)
  })

  it('代价全部非法时按物理长度取最短', () => {
    const model = buildModel({
      nodes: [
        makeNode({ id: 'a', x: 0, y: 0 }),
        makeNode({ id: 'b', x: 10, y: 0 }),
        makeNode({ id: 'm', x: 5, y: 1 }),
      ],
      edges: [
        makeLineEdge({
          id: 'e-long', sx: 0, sy: 0, ex: 10, ey: 0,
          cost: Number.NaN, snodeId: 'a', enodeId: 'b',
        }),
        makeLineEdge({
          id: 'e-am', sx: 0, sy: 0, ex: 5, ey: 1,
          cost: 0, snodeId: 'a', enodeId: 'm',
        }),
        makeLineEdge({
          id: 'e-mb', sx: 5, sy: 1, ex: 10, ey: 0,
          cost: null, snodeId: 'm', enodeId: 'b',
        }),
      ],
    })
    // 直达长度 10；绕行长度 sqrt(26)*2 ≈ 10.198 → 直达更短
    const path = findDirectedPath(model, 'a', 'b')
    expect(path!.edgeIds).toEqual(['e-long'])
    expect(path!.totalCost).toBeCloseTo(10, 9)
  })
})

describe('findNearestChargePath', () => {
  it('选择同分量内代价最低的可达 charge（最近充电点）', () => {
    // S→C1 长 4；S→M→C2 总长 8。C1 更近
    const model = buildModel({
      nodes: [
        makeNode({ id: 's', x: 0, y: 0 }),
        makeNode({ id: 'm', x: 4, y: 0 }),
        makeNode({ id: 'c1', type: 'charge', x: 4, y: 0 }),
        makeNode({ id: 'c2', type: 'charge', x: 8, y: 0 }),
      ],
      edges: [
        makeLineEdge({ id: 'e-s-c1', sx: 0, sy: 0, ex: 4, ey: 0, snodeId: 's', enodeId: 'c1' }),
        makeLineEdge({ id: 'e-s-m', sx: 0, sy: 0, ex: 4, ey: 0, snodeId: 's', enodeId: 'm' }),
        makeLineEdge({ id: 'e-m-c2', sx: 4, sy: 0, ex: 8, ey: 0, snodeId: 'm', enodeId: 'c2' }),
      ],
    })
    const path = findNearestChargePath(model, 's', 0)
    expect(path).not.toBeNull()
    expect(path!.goalNodeId).toBe('c1')
    expect(path!.edgeIds).toEqual(['e-s-c1'])
  })

  it('方向不可达的 charge 不被选中（不逆行寻充）', () => {
    // C1 在 S 的下游反方向（C1→S 单向），S 只能到达 C2
    const model = buildModel({
      nodes: [
        makeNode({ id: 's', x: 0, y: 0 }),
        makeNode({ id: 'c1', type: 'charge', x: -5, y: 0 }),
        makeNode({ id: 'c2', type: 'charge', x: 6, y: 0 }),
      ],
      edges: [
        makeLineEdge({ id: 'e-c1-s', sx: -5, sy: 0, ex: 0, ey: 0, snodeId: 'c1', enodeId: 's' }),
        makeLineEdge({ id: 'e-s-c2', sx: 0, sy: 0, ex: 6, ey: 0, snodeId: 's', enodeId: 'c2' }),
      ],
    })
    const path = findNearestChargePath(model, 's', 0)
    expect(path).not.toBeNull()
    expect(path!.goalNodeId).toBe('c2')
  })

  it('分量无 charge 或起点无效时返回 null', () => {
    const noCharge = buildModel({
      nodes: [
        makeNode({ id: 'a', x: 0, y: 0 }),
        makeNode({ id: 'b', x: 3, y: 0 }),
      ],
      edges: [
        makeLineEdge({ id: 'e-ab', sx: 0, sy: 0, ex: 3, ey: 0, snodeId: 'a', enodeId: 'b' }),
      ],
    })
    expect(findNearestChargePath(noCharge, 'a', 0)).toBeNull()
    const model = buildDirectedChain()
    expect(findNearestChargePath(model, 'ghost', 0)).toBeNull()
    expect(findNearestChargePath(model, 'a', 99)).toBeNull()
  })
})
