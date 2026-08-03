/// <reference types="node" />
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { deriveFactoryBounds, computeMapBounds } from './bounds'
import { decodeMapEnvelope } from './decodeMapEnvelope'
import { MapCapacityError, MapEnvelopeError, MapValidationError } from './errors'

function makeNode(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: `节点${id}`, type: 'node', x: 0, y: 0, angle: null, ...overrides }
}

function makeLineEdge(
  id: string,
  snodeId: string,
  enodeId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id, name: `路径${id}`, edgeType: 'LINE',
    sx: 0, sy: 0, ex: 1, ey: 0,
    cx: null, cy: null, dx: null, dy: null,
    isBackEdge: false, snodeId, enodeId,
    ...overrides,
  }
}

function makeEnvelope(mapJson: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 200,
    message: 'success',
    data: { currentMapInfoVersion: { mapJson } },
    ...overrides,
  }
}

function expectError(fn: () => unknown, code: string, fieldPath?: string): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(MapValidationError)
    expect((error as MapValidationError).code).toBe(code)
    if (fieldPath !== undefined) {
      expect((error as MapValidationError).fieldPath).toBe(fieldPath)
    }
    return
  }
  throw new Error(`应抛出 ${code}，实际未抛出`)
}

describe('decodeMapEnvelope 正常信封（SPEC §3.1、§15.1）', () => {
  it('合法信封解码为只读 FactoryMap，字段规范化', () => {
    const envelope = makeEnvelope({
      nodes: [
        makeNode('a', { x: 1.5, y: -2.5 }),
        makeNode('b', { type: 'work', x: 3, y: 4, angle: 3 * Math.PI }),
      ],
      edges: [makeLineEdge('e1', 'a', 'b')],
    })
    const map = decodeMapEnvelope(envelope)
    expect(map.nodes).toHaveLength(2)
    expect(map.edges).toHaveLength(1)
    expect(map.nodes[0]).toMatchObject({ id: 'a', x: 1.5, y: -2.5, angle: null })
    // 站点 angle 规范化到 [-π, π)
    expect(map.nodes[1].angle).toBe(-Math.PI)
    expect(Object.isFrozen(map)).toBe(true)
    expect(Object.isFrozen(map.nodes[0])).toBe(true)
  })

  it('顶层未知字段（timestamp 等）一律忽略', () => {
    const envelope = makeEnvelope(
      { nodes: [], edges: [] },
      { timestamp: 1785466870389, traceId: 'x', extra: { nested: true } },
    )
    expect(() => decodeMapEnvelope(envelope)).not.toThrow()
  })

  it('mapJson 内 zones/nodeEdgeGroups 等未列出字段不进入领域模型（§3.2）', () => {
    const envelope = makeEnvelope({
      nodes: [makeNode('a')],
      edges: [],
      zones: [{ id: 'z1' }],
      nodeEdgeGroups: [{ id: 'g1' }],
      vehicles: [1, 2, 3],
    })
    const map = decodeMapEnvelope(envelope)
    expect(Object.keys(map).sort()).toEqual(['edges', 'nodes'])
  })

  it('节点/路径项上的未消费业务字段被忽略', () => {
    const envelope = makeEnvelope({
      nodes: [makeNode('a', { mapId: 'm1', actions: [], userDefinedProperties: {} })],
      edges: [
        makeLineEdge('e1', 'a', 'a', { maxSpeed: 2, allowVehicleGroups: ['g'], extra: 'x' }),
      ],
    })
    const map = decodeMapEnvelope(envelope)
    expect(map.nodes[0]).not.toHaveProperty('mapId')
    expect(map.edges[0]).not.toHaveProperty('maxSpeed')
  })

  it('空图（nodes 与 edges 同时为空）合法，empty 语义由上层判定（§3.3、§11）', () => {
    const map = decodeMapEnvelope(makeEnvelope({ nodes: [], edges: [] }))
    expect(map.nodes).toHaveLength(0)
    expect(map.edges).toHaveLength(0)
  })

  it('nodes 非空、edges 为空是合法输入（§11）', () => {
    const map = decodeMapEnvelope(makeEnvelope({ nodes: [makeNode('a')], edges: [] }))
    expect(map.nodes).toHaveLength(1)
  })
})

describe('decodeMapEnvelope 信封错误（§3.1、§11 MapEnvelopeError）', () => {
  it.each([[null], [[1, 2]], [42], ['json']])('顶层不是对象：%j', (payload) => {
    try {
      decodeMapEnvelope(payload)
      throw new Error('应抛出 MapEnvelopeError')
    } catch (error) {
      expect(error).toBeInstanceOf(MapEnvelopeError)
      expect((error as MapEnvelopeError).code).toBe('MAP_ENVELOPE_NOT_OBJECT')
      expect((error as MapEnvelopeError).fieldPath).toBe('(root)')
    }
  })

  it('原始 mapJson 本体不是合法顶层输入', () => {
    try {
      decodeMapEnvelope({ nodes: [], edges: [] })
      throw new Error('应抛出 MapEnvelopeError')
    } catch (error) {
      expect((error as MapEnvelopeError).code).toBe('MAP_ENVELOPE_CODE_INVALID')
    }
  })

  it.each([[0], [404], ['200'], [200.5], [null], [{}]])('code 必须严格等于 200：%j', (code) => {
    try {
      decodeMapEnvelope(makeEnvelope({ nodes: [], edges: [] }, { code }))
      throw new Error('应抛出 MapEnvelopeError')
    } catch (error) {
      expect(error).toBeInstanceOf(MapEnvelopeError)
      const envelopeError = error as MapEnvelopeError
      expect(envelopeError.code).toBe('MAP_ENVELOPE_CODE_INVALID')
      expect(envelopeError.fieldPath).toBe('code')
    }
  })

  it.each([
    [{ data: undefined }, 'data'],
    [{ data: null }, 'data'],
    [{ data: {} }, 'data.currentMapInfoVersion'],
    [{ data: { currentMapInfoVersion: null } }, 'data.currentMapInfoVersion'],
    [{ data: { currentMapInfoVersion: {} } }, 'data.currentMapInfoVersion.mapJson'],
    [{ data: { currentMapInfoVersion: { mapJson: null } } }, 'data.currentMapInfoVersion.mapJson'],
    [{ data: { currentMapInfoVersion: { mapJson: [] } } }, 'data.currentMapInfoVersion.mapJson'],
  ])('信封字段缺失：%j', (patch, fieldPath) => {
    try {
      decodeMapEnvelope(makeEnvelope({ nodes: [], edges: [] }, patch))
      throw new Error('应抛出 MapEnvelopeError')
    } catch (error) {
      expect(error).toBeInstanceOf(MapEnvelopeError)
      const envelopeError = error as MapEnvelopeError
      expect(envelopeError.code).toBe('MAP_ENVELOPE_FIELD_MISSING')
      expect(envelopeError.fieldPath).toBe(fieldPath)
    }
  })
})

describe('decodeMapEnvelope 集合与字段校验（§3.3、§15.1）', () => {
  it('nodes 必须是数组', () => {
    expectError(
      () => decodeMapEnvelope(makeEnvelope({ nodes: null, edges: [] })),
      'MAP_COLLECTION_NOT_ARRAY',
      'nodes',
    )
  })

  it('edges 必须是数组', () => {
    expectError(
      () => decodeMapEnvelope(makeEnvelope({ nodes: [], edges: {} })),
      'MAP_COLLECTION_NOT_ARRAY',
      'edges',
    )
  })

  it('非法数值被拒绝且不降级', () => {
    expectError(
      () => decodeMapEnvelope(makeEnvelope({ nodes: [makeNode('a', { x: '1' })], edges: [] })),
      'MAP_NUMBER_INVALID',
      'nodes[0].x',
    )
  })

  it('普通 node 携带 angle 被拒绝', () => {
    expectError(
      () => decodeMapEnvelope(makeEnvelope({ nodes: [makeNode('a', { angle: 1.5 })], edges: [] })),
      'MAP_NODE_ANGLE_INVALID',
      'nodes[0].angle',
    )
  })

  it('未知节点类型被拒绝：错误码 MAP_NODE_TYPE_INVALID、字段路径 nodes[17].type（§3.3 示例）', () => {
    const nodes = Array.from({ length: 18 }, (_, i) => makeNode(`n${i}`))
    nodes[17] = makeNode('n17', { type: 'gate' })
    try {
      decodeMapEnvelope(makeEnvelope({ nodes, edges: [] }))
      throw new Error('应抛出 MapValidationError')
    } catch (error) {
      expect(error).toBeInstanceOf(MapValidationError)
      const validationError = error as MapValidationError
      expect(validationError.code).toBe('MAP_NODE_TYPE_INVALID')
      expect(validationError.fieldPath).toBe('nodes[17].type')
      expect(validationError.message).toContain('节点类型')
    }
  })

  it('控制点组合错误被拒绝', () => {
    expectError(
      () =>
        decodeMapEnvelope(
          makeEnvelope({
            nodes: [makeNode('a'), makeNode('b')],
            edges: [makeLineEdge('e1', 'a', 'b', { cx: 0.5 })],
          }),
        ),
      'MAP_CONTROL_POINTS_INVALID',
      'edges[0].cx',
    )
  })

  it('重复 id 被拒绝', () => {
    expectError(
      () =>
        decodeMapEnvelope(
          makeEnvelope({ nodes: [makeNode('a'), makeNode('a', { x: 1 })], edges: [] }),
        ),
      'MAP_ID_DUPLICATED',
      'nodes[1].id',
    )
  })

  it('失效引用被拒绝', () => {
    expectError(
      () =>
        decodeMapEnvelope(
          makeEnvelope({
            nodes: [makeNode('a')],
            edges: [makeLineEdge('e1', 'a', 'ghost')],
          }),
        ),
      'MAP_NODE_REFERENCE_INVALID',
      'edges[0].enodeId',
    )
  })

  it('nodes 为空但 edges 非空：因引用不成立而校验失败（§3.3 空数据行）', () => {
    expectError(
      () =>
        decodeMapEnvelope(
          makeEnvelope({ nodes: [], edges: [makeLineEdge('e1', 'a', 'b')] }),
        ),
      'MAP_NODE_REFERENCE_INVALID',
      'edges[0].snodeId',
    )
  })

  it('多个字段级错误：抛出首个并携带错误总数（§11）', () => {
    try {
      decodeMapEnvelope(
        makeEnvelope({
          nodes: [makeNode('a', { type: 'gate' }), makeNode('b', { x: 'bad' })],
          edges: [],
        }),
      )
      throw new Error('应抛出 MapValidationError')
    } catch (error) {
      const validationError = error as MapValidationError
      expect(validationError.code).toBe('MAP_NODE_TYPE_INVALID')
      expect(validationError.fieldPath).toBe('nodes[0].type')
      expect(validationError.totalCount).toBe(2)
    }
  })

  it('不忽略坏记录继续：单个坏记录使整个解码失败，无部分结果', () => {
    const nodes = [makeNode('ok1'), makeNode('bad', { type: 'gate' }), makeNode('ok2')]
    expect(() => decodeMapEnvelope(makeEnvelope({ nodes, edges: [] }))).toThrow(MapValidationError)
  })
})

describe('decodeMapEnvelope 容量与范围（§3.3、§11 MapCapacityError）', () => {
  it('元素总数超过 20000 返回 MapCapacityError', () => {
    const nodes = Array.from({ length: 20_001 }, (_, i) => makeNode(`n${i}`))
    try {
      decodeMapEnvelope(makeEnvelope({ nodes, edges: [] }))
      throw new Error('应抛出 MapCapacityError')
    } catch (error) {
      expect(error).toBeInstanceOf(MapCapacityError)
      const capacityError = error as MapCapacityError
      expect(capacityError.code).toBe('MAP_ELEMENTS_EXCEEDED')
      expect(capacityError.actual).toBe(20_001)
      expect(capacityError.limit).toBe(20_000)
    }
  })

  it('bbox 超过 220m 返回 MapCapacityError', () => {
    try {
      decodeMapEnvelope(
        makeEnvelope({ nodes: [makeNode('a', { x: 0 }), makeNode('b', { x: 221 })], edges: [] }),
      )
      throw new Error('应抛出 MapCapacityError')
    } catch (error) {
      expect(error).toBeInstanceOf(MapCapacityError)
      expect((error as MapCapacityError).code).toBe('MAP_EXTENT_EXCEEDED')
    }
  })

  it('bbox 恰为 220m 合法', () => {
    const map = decodeMapEnvelope(
      makeEnvelope({ nodes: [makeNode('a', { x: 0 }), makeNode('b', { x: 220, y: -220 })], edges: [] }),
    )
    expect(map.nodes).toHaveLength(2)
  })
})

describe('decodeMapEnvelope 基准数据（public/map.json，§3.4、§6.1）', () => {
  it('真实信封全量通过 §3.3 校验，规模与 bounds 符合基准指标', () => {
    const url = new URL('../../../../public/map.json', import.meta.url)
    const payload: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const map = decodeMapEnvelope(payload)

    expect(map.nodes).toHaveLength(1767)
    expect(map.edges).toHaveLength(3043)

    // 类型分布（§3.4）
    const typeCount = new Map<string, number>()
    for (const node of map.nodes) {
      typeCount.set(node.type, (typeCount.get(node.type) ?? 0) + 1)
    }
    expect(typeCount.get('node')).toBe(1303)
    expect(typeCount.get('work')).toBe(389)
    expect(typeCount.get('park')).toBe(64)
    expect(typeCount.get('charge')).toBe(11)

    // angle 规则：node 全部无朝向；站点 angle 已规范化
    for (const node of map.nodes) {
      if (node.type === 'node') {
        expect(node.angle).toBeNull()
      } else if (node.angle !== null) {
        expect(node.angle).toBeGreaterThanOrEqual(-Math.PI)
        expect(node.angle).toBeLessThan(Math.PI)
      }
    }

    // 地图范围 167.84m × 75.32m → 厂房内空 187.84m × 95.32m
    const bounds = computeMapBounds(map)
    expect(bounds).not.toBeNull()
    const factory = deriveFactoryBounds(bounds, 10)
    expect(factory.innerWidth).toBeCloseTo(187.84, 2)
    expect(factory.innerDepth).toBeCloseTo(95.32, 2)

    // 反向路径规模（§3.4）
    expect(map.edges.filter((edge) => edge.isBackEdge)).toHaveLength(878)
  })
})
