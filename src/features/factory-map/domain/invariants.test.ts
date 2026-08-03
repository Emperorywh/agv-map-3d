import { describe, expect, it } from 'vitest'

import { MapCapacityError, MapValidationError } from './errors'
import type { FactoryMapEdge } from './factoryMap'
import {
  assertEdgeArcLengths,
  assertMapElementCapacity,
  assertMapExtentWithinLimits,
  assertNodeReferencesExist,
  computeEdgeArcLength,
  describeValue,
  isPlainObject,
  parseMapEdge,
  parseMapEdges,
  parseMapNode,
  parseMapNodes,
} from './invariants'

function validRawNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'n1', name: 'N1', type: 'node', x: 1, y: 2, angle: null, ...overrides }
}

function validRawEdge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'e1', name: 'E1', edgeType: 'LINE',
    sx: 0, sy: 0, ex: 3, ey: 4,
    cx: null, cy: null, dx: null, dy: null,
    isBackEdge: false, snodeId: 'n1', enodeId: 'n2',
    ...overrides,
  }
}

function makeEdge(overrides: Partial<FactoryMapEdge> & Pick<FactoryMapEdge, 'edgeType'>): FactoryMapEdge {
  return {
    id: 'e1', name: 'E1',
    sx: 0, sy: 0, ex: 3, ey: 4,
    isBackEdge: false, snodeId: 'n1', enodeId: 'n2',
    ...(overrides.edgeType === 'LINE'
      ? { cx: null, cy: null, dx: null, dy: null }
      : { cx: 1, cy: 5, dx: 2, dy: 5 }),
    ...overrides,
  } as FactoryMapEdge
}

function expectValidationError(fn: () => unknown, code: string, fieldPath: string): MapValidationError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(MapValidationError)
    const validationError = error as MapValidationError
    expect(validationError.code).toBe(code)
    expect(validationError.fieldPath).toBe(fieldPath)
    expect(validationError.message.length).toBeGreaterThan(0)
    return validationError
  }
  throw new Error(`应抛出 ${code}（${fieldPath}），实际未抛出`)
}

describe('原始值形状判断', () => {
  it('isPlainObject 只接受非 null、非数组对象', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject('x')).toBe(false)
    expect(isPlainObject(1)).toBe(false)
  })

  it('describeValue 覆盖全部输入形态', () => {
    expect(describeValue(null)).toBe('null')
    expect(describeValue([])).toBe('数组')
    expect(describeValue('abc')).toBe('字符串 "abc"')
    expect(describeValue({})).toBe('对象')
    expect(describeValue(undefined)).toBe('undefined（字段缺失）')
    expect(describeValue(5)).toBe('number 5')
    expect(describeValue(true)).toBe('boolean true')
  })
})

describe('§3.3 集合字段行：数组项必须是非 null object', () => {
  it.each([null, 42, 'node', []])('节点数组项 %j 被拒绝', (item) => {
    expectValidationError(() => parseMapNode(item, 'nodes[0]'), 'MAP_ITEM_NOT_OBJECT', 'nodes[0]')
  })

  it('路径数组项非对象被拒绝', () => {
    expectValidationError(() => parseMapEdge(null, 'edges[2]'), 'MAP_ITEM_NOT_OBJECT', 'edges[2]')
  })
})

describe('§3.3 id/name 行：非空字符串', () => {
  it.each([{ id: '' }, { id: 123 }])('节点 id 非法：%j', (patch) => {
    expectValidationError(() => parseMapNode(validRawNode(patch), 'nodes[0]'), 'MAP_ID_INVALID', 'nodes[0].id')
  })

  it('节点 id 缺失被拒绝', () => {
    const raw = validRawNode()
    delete raw.id
    expectValidationError(() => parseMapNode(raw, 'nodes[0]'), 'MAP_ID_INVALID', 'nodes[0].id')
  })

  it.each([{ name: '' }, { name: 7 }])('节点 name 非法：%j', (patch) => {
    expectValidationError(() => parseMapNode(validRawNode(patch), 'nodes[0]'), 'MAP_NAME_INVALID', 'nodes[0].name')
  })

  it('节点 name 缺失被拒绝', () => {
    const raw = validRawNode()
    delete raw.name
    expectValidationError(() => parseMapNode(raw, 'nodes[0]'), 'MAP_NAME_INVALID', 'nodes[0].name')
  })

  it('路径 id/name 同样校验', () => {
    expectValidationError(() => parseMapEdge(validRawEdge({ id: '' }), 'edges[0]'), 'MAP_ID_INVALID', 'edges[0].id')
    expectValidationError(() => parseMapEdge(validRawEdge({ name: '' }), 'edges[0]'), 'MAP_NAME_INVALID', 'edges[0].name')
  })

  it('snodeId/enodeId 必须是非空字符串', () => {
    expectValidationError(
      () => parseMapEdge(validRawEdge({ snodeId: '' }), 'edges[0]'),
      'MAP_ID_INVALID',
      'edges[0].snodeId',
    )
    expectValidationError(
      () => parseMapEdge(validRawEdge({ enodeId: 9 }), 'edges[0]'),
      'MAP_ID_INVALID',
      'edges[0].enodeId',
    )
  })
})

describe('§3.3 id/name 行：节点 id、边 id 各自唯一', () => {
  it('重复节点 id 被拒绝并保留首次出现位置', () => {
    const { nodes, errors } = parseMapNodes([
      validRawNode({ id: 'a' }),
      validRawNode({ id: 'b' }),
      validRawNode({ id: 'a' }),
    ])
    expect(nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(errors).toHaveLength(1)
    expect(errors[0].code).toBe('MAP_ID_DUPLICATED')
    expect(errors[0].fieldPath).toBe('nodes[2].id')
    expect(errors[0].message).toContain('nodes[0]')
  })

  it('重复路径 id 被拒绝', () => {
    const { edges, errors } = parseMapEdges([validRawEdge({ id: 'e' }), validRawEdge({ id: 'e' })])
    expect(edges).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(errors[0].code).toBe('MAP_ID_DUPLICATED')
    expect(errors[0].fieldPath).toBe('edges[1].id')
  })

  it('节点 id 与路径 id 分属不同命名空间，允许同值', () => {
    const { nodes, errors: nodeErrors } = parseMapNodes([validRawNode({ id: 'same' })])
    const { edges, errors: edgeErrors } = parseMapEdges([validRawEdge({ id: 'same' })])
    expect(nodes).toHaveLength(1)
    expect(edges).toHaveLength(1)
    expect(nodeErrors).toHaveLength(0)
    expect(edgeErrors).toHaveLength(0)
  })
})

describe('§3.3 数值字段行：有限数值与坐标绝对值上限', () => {
  it.each([{ x: '1' }, { x: Number.NaN }, { x: Number.POSITIVE_INFINITY }])(
    '节点坐标 x 非法：%j',
    (patch) => {
      expectValidationError(() => parseMapNode(validRawNode(patch), 'nodes[0]'), 'MAP_NUMBER_INVALID', 'nodes[0].x')
    },
  )

  it('节点坐标 x 缺失被拒绝', () => {
    const raw = validRawNode()
    delete raw.x
    expectValidationError(() => parseMapNode(raw, 'nodes[0]'), 'MAP_NUMBER_INVALID', 'nodes[0].x')
  })

  it('节点坐标 y 非法数值被拒绝', () => {
    expectValidationError(() => parseMapNode(validRawNode({ y: null }), 'nodes[0]'), 'MAP_NUMBER_INVALID', 'nodes[0].y')
  })

  it.each([1000.1, -1000.1, 5000])('坐标绝对值 %s 超过 1000m 被拒绝', (x) => {
    const error = expectValidationError(
      () => parseMapNode(validRawNode({ x }), 'nodes[1]'),
      'MAP_COORDINATE_OUT_OF_RANGE',
      'nodes[1].x',
    )
    expect(error.message).toContain('1000')
  })

  it.each([1000, -1000])('坐标绝对值恰为 1000m 合法', (x) => {
    expect(parseMapNode(validRawNode({ x, y: x }), 'nodes[0]').x).toBe(x)
  })

  it('路径端点坐标同样校验有限性与上限', () => {
    expectValidationError(() => parseMapEdge(validRawEdge({ sx: 'a' }), 'edges[0]'), 'MAP_NUMBER_INVALID', 'edges[0].sx')
    expectValidationError(() => parseMapEdge(validRawEdge({ sy: Number.NaN }), 'edges[0]'), 'MAP_NUMBER_INVALID', 'edges[0].sy')
    expectValidationError(() => parseMapEdge(validRawEdge({ ex: 2000 }), 'edges[0]'), 'MAP_COORDINATE_OUT_OF_RANGE', 'edges[0].ex')
    expectValidationError(() => parseMapEdge(validRawEdge({ ey: -2000 }), 'edges[0]'), 'MAP_COORDINATE_OUT_OF_RANGE', 'edges[0].ey')
  })
})

describe('§3.3 node.type 行：只接受 node/work/park/charge', () => {
  it('未知类型被拒绝，错误码与字段路径稳定', () => {
    const error = expectValidationError(
      () => parseMapNode(validRawNode({ type: 'gate' }), 'nodes[17]'),
      'MAP_NODE_TYPE_INVALID',
      'nodes[17].type',
    )
    expect(error.message).toContain('gate')
  })

  it.each(['NODE', 'Node', 'station', 1, null])('类型 %j 被拒绝', (type) => {
    expectValidationError(() => parseMapNode(validRawNode({ type }), 'nodes[0]'), 'MAP_NODE_TYPE_INVALID', 'nodes[0].type')
  })

  it.each(['node', 'work', 'park', 'charge'] as const)('合法类型 %s 通过', (type) => {
    const angle = type === 'node' ? null : 0.5
    expect(parseMapNode(validRawNode({ type, angle }), 'nodes[0]').type).toBe(type)
  })
})

describe('§3.3 angle 行：node 必须 null，站点 null 或有限弧度并规范化', () => {
  it.each([[1.5], [0], ['0'], [{}]])('普通 node 携带 angle %j 被拒绝', (angle) => {
    expectValidationError(
      () => parseMapNode(validRawNode({ type: 'node', angle }), 'nodes[0]'),
      'MAP_NODE_ANGLE_INVALID',
      'nodes[0].angle',
    )
  })

  it('普通 node 缺失 angle（undefined）同样被拒绝', () => {
    const raw = validRawNode({ type: 'node' })
    delete raw.angle
    expectValidationError(() => parseMapNode(raw, 'nodes[0]'), 'MAP_NODE_ANGLE_INVALID', 'nodes[0].angle')
  })

  it('站点 angle 为 null 合法', () => {
    expect(parseMapNode(validRawNode({ type: 'work', angle: null }), 'nodes[0]').angle).toBeNull()
  })

  it.each([['1.2'], [Number.NaN], [Number.POSITIVE_INFINITY], [{}]])('站点 angle %j 被拒绝', (angle) => {
    expectValidationError(
      () => parseMapNode(validRawNode({ type: 'work', angle }), 'nodes[0]'),
      'MAP_NODE_ANGLE_INVALID',
      'nodes[0].angle',
    )
  })

  it('站点有限弧度进入领域模型时规范化到 [-π, π)', () => {
    expect(parseMapNode(validRawNode({ type: 'charge', angle: 3 * Math.PI }), 'nodes[0]').angle).toBe(-Math.PI)
    expect(parseMapNode(validRawNode({ type: 'park', angle: -Math.PI / 2 }), 'nodes[0]').angle).toBeCloseTo(-Math.PI / 2, 12)
    expect(parseMapNode(validRawNode({ type: 'work', angle: 2 * Math.PI }), 'nodes[0]').angle).toBe(0)
  })
})

describe('§3.3 edgeType 行：只接受 LINE/BEZIER', () => {
  it.each(['CURVE', 'line', 'bezier', 2, null])('edgeType %j 被拒绝', (edgeType) => {
    expectValidationError(
      () => parseMapEdge(validRawEdge({ edgeType }), 'edges[0]'),
      'MAP_EDGE_TYPE_INVALID',
      'edges[0].edgeType',
    )
  })

  it.each(['LINE', 'BEZIER'] as const)('合法 edgeType %s 通过', (edgeType) => {
    const control =
      edgeType === 'LINE'
        ? { cx: null, cy: null, dx: null, dy: null }
        : { cx: 1, cy: 1, dx: 2, dy: 2 }
    expect(parseMapEdge(validRawEdge({ edgeType, ...control }), 'edges[0]').edgeType).toBe(edgeType)
  })
})

describe('§3.3 isBackEdge 行：必须是 boolean，不接受 0/1 或字符串转换', () => {
  it.each([[0], [1], ['true'], ['false'], [null]])('isBackEdge %j 被拒绝', (isBackEdge) => {
    expectValidationError(
      () => parseMapEdge(validRawEdge({ isBackEdge }), 'edges[0]'),
      'MAP_IS_BACK_EDGE_INVALID',
      'edges[0].isBackEdge',
    )
  })

  it.each([[true], [false]])('isBackEdge %j 合法', (isBackEdge) => {
    expect(parseMapEdge(validRawEdge({ isBackEdge }), 'edges[0]').isBackEdge).toBe(isBackEdge)
  })
})

describe('§3.3 控制点行：LINE 全 null，BEZIER 全有限，不做类型降级', () => {
  it.each(['cx', 'cy', 'dx', 'dy'] as const)('LINE 控制点 %s 非 null 被拒绝', (key) => {
    expectValidationError(
      () => parseMapEdge(validRawEdge({ [key]: 0 }), 'edges[0]'),
      'MAP_CONTROL_POINTS_INVALID',
      `edges[0].${key}`,
    )
  })

  it('LINE 控制点全 null 合法', () => {
    const edge = parseMapEdge(validRawEdge(), 'edges[0]')
    expect(edge.edgeType).toBe('LINE')
    expect([edge.cx, edge.cy, edge.dx, edge.dy]).toEqual([null, null, null, null])
  })

  it.each(['cx', 'cy', 'dx', 'dy'] as const)('BEZIER 控制点 %s 缺失或为 null 被拒绝', (key) => {
    const control = { cx: 1, cy: 1, dx: 2, dy: 2, [key]: null }
    expectValidationError(
      () => parseMapEdge(validRawEdge({ edgeType: 'BEZIER', ...control }), 'edges[0]'),
      'MAP_CONTROL_POINTS_INVALID',
      `edges[0].${key}`,
    )
  })

  it('BEZIER 控制点非有限数值被拒绝', () => {
    const control = { cx: 1, cy: Number.NaN, dx: 2, dy: 2 }
    expectValidationError(
      () => parseMapEdge(validRawEdge({ edgeType: 'BEZIER', ...control }), 'edges[0]'),
      'MAP_CONTROL_POINTS_INVALID',
      'edges[0].cy',
    )
  })

  it('BEZIER 控制点同样受坐标绝对值上限约束', () => {
    const control = { cx: 1001, cy: 1, dx: 2, dy: 2 }
    expectValidationError(
      () => parseMapEdge(validRawEdge({ edgeType: 'BEZIER', ...control }), 'edges[0]'),
      'MAP_COORDINATE_OUT_OF_RANGE',
      'edges[0].cx',
    )
  })

  it('BEZIER 控制点全有限合法', () => {
    const edge = parseMapEdge(
      validRawEdge({ edgeType: 'BEZIER', cx: 1, cy: 5, dx: 2, dy: 5 }),
      'edges[0]',
    )
    expect(edge.edgeType).toBe('BEZIER')
    expect([edge.cx, edge.cy, edge.dx, edge.dy]).toEqual([1, 5, 2, 5])
  })
})

describe('§3.3 节点引用行：snodeId/enodeId 必须引用存在的节点', () => {
  it('起点引用不存在的节点被拒绝', () => {
    const error = expectValidationError(
      () => assertNodeReferencesExist([makeEdge({ edgeType: 'LINE', snodeId: 'ghost' })], new Set(['n1'])),
      'MAP_NODE_REFERENCE_INVALID',
      'edges[0].snodeId',
    )
    expect(error.message).toContain('ghost')
  })

  it('终点引用不存在的节点被拒绝', () => {
    expectValidationError(
      () => assertNodeReferencesExist(
        [makeEdge({ edgeType: 'LINE' }), makeEdge({ edgeType: 'LINE', id: 'e2', enodeId: 'ghost' })],
        new Set(['n1', 'n2']),
      ),
      'MAP_NODE_REFERENCE_INVALID',
      'edges[1].enodeId',
    )
  })

  it('nodes 为空但 edges 非空：引用必然失败', () => {
    expectValidationError(
      () => assertNodeReferencesExist([makeEdge({ edgeType: 'LINE' })], new Set()),
      'MAP_NODE_REFERENCE_INVALID',
      'edges[0].snodeId',
    )
  })

  it('全部引用存在时通过', () => {
    expect(() =>
      assertNodeReferencesExist([makeEdge({ edgeType: 'LINE' })], new Set(['n1', 'n2'])),
    ).not.toThrow()
  })
})

describe('§3.3 路径长度行：几何弧长 L < 0.01m 报错，不静默跳过', () => {
  it('LINE 弧长为弦长', () => {
    expect(computeEdgeArcLength(makeEdge({ edgeType: 'LINE' }))).toBe(5)
  })

  it('零长度 LINE 被拒绝', () => {
    expectValidationError(
      () => assertEdgeArcLengths([makeEdge({ edgeType: 'LINE', ex: 0, ey: 0 })]),
      'MAP_PATH_TOO_SHORT',
      'edges[0]',
    )
  })

  it('弧长 0.005m 的 LINE 被拒绝', () => {
    const error = expectValidationError(
      () => assertEdgeArcLengths([makeEdge({ edgeType: 'LINE', ex: 0.003, ey: 0.004 })]),
      'MAP_PATH_TOO_SHORT',
      'edges[0]',
    )
    expect(error.message).toContain('0.01')
  })

  it('弧长恰为 0.01m 合法（规则为 L < 0.01 报错）', () => {
    expect(() =>
      assertEdgeArcLengths([makeEdge({ edgeType: 'LINE', ex: 0.01, ey: 0 })]),
    ).not.toThrow()
  })

  it('BEZIER 弧长按自适应细分计算', () => {
    // 控制点共线的直线贝塞尔：弧长 = 弦长 2
    const length = computeEdgeArcLength(
      makeEdge({ edgeType: 'BEZIER', sx: 0, sy: 0, cx: 0.5, cy: 0, dx: 1.5, dy: 0, ex: 2, ey: 0 }),
    )
    expect(length).toBeCloseTo(2, 6)
  })

  it('控制点全部重合的退化 BEZIER 被拒绝', () => {
    expectValidationError(
      () =>
        assertEdgeArcLengths([
          makeEdge({ edgeType: 'BEZIER', sx: 1, sy: 1, cx: 1, cy: 1, dx: 1, dy: 1, ex: 1, ey: 1 }),
        ]),
      'MAP_PATH_TOO_SHORT',
      'edges[0]',
    )
  })

  it('弦长小于 0.01m 但弧长达标的弯曲 BEZIER 合法', () => {
    const curved = makeEdge({
      edgeType: 'BEZIER',
      sx: 0, sy: 0, cx: 0, cy: 0.02, dx: 0.005, dy: 0.02, ex: 0.005, ey: 0,
    })
    expect(computeEdgeArcLength(curved)).toBeGreaterThan(0.01)
    expect(() => assertEdgeArcLengths([curved])).not.toThrow()
  })

  it('极端控制多边形触发细分深度上限仍返回有限弧长', () => {
    // 控制点在坐标上限附近剧烈往返、弦长为 0：需要超过 16 层细分才收敛
    const wild = makeEdge({
      edgeType: 'BEZIER',
      sx: 0, sy: 0, cx: 1000, cy: 0, dx: -1000, dy: 0, ex: 0, ey: 0,
    })
    const length = computeEdgeArcLength(wild)
    expect(Number.isFinite(length)).toBe(true)
    expect(length).toBeGreaterThan(100)
    expect(() => assertEdgeArcLengths([wild])).not.toThrow()
  })
})

describe('§3.3 容量行：nodes + edges ≤ 20000（MapCapacityError）', () => {
  it('恰为 20000 合法', () => {
    expect(() => assertMapElementCapacity(10_000, 10_000)).not.toThrow()
  })

  it('20001 返回 MapCapacityError 并携带实际值与上限', () => {
    try {
      assertMapElementCapacity(10_000, 10_001)
      throw new Error('应抛出 MapCapacityError')
    } catch (error) {
      expect(error).toBeInstanceOf(MapCapacityError)
      const capacityError = error as MapCapacityError
      expect(capacityError.code).toBe('MAP_ELEMENTS_EXCEEDED')
      expect(capacityError.actual).toBe(20_001)
      expect(capacityError.limit).toBe(20_000)
      expect(capacityError.message).toContain('20001')
    }
  })
})

describe('§3.3 地图范围行：bbox 宽度和深度均 ≤ 220m（MapCapacityError）', () => {
  it('空地图（null bounds）跳过范围检查', () => {
    expect(() => assertMapExtentWithinLimits(null)).not.toThrow()
  })

  it('宽度与深度恰为 220m 合法', () => {
    expect(() => assertMapExtentWithinLimits({ minX: 0, maxX: 220, minY: -220, maxY: 0 })).not.toThrow()
  })

  it('宽度超过 220m 返回 MapCapacityError', () => {
    try {
      assertMapExtentWithinLimits({ minX: 0, maxX: 220.01, minY: 0, maxY: 10 })
      throw new Error('应抛出 MapCapacityError')
    } catch (error) {
      expect(error).toBeInstanceOf(MapCapacityError)
      const capacityError = error as MapCapacityError
      expect(capacityError.code).toBe('MAP_EXTENT_EXCEEDED')
      expect(capacityError.actual).toBeCloseTo(220.01, 10)
      expect(capacityError.limit).toBe(220)
    }
  })

  it('深度超过 220m 同样被拒绝', () => {
    try {
      assertMapExtentWithinLimits({ minX: 0, maxX: 10, minY: 0, maxY: 221 })
      throw new Error('应抛出 MapCapacityError')
    } catch (error) {
      expect((error as MapCapacityError).code).toBe('MAP_EXTENT_EXCEEDED')
      expect((error as MapCapacityError).actual).toBe(221)
    }
  })
})

describe('集合解析：字段级错误逐条收集，坏记录不进入结果（§3.3、§11 错误总数）', () => {
  it('节点集合：逐条收集多个错误，合法记录保留', () => {
    const { nodes, errors } = parseMapNodes([
      validRawNode({ id: 'ok1' }),
      validRawNode({ id: 'bad', type: 'gate' }),
      null,
      validRawNode({ id: 'ok2' }),
    ])
    expect(nodes.map((n) => n.id)).toEqual(['ok1', 'ok2'])
    expect(errors.map((e) => e.code)).toEqual(['MAP_NODE_TYPE_INVALID', 'MAP_ITEM_NOT_OBJECT'])
    expect(errors[0].fieldPath).toBe('nodes[1].type')
    expect(errors[1].fieldPath).toBe('nodes[2]')
  })

  it('路径集合：逐条收集错误，合法记录保留', () => {
    const { edges, errors } = parseMapEdges([
      validRawEdge({ id: 'ok' }),
      validRawEdge({ id: 'bad', isBackEdge: 1 }),
    ])
    expect(edges.map((e) => e.id)).toEqual(['ok'])
    expect(errors).toHaveLength(1)
    expect(errors[0].code).toBe('MAP_IS_BACK_EDGE_INVALID')
    expect(errors[0].fieldPath).toBe('edges[1].isBackEdge')
  })

  it('空集合无错误', () => {
    expect(parseMapNodes([])).toEqual({ nodes: [], errors: [] })
    expect(parseMapEdges([])).toEqual({ edges: [], errors: [] })
  })

  it('非校验类异常不吞没，原样向上抛出', () => {
    const hostile = {
      get id(): string {
        throw new TypeError('boom')
      },
    }
    expect(() => parseMapNodes([hostile])).toThrow(TypeError)
    expect(() => parseMapEdges([hostile])).toThrow(TypeError)
  })
})
