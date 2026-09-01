/*
 * 地图字段与引用校验测试（与实现共置）。
 *
 * 职责：覆盖 TASK-003 验证要求的「方向、非有限值、未知类型、缺失数组和
 *       悬空引用」等全部校验规则：致命根结构错误抛 MAP_ROOT_INVALID；其余
 *       问题逐项隔离，不级联污染其余元素。
 * 关键不变量（SPEC §2.1～§2.2、§11.12）：
 * 1. ID 为不透明字符串；重复 ID 首个生效；
 * 2. LINE 只允许起止坐标 + null 控制点；BEZIER 要求全部 12 坐标有限；
 * 3. 悬空引用逐项剔除；未知节点类型保留并告警；缺失数组按空跳过；
 * 4. mapId 一致性：顶层缺省由首元素派生，冲突元素剔除；
 * 5. 输出深度冻结。
 */
import { describe, expect, it } from 'vitest'
import { StructuredError } from '@/shared/diagnostics'
import { validateMap } from '@/features/map-visualization/model/validateMap'
import { makeBezierEdge, makeGroup, makeLineEdge, makeNode } from './fixtures'

/** 组装一张原始地图（字段原样透传，不做合法性预处理） */
function rawMap(parts: {
  mapId?: unknown
  nodes?: unknown
  edges?: unknown
  zones?: unknown
  nodeEdgeGroups?: unknown
} = {}): Record<string, unknown> {
  return {
    mapId: parts.mapId ?? null,
    nodes: parts.nodes ?? [],
    edges: parts.edges ?? [],
    zones: parts.zones ?? [],
    nodeEdgeGroups: parts.nodeEdgeGroups ?? [],
  }
}

/** 双节点一 LINE 边的最小合法地图（a(0,0) → b(3,4)） */
function minimalMap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return rawMap({
    nodes: [
      makeNode({ id: 'a', name: 'A', x: 0, y: 0 }),
      makeNode({ id: 'b', name: 'B', x: 3, y: 4 }),
    ],
    edges: [makeLineEdge()],
    ...overrides,
  })
}

describe('validateMap：致命根结构', () => {
  it('根不是对象、nodes 缺失或非数组时抛出 MAP_ROOT_INVALID', () => {
    for (const bad of [null, 42, 'map', [1, 2], {}, { nodes: 'nope' }, { nodes: null }]) {
      try {
        validateMap(bad)
        expect.unreachable('应当抛出 MAP_ROOT_INVALID')
      } catch (error) {
        expect(error).toBeInstanceOf(StructuredError)
        expect((error as StructuredError).code).toBe('MAP_ROOT_INVALID')
      }
    }
  })

  it('edges / nodeEdgeGroups / zones 缺失时按空跳过，不阻断建模', () => {
    const data = validateMap({ nodes: [makeNode({ id: 'a' })] })
    expect(data.nodes).toHaveLength(1)
    expect(data.edges).toHaveLength(0)
    expect(data.groups).toHaveLength(0)
    expect(data.anomalies).toHaveLength(0)
  })
})

describe('validateMap：节点字段', () => {
  it('坐标缺失或非有限（NaN/Infinity/字符串）的节点被逐项剔除，其余保留', () => {
    const data = validateMap(
      rawMap({
        nodes: [
          makeNode({ id: 'good', x: 1, y: 2 }),
          makeNode({ id: 'nan', x: Number.NaN, y: 0 }),
          makeNode({ id: 'inf', x: 0, y: Number.POSITIVE_INFINITY }),
          makeNode({ id: 'str', x: '1', y: 2 }),
          makeNode({ id: 'missing-y', x: 1, y: undefined }),
          makeNode({ id: 'good2', x: 5, y: 6 }),
        ],
      }),
    )
    expect(data.nodes.map((node) => node.id)).toEqual(['good', 'good2'])
    const codes = data.anomalies.map((anomaly) => anomaly.code)
    expect(codes.filter((code) => code === 'MAP_NODE_INVALID')).toHaveLength(4)
  })

  it('重复节点 ID 首个生效并记录 MAP_NODE_DUPLICATE_ID', () => {
    const data = validateMap(
      rawMap({
        nodes: [
          makeNode({ id: 'dup', x: 0, y: 0 }),
          makeNode({ id: 'dup', x: 9, y: 9 }),
        ],
      }),
    )
    expect(data.nodes).toHaveLength(1)
    expect(data.nodes[0].x).toBe(0)
    expect(data.anomalies.map((anomaly) => anomaly.code)).toEqual(['MAP_NODE_DUPLICATE_ID'])
  })

  it('未知节点类型保留为 category=unknown 并产生 warn 级告警；type 非字符串同样兜底', () => {
    const data = validateMap(
      rawMap({
        nodes: [makeNode({ id: 'u1', type: 'mystery' }), makeNode({ id: 'u2', type: 7 })],
      }),
    )
    expect(data.nodes).toHaveLength(2)
    expect(data.nodes[0]).toMatchObject({ id: 'u1', type: 'mystery', category: 'unknown' })
    expect(data.nodes[1]).toMatchObject({ id: 'u2', type: '', category: 'unknown' })
    expect(data.anomalies.map((anomaly) => anomaly.code)).toEqual([
      'MAP_NODE_UNKNOWN_TYPE',
      'MAP_NODE_UNKNOWN_TYPE',
    ])
    expect(data.anomalies.every((anomaly) => anomaly.level === 'warn')).toBe(true)
  })

  it('已知类型映射到对应 category；name 缺失回退 id；非法 angle 收敛为 null', () => {
    const data = validateMap(
      rawMap({
        nodes: [
          makeNode({ id: 'w', type: 'work' }),
          makeNode({ id: 'h', type: 'warehouse' }),
          makeNode({ id: 'c', type: 'charge' }),
          makeNode({ id: 'p', type: 'park' }),
          makeNode({ id: 'noName', name: '', angle: 'oops' }),
        ],
      }),
    )
    expect(data.nodes.map((node) => node.category)).toEqual(['work', 'warehouse', 'charge', 'park', 'work'])
    expect(data.nodes[4]).toMatchObject({ name: 'noName', angle: null })
    expect(data.anomalies).toHaveLength(0)
  })
})

describe('validateMap：mapId 一致性', () => {
  it('顶层 mapId 缺省时由第一个有效节点派生', () => {
    const data = validateMap(minimalMap())
    expect(data.mapId).toBe('m1')
    expect(data.anomalies).toHaveLength(0)
  })

  it('顶层 mapId 生效；mapId 缺失或冲突的元素被逐项剔除', () => {
    const data = validateMap(
      rawMap({
        mapId: 'top',
        nodes: [
          makeNode({ id: 'a', mapId: 'top' }),
          makeNode({ id: 'b', mapId: 'top' }),
          makeNode({ id: 'other', mapId: 'other-map' }),
          makeNode({ id: 'noMapId', mapId: null }),
        ],
        edges: [
          makeLineEdge({ snodeId: 'a', enodeId: 'b', mapId: 'top' }),
          makeLineEdge({ id: 'e-rogue', snodeId: 'a', enodeId: 'b', mapId: 'rogue' }),
        ],
      }),
    )
    expect(data.mapId).toBe('top')
    expect(data.nodes.map((node) => node.id)).toEqual(['a', 'b'])
    expect(data.edges.map((edge) => edge.id)).toEqual(['e-default'])
    expect(data.anomalies.map((anomaly) => anomaly.code)).toEqual([
      'MAP_MAPID_CONFLICT',
      'MAP_MAPID_CONFLICT',
      'MAP_MAPID_CONFLICT',
    ])
  })
})

describe('validateMap：逻辑边几何', () => {
  it('LINE 允许 null 控制点；携带非空控制点即剔除', () => {
    const ok = validateMap(rawMap({ nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b' })], edges: [makeLineEdge()] }))
    expect(ok.anomalies).toHaveLength(0)
    expect(ok.edges[0]).toMatchObject({ edgeType: 'LINE', cx: null, cy: null, dx: null, dy: null })

    const bad = validateMap(
      rawMap({ nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b' })], edges: [makeLineEdge({ cx: 1 })] }),
    )
    expect(bad.edges).toHaveLength(0)
    expect(bad.anomalies[0]).toMatchObject({ code: 'MAP_EDGE_INVALID', level: 'error' })
  })

  it('BEZIER 要求全部控制点为有限数值；缺失或 null 均剔除', () => {
    const ok = validateMap(rawMap({ nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b' })], edges: [makeBezierEdge()] }))
    expect(ok.anomalies).toHaveLength(0)
    expect(ok.edges[0].edgeType).toBe('BEZIER')

    for (const override of [{ cx: null }, { cy: 'x' }, { dx: Number.NaN }]) {
      const bad = validateMap(
        rawMap({ nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b' })], edges: [makeBezierEdge(override)] }),
      )
      expect(bad.edges).toHaveLength(0)
      expect(bad.anomalies[0].code).toBe('MAP_EDGE_INVALID')
    }
  })

  it('起止坐标非有限或 edgeType 非法的边被剔除', () => {
    const bad = validateMap(
      rawMap({
        nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b' })],
        edges: [
          makeLineEdge({ id: 'e-inf', ey: Number.NaN }),
          makeLineEdge({ id: 'e-type', edgeType: 'line' }),
        ],
      }),
    )
    expect(bad.edges).toHaveLength(0)
    expect(bad.anomalies.map((anomaly) => anomaly.code)).toEqual(['MAP_EDGE_INVALID', 'MAP_EDGE_INVALID'])
  })

  it('代价与限速：合法数值保留；缺失/非法收敛为 null（调用方回退物理长度）', () => {
    const data = validateMap(
      rawMap({
        nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b' })],
        edges: [makeLineEdge({ cost: 1.5, maxLoadSpeed: 'fast', maxFreeSpeed: undefined })],
      }),
    )
    expect(data.edges[0]).toMatchObject({ cost: 1.5, maxLoadSpeed: null, maxFreeSpeed: null })
    expect(data.anomalies).toHaveLength(0)
  })

  it('isBackEdge 仅接受布尔 true；自环边（snodeId===enodeId）允许保留', () => {
    const data = validateMap(
      rawMap({
        nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b' })],
        edges: [
          makeLineEdge({ id: 'e-back', isBackEdge: 1 }),
          makeLineEdge({ id: 'e-loop', snodeId: 'a', enodeId: 'a' }),
        ],
      }),
    )
    expect(data.edges[0].isBackEdge).toBe(false)
    expect(data.edges[1]).toMatchObject({ id: 'e-loop', snodeId: 'a', enodeId: 'a' })
    expect(data.anomalies).toHaveLength(0)
  })
})

describe('validateMap：引用隔离', () => {
  it('悬空引用的边被逐项剔除；坏节点级联导致的引用同样按悬空处理', () => {
    const data = validateMap(
      rawMap({
        nodes: [
          makeNode({ id: 'a', x: 0, y: 0 }),
          makeNode({ id: 'bad', x: Number.NaN, y: 0 }),
          makeNode({ id: 'c', x: 9, y: 9 }),
        ],
        edges: [
          makeLineEdge({ id: 'e-ab', snodeId: 'a', enodeId: 'bad' }),
          makeLineEdge({ id: 'e-ghost', snodeId: 'a', enodeId: 'ghost' }),
          makeLineEdge({ id: 'e-ac', snodeId: 'a', enodeId: 'c' }),
        ],
      }),
    )
    expect(data.nodes.map((node) => node.id)).toEqual(['a', 'c'])
    expect(data.edges.map((edge) => edge.id)).toEqual(['e-ac'])
    const codes = data.anomalies.map((anomaly) => anomaly.code).sort()
    expect(codes).toEqual(['MAP_EDGE_DANGLING_REF', 'MAP_EDGE_DANGLING_REF', 'MAP_NODE_INVALID'])
  })

  it('分组缺失成员数组按空处理；非数组记录 MAP_GROUP_INVALID；无效成员逐项跳过', () => {
    const data = validateMap(
      rawMap({
        nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b' })],
        edges: [makeLineEdge()],
        nodeEdgeGroups: [
          makeGroup({ id: 'g-ok', nodeIds: ['a', 'ghost'], edgeIds: ['e-default', 'e-ghost'] }),
          makeGroup({ id: 'g-noArrays', nodeIds: undefined, edgeIds: undefined }),
          makeGroup({ id: 'g-badArrays', nodeIds: 'all', edgeIds: 3 }),
          makeGroup({ id: 'g-ok', nodeIds: ['a'] }),
        ],
      }),
    )
    expect(data.groups).toHaveLength(3)
    expect(data.groups[0]).toMatchObject({
      id: 'g-ok',
      memberNodeIds: ['a'],
      memberEdgeIds: ['e-default'],
    })
    expect(data.groups[1]).toMatchObject({ id: 'g-noArrays', memberNodeIds: [], memberEdgeIds: [] })
    expect(data.groups[2].id).toBe('g-badArrays')
    const codes = data.anomalies.map((anomaly) => anomaly.code)
    expect(codes.filter((code) => code === 'MAP_GROUP_MEMBER_INVALID')).toHaveLength(2)
    expect(codes.filter((code) => code === 'MAP_GROUP_INVALID')).toHaveLength(3)
  })
})

describe('validateMap：不可变输出', () => {
  it('返回的数据与全部条目深度冻结', () => {
    const data = validateMap(minimalMap())
    expect(Object.isFrozen(data)).toBe(true)
    expect(Object.isFrozen(data.nodes)).toBe(true)
    expect(Object.isFrozen(data.edges)).toBe(true)
    expect(Object.isFrozen(data.groups)).toBe(true)
    expect(Object.isFrozen(data.anomalies)).toBe(true)
    expect(Object.isFrozen(data.nodes[0])).toBe(true)
    expect(Object.isFrozen(data.edges[0])).toBe(true)
  })
})
