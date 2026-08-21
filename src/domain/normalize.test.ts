import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { MapDataError, normalizeMap, normalizeMapFromJson } from './normalize'
import type { RawMapEdge, RawMapNode } from './types'

// ---------------------------------------------------------------------------
// 测试夹具：构造最小合法的 map.json 顶层结构（SPEC §4.1）
// ---------------------------------------------------------------------------

function makeNode(id: string, overrides?: Partial<RawMapNode>): RawMapNode {
  return { id, name: `节点${id}`, type: 'node', x: 0, y: 0, angle: null, ...overrides }
}

function makeEdge(id: string, from: string, to: string, overrides?: Partial<RawMapEdge>): RawMapEdge {
  return {
    id,
    name: `边${id}`,
    edgeType: 'LINE',
    sx: 0,
    sy: 0,
    ex: 1,
    ey: 0,
    cx: null,
    cy: null,
    dx: null,
    dy: null,
    snodeId: from,
    enodeId: to,
    sfacing: 0,
    efacing: 0,
    isBackEdge: false,
    cost: 1,
    maxLoadSpeed: null,
    maxFreeSpeed: null,
    maxLoadRotationSpeed: null,
    maxFreeRotationSpeed: null,
    maxLoadAcceleration: null,
    maxFreeAcceleration: null,
    maxLoadDeceleration: null,
    maxFreeDeceleration: null,
    ...overrides,
  }
}

function makeExport(nodes: RawMapNode[], edges: RawMapEdge[], floor = 1): unknown {
  return {
    code: 0,
    message: 'ok',
    timestamp: 0,
    data: {
      mapName: '测试地图',
      floor,
      currentMapInfoVersion: { mapJson: { nodes, edges, zones: [], nodeEdgeGroups: [] } },
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('normalize：类型映射与降级（SPEC §4.2）', () => {
  it('type → kind 映射 node / work / charge / park，elevator 预留透传', () => {
    const { map, stats } = normalizeMap(
      makeExport(
        ['node', 'work', 'charge', 'park', 'elevator'].map((type, i) =>
          makeNode(`n${i}`, { type, x: i, y: 0 }),
        ),
        [],
      ),
    )
    expect(map.nodes.map((node) => node.kind)).toEqual([
      'node',
      'work',
      'charge',
      'park',
      'elevator',
    ])
    expect(stats.unknownNodeKinds).toBe(0)
  })

  it('未知类型降级为 node，console 警告并计数', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { map, stats } = normalizeMap(
      makeExport([makeNode('a', { type: 'mystery' }), makeNode('b', { x: 1 })], []),
    )
    expect(map.nodes[0].kind).toBe('node')
    expect(stats.unknownNodeKinds).toBe(1)
    expect(warn).toHaveBeenCalled()
  })
})

describe('normalize：坏数据跳过与计数（SPEC §10）', () => {
  it('缺坐标节点跳过，其关联边一并跳过', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { map, stats } = normalizeMap(
      makeExport(
        [makeNode('a'), makeNode('b', { x: 2 }), makeNode('bad', { x: null })],
        [
          makeEdge('e1', 'a', 'b', { ex: 2 }),
          makeEdge('e2', 'a', 'bad'),
          makeEdge('e3', 'bad', 'b'),
        ],
      ),
    )
    expect(map.nodes.map((node) => node.id)).toEqual(['a', 'b'])
    expect(map.edges.map((edge) => edge.id)).toEqual(['e1'])
    expect(stats.skippedNodes).toBe(1)
    expect(stats.skippedEdges).toBe(2)
    expect(warn).toHaveBeenCalled()
  })

  it('引用不存在节点的边跳过', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { map, stats } = normalizeMap(
      makeExport([makeNode('a'), makeNode('b', { x: 1 })], [makeEdge('e1', 'a', 'ghost')]),
    )
    expect(map.edges).toHaveLength(0)
    expect(stats.skippedEdges).toBe(1)
  })

  it('s=e 自环与零长度退化边跳过', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { map, stats } = normalizeMap(
      makeExport(
        [makeNode('a'), makeNode('b', { x: 1 })],
        [
          makeEdge('loop', 'a', 'a'),
          makeEdge('zero', 'a', 'b', { sx: 1, sy: 1, ex: 1, ey: 1 }),
          makeEdge('ok', 'a', 'b'),
        ],
      ),
    )
    expect(map.edges.map((edge) => edge.id)).toEqual(['ok'])
    expect(stats.skippedEdges).toBe(2)
  })

  it('未知 edgeType 降级为 LINE 并计数', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { map, stats } = normalizeMap(
      makeExport([makeNode('a'), makeNode('b', { x: 3 })], [
        makeEdge('e1', 'a', 'b', { edgeType: 'ARC', ex: 3 }),
      ]),
    )
    expect(map.edges).toHaveLength(1)
    expect(map.edges[0].geometry.points).toHaveLength(2)
    expect(stats.degradedEdges).toBe(1)
  })
})

describe('normalize：边几何统一为折线（SPEC §4.2）', () => {
  it('LINE 边规范化为两点折线，携带累积弧长表', () => {
    const { map } = normalizeMap(
      makeExport([makeNode('a'), makeNode('b', { x: 3, y: 4 })], [
        makeEdge('e1', 'a', 'b', { ex: 3, ey: 4 }),
      ]),
    )
    const geometry = map.edges[0].geometry
    expect(geometry.points).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 4 },
    ])
    expect(geometry.cumulativeLengths).toEqual([0, 5])
    expect(geometry.length).toBe(5)
  })

  it('BEZIER 边自适应细分为多点折线，弧长表单调且保留方向性字段', () => {
    const { map, stats } = normalizeMap(
      makeExport([makeNode('a'), makeNode('b', { x: 10, y: 10 })], [
        makeEdge('e1', 'a', 'b', {
          edgeType: 'BEZIER',
          ex: 10,
          ey: 10,
          cx: 0,
          cy: 5.5,
          dx: 4.5,
          dy: 10,
          sfacing: -1.5707963267948966,
          efacing: 0,
          isBackEdge: true,
          cost: 2.5,
          maxLoadSpeed: 0.8,
          maxFreeSpeed: 1.5,
        }),
      ]),
    )
    expect(stats.skippedEdges).toBe(0)
    const edge = map.edges[0]
    expect(edge.geometry.points.length).toBeGreaterThan(2)
    expect(edge.geometry.points[0]).toEqual({ x: 0, y: 0 })
    expect(edge.geometry.points[edge.geometry.points.length - 1]).toEqual({ x: 10, y: 10 })
    for (let i = 1; i < edge.geometry.cumulativeLengths.length; i++) {
      expect(edge.geometry.cumulativeLengths[i]).toBeGreaterThanOrEqual(
        edge.geometry.cumulativeLengths[i - 1],
      )
    }
    expect(edge.sFacing).toBeCloseTo(-Math.PI / 2, 12)
    expect(edge.eFacing).toBe(0)
    expect(edge.isBackEdge).toBe(true)
    expect(edge.cost).toBe(2.5)
    expect(edge.maxSpeedLoad).toBe(0.8)
    expect(edge.maxSpeedFree).toBe(1.5)
    expect(edge.maxAccelerationLoad).toBeNull()
  })
})

describe('normalize：calibration 与 floor（SPEC §4.3）', () => {
  it('scale=1 / rotationRad=0，offset 取涵盖节点 + 边折线 + 贝塞尔控制点的包围盒中心', () => {
    // 节点 x∈[0,10]、y∈[0,0]；BEZIER 控制点 (5,20) 把包围盒 y 撑到 [0,20]
    const { map } = normalizeMap(
      makeExport([makeNode('a'), makeNode('b', { x: 10 })], [
        makeEdge('e1', 'a', 'b', { edgeType: 'BEZIER', ex: 10, cx: 5, cy: 20, dx: 5, dy: 20 }),
      ]),
    )
    expect(map.calibration.scale).toBe(1)
    expect(map.calibration.rotationRad).toBe(0)
    expect(map.calibration.offsetX).toBeCloseTo(5, 12)
    expect(map.calibration.offsetY).toBeCloseTo(10, 12)
    // bounds 与 offset 同一口径（含边折线与贝塞尔控制点，SPEC §4.3 / §5.2）
    expect(map.bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 20 })
    expect(map.calibration.offsetX).toBeCloseTo((map.bounds.minX + map.bounds.maxX) / 2, 12)
    expect(map.calibration.offsetY).toBeCloseTo((map.bounds.minY + map.bounds.maxY) / 2, 12)
  })

  it('floor 取自 data.floor', () => {
    const { map } = normalizeMap(makeExport([makeNode('a')], [], 7))
    expect(map.floor).toBe(7)
  })
})

describe('normalize：顶层结构缺失（SPEC §10）', () => {
  it('缺 data / mapJson / nodes 数组 / floor 时抛 MapDataError（带原因）', () => {
    const invalid: unknown[] = [
      null,
      {},
      { data: {} },
      { data: { currentMapInfoVersion: { mapJson: { edges: [] } }, floor: 1 } },
      { data: { currentMapInfoVersion: { mapJson: { nodes: [], edges: [] } } } },
    ]
    for (const raw of invalid) {
      expect(() => normalizeMap(raw)).toThrowError(MapDataError)
      expect(() => normalizeMap(raw)).toThrowError(/map\.json 顶层结构缺失/)
    }
  })

  it('normalizeMapFromJson：JSON 损坏抛 MapDataError，合法 JSON 正常解析', () => {
    expect(() => normalizeMapFromJson('{ 损坏')).toThrowError(/JSON 解析失败/)
    const { map } = normalizeMapFromJson(JSON.stringify(makeExport([makeNode('a')], [], 2)))
    expect(map.floor).toBe(2)
    expect(map.nodes).toHaveLength(1)
  })
})

describe('normalize：真实 map.json 集成（SPEC §4.1 实测分布）', () => {
  it('1767 节点 / 3043 边全部规范化、零跳过、BEZIER 细分生效', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mapJsonPath = fileURLToPath(new URL('../../public/map.json', import.meta.url))
    const { map, stats } = normalizeMapFromJson(readFileSync(mapJsonPath, 'utf8'))

    expect(map.floor).toBe(1)
    expect(map.nodes).toHaveLength(1767)
    expect(map.edges).toHaveLength(3043)
    expect(stats.skippedNodes).toBe(0)
    expect(stats.skippedEdges).toBe(0)
    expect(stats.unknownNodeKinds).toBe(0)
    expect(stats.degradedEdges).toBe(0)
    // 干净数据不产生任何警告
    expect(warn).not.toHaveBeenCalled()

    // BEZIER 自适应细分生效：细分出多点的边 ≤ 109 条 BEZIER 上限
    //（近似直线的 BEZIER 按容差保持两点，属自适应细分的预期行为）；
    // 两点折线不少于 2934 条 LINE 下限
    const subdivided = map.edges.filter((edge) => edge.geometry.points.length > 2)
    expect(subdivided.length).toBeGreaterThan(0)
    expect(subdivided.length).toBeLessThanOrEqual(109)
    expect(map.edges.length - subdivided.length).toBeGreaterThanOrEqual(2934)
    for (const edge of map.edges) {
      expect(edge.geometry.cumulativeLengths[0]).toBe(0)
      expect(edge.geometry.length).toBeGreaterThan(0)
    }

    // 校准：恒等变换 + 包围盒中心（范围涵盖控制点，不窄于节点范围 §4.1）
    expect(map.calibration.scale).toBe(1)
    expect(map.calibration.rotationRad).toBe(0)
    const xs = map.nodes.map((node) => node.x)
    const ys = map.nodes.map((node) => node.y)
    const nodeCenterX = (Math.min(...xs) + Math.max(...xs)) / 2
    const nodeCenterY = (Math.min(...ys) + Math.max(...ys)) / 2
    expect(Math.abs(map.calibration.offsetX - nodeCenterX)).toBeLessThan(1)
    expect(Math.abs(map.calibration.offsetY - nodeCenterY)).toBeLessThan(1)

    // bounds：不窄于节点范围，offset 恰为 bounds 中心（§4.3 / §5.2 同源口径）
    expect(map.bounds.minX).toBeLessThanOrEqual(Math.min(...xs))
    expect(map.bounds.maxX).toBeGreaterThanOrEqual(Math.max(...xs))
    expect(map.bounds.minY).toBeLessThanOrEqual(Math.min(...ys))
    expect(map.bounds.maxY).toBeGreaterThanOrEqual(Math.max(...ys))
    expect(map.calibration.offsetX).toBe((map.bounds.minX + map.bounds.maxX) / 2)
    expect(map.calibration.offsetY).toBe((map.bounds.minY + map.bounds.maxY) / 2)
  })
})
