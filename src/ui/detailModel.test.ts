import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { normalizeMapFromJson } from '../domain/normalize'
import type { AgvSnapshot } from '../domain/simulator'
import type { NormalizedMap } from '../domain/types'
import {
  AGV_STATUS_LABELS,
  NODE_KIND_LABELS,
  buildAgvDetails,
  buildCorridorDetails,
  buildNodeDetails,
} from './detailModel'

// ---------------------------------------------------------------------------
// 测试夹具：最小合成地图（2 节点双向走廊 + 1 孤立节点）
// ---------------------------------------------------------------------------

function syntheticMap(): NormalizedMap {
  return {
    calibration: { scale: 1, rotationRad: 0, offsetX: 0, offsetY: 0 },
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 0 },
    floor: 1,
    nodes: [
      { id: 'n1', name: '站点甲', kind: 'work', x: 0, y: 0, angle: Math.PI / 2 },
      { id: 'n2', name: '站点乙', kind: 'charge', x: 10, y: 0, angle: null },
      { id: 'n3', name: '孤立点', kind: 'node', x: 5, y: 5, angle: null },
    ],
    edges: [
      {
        id: 'e12',
        name: '边甲乙',
        from: 'n1',
        to: 'n2',
        geometry: { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], cumulativeLengths: [0, 10], length: 10 },
        sFacing: 0,
        eFacing: 0,
        isBackEdge: false,
        cost: 1.5,
        maxSpeedLoad: 1.2,
        maxSpeedFree: 2.5,
        maxRotationSpeedLoad: null,
        maxRotationSpeedFree: null,
        maxAccelerationLoad: 0.6,
        maxAccelerationFree: null,
        maxDecelerationLoad: null,
        maxDecelerationFree: 1.1,
      },
      {
        id: 'e21',
        name: '边乙甲',
        from: 'n2',
        to: 'n1',
        geometry: { points: [{ x: 10, y: 0 }, { x: 0, y: 0 }], cumulativeLengths: [0, 10], length: 10 },
        sFacing: Math.PI,
        eFacing: Math.PI,
        isBackEdge: true,
        cost: 2.5,
        maxSpeedLoad: null,
        maxSpeedFree: 1.8,
        maxRotationSpeedLoad: null,
        maxRotationSpeedFree: null,
        maxAccelerationLoad: null,
        maxAccelerationFree: null,
        maxDecelerationLoad: null,
        maxDecelerationFree: null,
      },
      {
        id: 'e13',
        name: '边甲孤',
        from: 'n1',
        to: 'n3',
        geometry: { points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], cumulativeLengths: [0, Math.SQRT2 * 5], length: Math.SQRT2 * 5 },
        sFacing: Math.PI / 4,
        eFacing: Math.PI / 4,
        isBackEdge: false,
        cost: 1,
        maxSpeedLoad: null,
        maxSpeedFree: null,
        maxRotationSpeedLoad: null,
        maxRotationSpeedFree: null,
        maxAccelerationLoad: null,
        maxAccelerationFree: null,
        maxDecelerationLoad: null,
        maxDecelerationFree: null,
      },
    ],
    corridors: [
      {
        id: 'c:n1|n2',
        nodeA: 'n1',
        nodeB: 'n2',
        edgeIds: ['e12', 'e21'],
        geometry: { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], cumulativeLengths: [0, 10], length: 10 },
        bidirectional: true,
        directions: [
          { edgeId: 'e12', from: 'n1', to: 'n2', alongGeometry: true, isBack: false },
          { edgeId: 'e21', from: 'n2', to: 'n1', alongGeometry: false, isBack: true },
        ],
      },
      {
        id: 'c:n1|n3',
        nodeA: 'n1',
        nodeB: 'n3',
        edgeIds: ['e13'],
        geometry: { points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], cumulativeLengths: [0, Math.SQRT2 * 5], length: Math.SQRT2 * 5 },
        bidirectional: false,
        directions: [{ edgeId: 'e13', from: 'n1', to: 'n3', alongGeometry: true, isBack: false }],
      },
    ],
  }
}

function fakeSnapshot(overrides: Partial<AgvSnapshot>): AgvSnapshot {
  return {
    id: 0,
    status: 'hauling',
    battery: 66.6,
    edgeId: null,
    nodeId: null,
    task: null,
    position: { x: 0, y: 0, z: 0 },
    yaw: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 节点详情
// ---------------------------------------------------------------------------

describe('buildNodeDetails（SPEC §8.2 节点面板字段）', () => {
  const map = syntheticMap()

  it('返回名称 / 类型 / 坐标 / angle 与关联边列表（含双向两条 + 另一条出边）', () => {
    const details = buildNodeDetails(map, 'n1')
    expect(details).not.toBeNull()
    expect(details).toMatchObject({
      kind: 'node',
      id: 'n1',
      name: '站点甲',
      nodeKind: 'work',
      x: 0,
      y: 0,
    })
    expect(details!.angle).toBeCloseTo(Math.PI / 2, 6)
    expect(details!.edges.map((edge) => edge.id)).toEqual(['e12', 'e21', 'e13'])
    // 关联边携带端点名称解析与倒车标识
    expect(details!.edges[0]).toMatchObject({
      name: '边甲乙',
      fromId: 'n1',
      fromName: '站点甲',
      toId: 'n2',
      toName: '站点乙',
      isBackEdge: false,
    })
    expect(details!.edges[1].isBackEdge).toBe(true)
  })

  it('angle 为 null 的节点原样返回 null；无关联边时列表为空', () => {
    const details = buildNodeDetails(map, 'n3')
    expect(details!.angle).toBeNull()
    expect(details!.edges.map((edge) => edge.id)).toEqual(['e13'])
    expect(buildNodeDetails(map, 'n2')!.angle).toBeNull()
  })

  it('节点不存在返回 null', () => {
    expect(buildNodeDetails(map, 'missing')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 走廊详情
// ---------------------------------------------------------------------------

describe('buildCorridorDetails（SPEC §8.2 走廊面板字段）', () => {
  const map = syntheticMap()

  it('双向走廊：按方向分两组展示，两组有向属性各自独立（限速 / cost 可不同）', () => {
    const details = buildCorridorDetails(map, 'c:n1|n2')
    expect(details).not.toBeNull()
    expect(details).toMatchObject({
      kind: 'corridor',
      id: 'c:n1|n2',
      bidirectional: true,
      nodeAName: '站点甲',
      nodeBName: '站点乙',
    })
    expect(details!.length).toBeCloseTo(10, 6)
    expect(details!.directions).toHaveLength(2)
    // 方向一：n1→n2 正向行驶，自有 cost / 限速
    expect(details!.directions[0]).toMatchObject({
      edgeId: 'e12',
      edgeName: '边甲乙',
      fromName: '站点甲',
      toName: '站点乙',
      isBack: false,
      cost: 1.5,
      maxSpeedLoad: 1.2,
      maxSpeedFree: 2.5,
      maxAccelerationLoad: 0.6,
      maxAccelerationFree: null,
      maxDecelerationFree: 1.1,
    })
    // 方向二：n2→n1 倒车，cost / 限速与方向一不同
    expect(details!.directions[1]).toMatchObject({
      edgeId: 'e21',
      edgeName: '边乙甲',
      fromName: '站点乙',
      toName: '站点甲',
      isBack: true,
      cost: 2.5,
      maxSpeedLoad: null,
      maxSpeedFree: 1.8,
    })
    expect(details!.directions[1].eFacing).toBeCloseTo(Math.PI, 6)
  })

  it('单向走廊：仅一组有向属性', () => {
    const details = buildCorridorDetails(map, 'c:n1|n3')
    expect(details!.bidirectional).toBe(false)
    expect(details!.directions).toHaveLength(1)
    expect(details!.directions[0]).toMatchObject({
      edgeId: 'e13',
      fromName: '站点甲',
      toName: '孤立点',
      isBack: false,
    })
  })

  it('走廊不存在或其方向边缺失返回 null', () => {
    expect(buildCorridorDetails(map, 'c:missing')).toBeNull()
    const broken = syntheticMap()
    broken.edges = broken.edges.filter((edge) => edge.id !== 'e21')
    expect(buildCorridorDetails(broken, 'c:n1|n2')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// AGV 详情
// ---------------------------------------------------------------------------

describe('buildAgvDetails（SPEC §8.2 AGV 面板字段）', () => {
  const map = syntheticMap()

  it('行驶中：编号 / 状态 / 当前任务 / 所在边（名称解析）/ 电量', () => {
    const details = buildAgvDetails(
      [fakeSnapshot({ id: 3, status: 'toPick', task: '取货 站点甲', edgeId: 'e12', battery: 45 })],
      map,
      3,
    )
    expect(details).toMatchObject({
      kind: 'agv',
      id: 3,
      status: 'toPick',
      task: '取货 站点甲',
      edgeId: 'e12',
      edgeName: '边甲乙',
      nodeId: null,
      nodeName: null,
      battery: 45,
    })
  })

  it('停靠中：所在边为 null，停靠节点名称解析', () => {
    const details = buildAgvDetails(
      [fakeSnapshot({ id: 1, status: 'charging', nodeId: 'n2', battery: 88 })],
      map,
      1,
    )
    expect(details).toMatchObject({
      edgeId: null,
      edgeName: null,
      nodeId: 'n2',
      nodeName: '站点乙',
      status: 'charging',
      battery: 88,
    })
  })

  it('快照不存在返回 null；mapData 为 null 时名称回退 id', () => {
    expect(buildAgvDetails([fakeSnapshot({ id: 0 })], map, 9)).toBeNull()
    const details = buildAgvDetails([fakeSnapshot({ id: 0, edgeId: 'e12' })], null, 0)
    expect(details!.edgeName).toBe('e12')
  })
})

// ---------------------------------------------------------------------------
// 展示标签与真实数据集成
// ---------------------------------------------------------------------------

describe('展示标签', () => {
  it('节点类型与 AGV 状态标签全覆盖（类型键封闭）', () => {
    expect(Object.keys(NODE_KIND_LABELS).sort()).toEqual(
      ['charge', 'elevator', 'node', 'park', 'work'].sort(),
    )
    expect(Object.keys(AGV_STATUS_LABELS).sort()).toEqual(
      ['charging', 'hauling', 'idle', 'loading', 'toCharge', 'toPick'].sort(),
    )
  })
})

describe('detailModel：真实 map.json 集成', () => {
  const mapJsonPath = fileURLToPath(new URL('../../public/map.json', import.meta.url))
  const { map } = normalizeMapFromJson(readFileSync(mapJsonPath, 'utf-8'))

  it('双向走廊两组方向属性与有向边原始字段一致（抽样核对）', () => {
    const corridor = map.corridors.find((item) => item.bidirectional)
    expect(corridor).toBeDefined()
    const details = buildCorridorDetails(map, corridor!.id)
    expect(details).not.toBeNull()
    expect(details!.directions).toHaveLength(2)
    for (let i = 0; i < 2; i++) {
      const edge = map.edges.find((item) => item.id === corridor!.directions[i].edgeId)!
      const direction = details!.directions[i]
      expect(direction.edgeId).toBe(edge.id)
      expect(direction.isBack).toBe(edge.isBackEdge)
      expect(direction.cost).toBe(edge.cost)
      expect(direction.maxSpeedFree).toBe(edge.maxSpeedFree)
      expect(direction.length).toBeCloseTo(edge.geometry.length, 6)
      expect(direction.fromId).toBe(edge.from)
      expect(direction.toId).toBe(edge.to)
    }
    // 全部单向走廊仅一组方向
    for (const oneWay of map.corridors.filter((item) => !item.bidirectional)) {
      expect(buildCorridorDetails(map, oneWay.id)!.directions).toHaveLength(1)
    }
  })

  it('节点关联边列表与 edges 全量扫描一致（抽样 work 节点）', () => {
    const node = map.nodes.find((item) => item.kind === 'work')!
    const details = buildNodeDetails(map, node.id)!
    const expected = map.edges.filter((edge) => edge.from === node.id || edge.to === node.id)
    expect(details.edges.map((edge) => edge.id).sort()).toEqual(
      expected.map((edge) => edge.id).sort(),
    )
  })
})
