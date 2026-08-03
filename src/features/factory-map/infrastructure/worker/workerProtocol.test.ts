/**
 * workerProtocol 单元测试（SPEC §3.1、§5.1、§11）。
 *
 * 覆盖：请求/结果可序列化形状、成功结果 transfer 列表完整性（13 个 buffer）、
 * 六类 §11 错误的序列化往返保真、接收侧协议校验（非法消息 → SceneBuildError）。
 */

import { describe, expect, it } from 'vitest'

import type { FactorySceneModel } from '../../application/factorySceneModel'
import {
  FactoryMapError,
  MapCapacityError,
  MapEnvelopeError,
  MapGeometryError,
  MapParseError,
  MapValidationError,
  SceneBuildError,
} from '../../domain/errors'
import { buildFactorySceneModel } from './builders/buildFactorySceneModel'
import type { SceneBuildOptions } from './builders/buildFactorySceneModel'
import {
  collectSceneModelTransferables,
  createMapBuildErrorResult,
  createMapBuildRequest,
  createMapBuildSuccessResult,
  deserializeMapError,
  parseMapBuildResult,
  serializeMapError,
} from './workerProtocol'

// §13 固定值内联注入（与 TASK-005 测试同一口径）
const OPTIONS: SceneBuildOptions = {
  factoryMargin: 10,
  labelAnchorY: 0.5,
  path: {
    pathWidth: 0.12,
    curveMaxError: 0.01,
    curveMaxSegment: 0.25,
    miterLimit: 2,
    chevronSpacing: 6,
    chevronMinPathLength: 1.0,
  },
  nodes: {
    stationColors: { work: '#2196F3', charge: '#8BC34A', park: '#F44336' },
  },
}

function makeEnvelope(nodes: unknown[], edges: unknown[]): unknown {
  return {
    code: 200,
    message: 'ok',
    data: { currentMapInfoVersion: { mapJson: { nodes, edges } } },
  }
}

/** 含站点（ring+direction）、普通节点与正/反向边的小地图：所有批次非空 */
function makeModel(): FactorySceneModel {
  const nodes = [
    { id: 'w1', name: '站点1', type: 'work', x: 0, y: 0, angle: 0.5 },
    { id: 'n1', name: '节点1', type: 'node', x: 3, y: 0, angle: null },
    { id: 'n2', name: '节点2', type: 'node', x: 0, y: 4, angle: null },
  ]
  const edges = [
    {
      id: 'e1', name: '路径1', edgeType: 'LINE',
      sx: 0, sy: 0, ex: 3, ey: 0,
      cx: null, cy: null, dx: null, dy: null,
      isBackEdge: false, snodeId: 'w1', enodeId: 'n1',
    },
    {
      id: 'e2', name: '路径2', edgeType: 'LINE',
      sx: 0, sy: 4, ex: 0, ey: 0,
      cx: null, cy: null, dx: null, dy: null,
      isBackEdge: true, snodeId: 'n2', enodeId: 'w1',
    },
  ]
  return buildFactorySceneModel(makeEnvelope(nodes, edges), OPTIONS)
}

describe('createMapBuildRequest（§3.1：transferable ArrayBuffer + requestId）', () => {
  it('请求携带 type/requestId/payload/options，payload 列入 transfer 列表', () => {
    const payload = new ArrayBuffer(8)
    const { message, transfer } = createMapBuildRequest(7, payload, OPTIONS)

    expect(message).toEqual({ type: 'build', requestId: 7, payload, options: OPTIONS })
    expect(transfer).toEqual([payload])
    expect(transfer[0]).toBe(payload)
  })
})

describe('成功结果 transfer 列表完整性（§3.1、§5.1）', () => {
  it('模型内全部 13 个 TypedArray buffer 均列入 transfer，无遗漏无多余', () => {
    const model = makeModel()
    const { message, transfer } = createMapBuildSuccessResult(3, model)

    expect(message).toEqual({ type: 'success', requestId: 3, model })

    const expectedBuffers = [
      model.paths.forward.positions.buffer,
      model.paths.forward.normals.buffer,
      model.paths.forward.indices.buffer,
      model.paths.backward.positions.buffer,
      model.paths.backward.normals.buffer,
      model.paths.backward.indices.buffer,
      model.arrows.forward.matrices.buffer,
      model.arrows.backward.matrices.buffer,
      model.nodes.dots.matrices.buffer,
      model.nodes.rings.matrices.buffer,
      model.nodes.rings.colors.buffer,
      model.nodes.directions.matrices.buffer,
      model.nodes.directions.colors.buffer,
    ]
    expect(transfer).toHaveLength(13)
    for (const buffer of expectedBuffers) {
      expect(transfer).toContain(buffer)
    }
  })

  it('空态模型（全部批次为空数组）仍收集 13 个 buffer', () => {
    const model = buildFactorySceneModel(makeEnvelope([], []), OPTIONS)
    expect(collectSceneModelTransferables(model)).toHaveLength(13)
  })
})

describe('错误序列化往返（§11：稳定错误码/字段路径/摘要跨线程保真）', () => {
  const cases: Array<{ label: string; error: FactoryMapError; assertExtra?: (e: FactoryMapError) => void }> = [
    {
      label: 'MapParseError',
      error: new MapParseError('MAP_INVALID_UTF8', '地图数据不是合法的 UTF-8 文本'),
    },
    {
      label: 'MapEnvelopeError',
      error: new MapEnvelopeError('MAP_ENVELOPE_CODE_INVALID', '信封 code 必须严格等于 200', {
        fieldPath: 'code',
      }),
    },
    {
      label: 'MapValidationError（totalCount 保真）',
      error: new MapValidationError('MAP_NODE_TYPE_INVALID', '节点类型非法', {
        fieldPath: 'nodes[17].type',
        totalCount: 5,
      }),
      assertExtra: (e) => expect((e as MapValidationError).totalCount).toBe(5),
    },
    {
      label: 'MapCapacityError（actual/limit 保真）',
      error: new MapCapacityError('MAP_ELEMENT_COUNT_EXCEEDED', '元素总数超限', {
        actual: 21000,
        limit: 20000,
      }),
      assertExtra: (e) => {
        expect((e as MapCapacityError).actual).toBe(21000)
        expect((e as MapCapacityError).limit).toBe(20000)
      },
    },
    {
      label: 'MapGeometryError',
      error: new MapGeometryError('MAP_GEOMETRY_CURVE_TOO_COMPLEX', '贝塞尔细分触底', {
        fieldPath: 'edges[3]',
      }),
    },
    {
      label: 'SceneBuildError',
      error: new SceneBuildError('SCENE_MODEL_ASSERTION_FAILED', 'transfer 前断言失败'),
    },
  ]

  for (const { label, error, assertExtra } of cases) {
    it(`${label}：往返后 instanceof、code、message、fieldPath 保真`, () => {
      const serialized = serializeMapError(error)
      // 协议载体必须可结构化克隆（postMessage 语义）
      const cloned = structuredClone(serialized)
      const restored = deserializeMapError(cloned)

      expect(restored).toBeInstanceOf(error.constructor as new () => FactoryMapError)
      expect(restored.name).toBe(error.name)
      expect(restored.code).toBe(error.code)
      expect(restored.message).toBe(error.message)
      expect(restored.fieldPath).toBe(error.fieldPath)
      assertExtra?.(restored)
    })
  }

  it('非 MapValidationError/MapCapacityError 不携带 totalCount/actual/limit', () => {
    const serialized = serializeMapError(new MapParseError('MAP_JSON_SYNTAX', '语法错误'))
    expect(serialized.totalCount).toBeUndefined()
    expect(serialized.actual).toBeUndefined()
    expect(serialized.limit).toBeUndefined()
  })

  it('未识别错误名 → SceneBuildError，保留原错误码/摘要/字段路径', () => {
    const restored = deserializeMapError({
      name: 'SomeUnknownError',
      code: 'X_CODE',
      message: '未知错误摘要',
      fieldPath: 'nodes[0]',
      totalCount: undefined,
      actual: undefined,
      limit: undefined,
    })
    expect(restored).toBeInstanceOf(SceneBuildError)
    expect(restored.code).toBe('X_CODE')
    expect(restored.message).toBe('未知错误摘要')
    expect(restored.fieldPath).toBe('nodes[0]')
  })

  it('错误结果消息可序列化且 transfer 列表为空', () => {
    const { message, transfer } = createMapBuildErrorResult(
      9,
      new MapEnvelopeError('MAP_ENVELOPE_FIELD_MISSING', '缺字段', { fieldPath: 'data' }),
    )
    expect(transfer).toEqual([])
    expect(structuredClone(message)).toEqual(message)
  })
})

describe('parseMapBuildResult（接收侧协议校验）', () => {
  it('合法 success 结果：原样返回（model 保持引用）', () => {
    const model = makeModel()
    const value = { type: 'success', requestId: 4, model }
    const result = parseMapBuildResult(value)
    expect(result.type).toBe('success')
    expect(result.requestId).toBe(4)
    expect((result as { model: FactorySceneModel }).model).toBe(model)
  })

  it('合法 error 结果：错误字段（含可选字段）完整', () => {
    const result = parseMapBuildResult({
      type: 'error',
      requestId: 2,
      error: {
        name: 'MapValidationError',
        code: 'MAP_NODE_TYPE_INVALID',
        message: '节点类型非法',
        fieldPath: 'nodes[1].type',
        totalCount: 3,
        actual: undefined,
        limit: undefined,
      },
    })
    expect(result).toEqual({
      type: 'error',
      requestId: 2,
      error: {
        name: 'MapValidationError',
        code: 'MAP_NODE_TYPE_INVALID',
        message: '节点类型非法',
        fieldPath: 'nodes[1].type',
        totalCount: 3,
        actual: undefined,
        limit: undefined,
      },
    })
  })

  it('createMapBuildSuccessResult/ErrorResult 输出可经 parseMapBuildResult 往返', () => {
    const model = makeModel()
    const success = parseMapBuildResult(createMapBuildSuccessResult(1, model).message)
    expect(success.type).toBe('success')

    const failure = parseMapBuildResult(
      createMapBuildErrorResult(1, new MapParseError('MAP_JSON_SYNTAX', '语法错误')).message,
    )
    expect(failure.type).toBe('error')
  })

  const invalidMessages: Array<{ label: string; value: unknown }> = [
    { label: '非对象（字符串）', value: 'garbage' },
    { label: 'null', value: null },
    { label: '数组', value: [1, 2] },
    { label: 'requestId 缺失', value: { type: 'success', model: {} } },
    { label: 'requestId 非数值', value: { type: 'success', requestId: '1', model: {} } },
    { label: 'requestId 非有限', value: { type: 'success', requestId: Number.NaN, model: {} } },
    { label: '未知结果类型', value: { type: 'progress', requestId: 1 } },
    { label: 'success 缺 model', value: { type: 'success', requestId: 1 } },
    { label: 'success model 非对象', value: { type: 'success', requestId: 1, model: 42 } },
    { label: 'error 载体非对象', value: { type: 'error', requestId: 1, error: 'oops' } },
    {
      label: 'error.name 缺失',
      value: { type: 'error', requestId: 1, error: { code: 'C', message: 'm' } },
    },
    {
      label: 'error.code 非字符串',
      value: { type: 'error', requestId: 1, error: { name: 'MapParseError', code: 1, message: 'm' } },
    },
    {
      label: 'error.message 非字符串',
      value: { type: 'error', requestId: 1, error: { name: 'MapParseError', code: 'C', message: null } },
    },
    {
      label: 'error.fieldPath 类型非法',
      value: {
        type: 'error', requestId: 1,
        error: { name: 'MapParseError', code: 'C', message: 'm', fieldPath: 5 },
      },
    },
    {
      label: 'error.totalCount 类型非法',
      value: {
        type: 'error', requestId: 1,
        error: { name: 'MapValidationError', code: 'C', message: 'm', totalCount: '3' },
      },
    },
    {
      label: 'error.actual 类型非法',
      value: {
        type: 'error', requestId: 1,
        error: { name: 'MapCapacityError', code: 'C', message: 'm', actual: 'x' },
      },
    },
    {
      label: 'error.limit 类型非法',
      value: {
        type: 'error', requestId: 1,
        error: { name: 'MapCapacityError', code: 'C', message: 'm', limit: false },
      },
    },
  ]

  for (const { label, value } of invalidMessages) {
    it(`${label} → SceneBuildError（MAP_WORKER_PROTOCOL_INVALID）`, () => {
      let caught: unknown
      try {
        parseMapBuildResult(value)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(SceneBuildError)
      expect((caught as SceneBuildError).code).toBe('MAP_WORKER_PROTOCOL_INVALID')
    })
  }
})
