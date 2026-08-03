import { describe, expect, it } from 'vitest'

import {
  FactoryMapError,
  MapCapacityError,
  MapEnvelopeError,
  MapGeometryError,
  MapHttpError,
  MapNetworkError,
  MapParseError,
  MapValidationError,
  SceneBuildError,
  WebGLUnavailableError,
} from './errors'

describe('FactoryMapError 基类（SPEC §3.3、§11）', () => {
  it('错误对象携带稳定错误码、字段路径与简体中文摘要', () => {
    const error = new MapValidationError('MAP_NODE_TYPE_INVALID', '节点类型必须是 node/work/park/charge 之一', {
      fieldPath: 'nodes[17].type',
    })
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(FactoryMapError)
    expect(error).toBeInstanceOf(MapValidationError)
    expect(error.code).toBe('MAP_NODE_TYPE_INVALID')
    expect(error.fieldPath).toBe('nodes[17].type')
    expect(error.message).toContain('节点类型')
  })

  it('fieldPath 与 cause 均可选', () => {
    const cause = new TypeError('boom')
    const withCause = new MapParseError('MAP_PARSE_JSON', 'JSON 语法错误', { cause })
    expect(withCause.cause).toBe(cause)
    expect(withCause.fieldPath).toBeUndefined()

    const minimal = new MapNetworkError('MAP_NETWORK_FAILED', '网络请求失败')
    expect(minimal.fieldPath).toBeUndefined()
    expect(minimal.cause).toBeUndefined()
  })
})

describe('§11 错误类型枚举', () => {
  it('每种错误类型的 name 固定为其类名', () => {
    const cases: Array<[FactoryMapError, string]> = [
      [new MapNetworkError('C', '网络'), 'MapNetworkError'],
      [new MapHttpError('C', 'HTTP'), 'MapHttpError'],
      [new MapParseError('C', '解析'), 'MapParseError'],
      [new MapEnvelopeError('C', '信封'), 'MapEnvelopeError'],
      [new MapValidationError('C', '校验'), 'MapValidationError'],
      [new MapCapacityError('C', '容量'), 'MapCapacityError'],
      [new MapGeometryError('C', '几何'), 'MapGeometryError'],
      [new SceneBuildError('C', '场景'), 'SceneBuildError'],
      [new WebGLUnavailableError('C', 'WebGL'), 'WebGLUnavailableError'],
    ]
    for (const [error, name] of cases) {
      expect(error.name).toBe(name)
      expect(error.code).toBe('C')
    }
  })
})

describe('MapValidationError', () => {
  it('单发错误 totalCount 默认为 1', () => {
    expect(new MapValidationError('C', '摘要').totalCount).toBe(1)
  })

  it('withTotalCount 返回携带错误总数的新实例，原实例不变', () => {
    const first = new MapValidationError('MAP_ID_DUPLICATED', '节点 id 重复', {
      fieldPath: 'nodes[2].id',
    })
    const counted = first.withTotalCount(3)
    expect(counted).not.toBe(first)
    expect(counted.totalCount).toBe(3)
    expect(counted.code).toBe('MAP_ID_DUPLICATED')
    expect(counted.fieldPath).toBe('nodes[2].id')
    expect(counted.message).toBe('节点 id 重复')
    expect(first.totalCount).toBe(1)
  })
})

describe('MapCapacityError', () => {
  it('携带实际值与上限（§11：页面显示实际值与上限）', () => {
    const error = new MapCapacityError('MAP_ELEMENTS_EXCEEDED', '地图元素总数超限', {
      actual: 20001,
      limit: 20000,
    })
    expect(error.actual).toBe(20001)
    expect(error.limit).toBe(20000)
  })

  it('actual/limit 可选', () => {
    const error = new MapCapacityError('MAP_BYTES_EXCEEDED', 'payload 超限')
    expect(error.actual).toBeUndefined()
    expect(error.limit).toBeUndefined()
  })
})
