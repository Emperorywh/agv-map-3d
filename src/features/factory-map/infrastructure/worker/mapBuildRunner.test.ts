/**
 * mapBuildRunner 单元测试（SPEC §3.1、§11）。
 *
 * 覆盖：fatal UTF-8 解码、JSON 语法、信封/校验/容量/几何错误透传、
 * 未捕获异常 → SceneBuildError、非法请求 → 协议错误、requestId 占位与回显、
 * 成功结果 transfer 列表（13 个 buffer）；基准 public/map.json 全量构建。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { SceneBuildOptions } from './builders/buildFactorySceneModel'
import { runMapBuild, UNREADABLE_REQUEST_ID } from './mapBuildRunner'
import type { MapBuildErrorResult, MapBuildSuccessResult } from './workerProtocol'
import { createMapBuildRequest } from './workerProtocol'

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

function encode(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer
}

function makeEnvelope(nodes: unknown[], edges: unknown[]): string {
  return JSON.stringify({
    code: 200,
    message: 'ok',
    data: { currentMapInfoVersion: { mapJson: { nodes, edges } } },
  })
}

function nodeJson(id: string, type: string, x: number, y: number, angle: number | null = null) {
  return { id, name: `节点${id}`, type, x, y, angle }
}

function lineJson(id: string, snodeId: string, enodeId: string, isBackEdge = false) {
  return {
    id, name: `路径${id}`, edgeType: 'LINE',
    sx: 0, sy: 0, ex: 0.5, ey: 0,
    cx: null, cy: null, dx: null, dy: null,
    isBackEdge, snodeId, enodeId,
  }
}

function bezierJson(id: string, snodeId: string, enodeId: string) {
  return {
    id, name: `曲线${id}`, edgeType: 'BEZIER',
    sx: 0, sy: 0, ex: 1, ey: 2,
    cx: 0, cy: 1, dx: 1, dy: 1,
    isBackEdge: false, snodeId, enodeId,
  }
}

/** 以合法小地图构造请求（requestId 固定 1） */
function buildRequest(payload: ArrayBuffer, options: SceneBuildOptions = OPTIONS) {
  return createMapBuildRequest(1, payload, options).message
}

const SMALL_MAP = makeEnvelope(
  [nodeJson('n1', 'node', 0, 0), nodeJson('n2', 'node', 3, 0)],
  [lineJson('e1', 'n1', 'n2')],
)

describe('runMapBuild 成功路径（§3.1、§5.1）', () => {
  it('小地图：success 结果、requestId 回显、stats 正确、transfer 列表 13 个 buffer', () => {
    const { message, transfer } = runMapBuild(buildRequest(encode(SMALL_MAP)))

    expect(message.type).toBe('success')
    const success = message as MapBuildSuccessResult
    expect(success.requestId).toBe(1)
    expect(success.model.stats).toEqual({
      nodeCount: 2,
      edgeCount: 1,
      arrowCount: 0,
      labelMetadataCount: 3,
    })
    expect(transfer).toHaveLength(13)
    expect(transfer).toContain(success.model.paths.forward.positions.buffer)
    expect(transfer).toContain(success.model.nodes.directions.colors.buffer)
  })

  it('空图（nodes/edges 同时为空）：合法空态模型，stats 全零', () => {
    const { message } = runMapBuild(buildRequest(encode(makeEnvelope([], []))))
    expect(message.type).toBe('success')
    const model = (message as MapBuildSuccessResult).model
    expect(model.stats).toEqual({ nodeCount: 0, edgeCount: 0, arrowCount: 0, labelMetadataCount: 0 })
    expect(model.bounds.innerMaxX - model.bounds.innerMinX).toBe(60)
    expect(model.bounds.innerMaxZ - model.bounds.innerMinZ).toBe(40)
  })

  it('基准 public/map.json 全量：1767 节点 / 3043 边（§3.4），13 个 buffer 全部 transfer', () => {
    const url = new URL('../../../../../public/map.json', import.meta.url)
    const raw = readFileSync(url)
    const payload = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer

    const { message, transfer } = runMapBuild(buildRequest(payload))

    expect(message.type).toBe('success')
    const model = (message as MapBuildSuccessResult).model
    expect(model.stats.nodeCount).toBe(1767)
    expect(model.stats.edgeCount).toBe(3043)
    expect(model.stats.labelMetadataCount).toBe(4810)
    expect(transfer).toHaveLength(13)
  })
})

describe('runMapBuild 错误映射（§11：稳定错误码，不产生部分 SceneModel）', () => {
  function expectError(request: unknown, name: string, code: string) {
    const { message, transfer } = runMapBuild(request)
    expect(message.type).toBe('error')
    const error = (message as MapBuildErrorResult).error
    expect(error.name).toBe(name)
    expect(error.code).toBe(code)
    expect(transfer).toEqual([])
    return error
  }

  it('非法 UTF-8 → MapParseError（MAP_INVALID_UTF8）', () => {
    const payload = new Uint8Array([0xff, 0xfe, 0x41, 0x80]).buffer as ArrayBuffer
    expectError(buildRequest(payload), 'MapParseError', 'MAP_INVALID_UTF8')
  })

  it('JSON 语法错误 → MapParseError（MAP_JSON_SYNTAX）', () => {
    expectError(buildRequest(encode('{ not json')), 'MapParseError', 'MAP_JSON_SYNTAX')
  })

  it('空 payload → JSON 语法错误（fatal 解码本身成功）', () => {
    expectError(buildRequest(new ArrayBuffer(0)), 'MapParseError', 'MAP_JSON_SYNTAX')
  })

  it('信封 code 非 200 → MapEnvelopeError（MAP_ENVELOPE_CODE_INVALID，fieldPath=code）', () => {
    const error = expectError(
      buildRequest(encode(JSON.stringify({ code: 500, message: 'err', data: null }))),
      'MapEnvelopeError',
      'MAP_ENVELOPE_CODE_INVALID',
    )
    expect(error.fieldPath).toBe('code')
  })

  it('§3.3 字段非法 → MapValidationError（首个错误路径 + totalCount）', () => {
    const payload = makeEnvelope(
      [nodeJson('n1', 'robot', 0, 0), nodeJson('n2', 'node', 1, 0)],
      [],
    )
    const error = expectError(buildRequest(encode(payload)), 'MapValidationError', 'MAP_NODE_TYPE_INVALID')
    expect(error.fieldPath).toBe('nodes[0].type')
    expect(error.totalCount).toBe(1)
  })

  it('元素总数超 20000 → MapCapacityError（actual/limit 保真）', () => {
    const nodes = Array.from({ length: 20001 }, (_, i) => nodeJson(`n${i}`, 'node', 0, 0))
    const error = expectError(
      buildRequest(encode(makeEnvelope(nodes, []))),
      'MapCapacityError',
      'MAP_ELEMENTS_EXCEEDED',
    )
    expect(error.actual).toBe(20001)
    expect(error.limit).toBe(20000)
  })

  it('贝塞尔细分触底 → MapGeometryError（curveMaxError=0 对真实曲线永不满足）', () => {
    const payload = makeEnvelope(
      [nodeJson('n1', 'node', 0, 0), nodeJson('n2', 'node', 1, 2)],
      [bezierJson('sharp', 'n1', 'n2')],
    )
    const strict: SceneBuildOptions = { ...OPTIONS, path: { ...OPTIONS.path, curveMaxError: 0 } }
    expectError(buildRequest(encode(payload), strict), 'MapGeometryError', 'MAP_GEOMETRY_CURVE_TOO_COMPLEX')
  })

  it('未捕获异常 → SceneBuildError（MAP_WORKER_UNEXPECTED）', () => {
    // options.nodes 缺 stationColors：构建站点颜色时抛 TypeError（非领域错误）
    const payload = makeEnvelope([nodeJson('w1', 'work', 0, 0)], [])
    const broken = { ...OPTIONS, nodes: {} } as unknown as SceneBuildOptions
    expectError(buildRequest(encode(payload), broken), 'SceneBuildError', 'MAP_WORKER_UNEXPECTED')
  })

  it('请求非对象 → SceneBuildError（MAP_WORKER_PROTOCOL_INVALID），requestId 占位 -1', () => {
    const { message } = runMapBuild(null)
    expect(message.type).toBe('error')
    expect(message.requestId).toBe(UNREADABLE_REQUEST_ID)
    expect((message as MapBuildErrorResult).error.code).toBe('MAP_WORKER_PROTOCOL_INVALID')
  })

  it('requestId 不可读（非数值）→ 结果 requestId 占位 -1', () => {
    const { message } = runMapBuild({ type: 'build', requestId: 'x', payload: new ArrayBuffer(0), options: OPTIONS })
    expect(message.requestId).toBe(UNREADABLE_REQUEST_ID)
  })

  it('requestId 非有限 → 结果 requestId 占位 -1', () => {
    const { message } = runMapBuild({ type: 'build', requestId: Number.NaN, payload: new ArrayBuffer(0), options: OPTIONS })
    expect(message.requestId).toBe(UNREADABLE_REQUEST_ID)
  })

  it('type 非 "build" → 协议错误，requestId 正常回显', () => {
    const { message } = runMapBuild({ type: 'ping', requestId: 5, payload: new ArrayBuffer(0), options: OPTIONS })
    expect(message.requestId).toBe(5)
    expect((message as MapBuildErrorResult).error.code).toBe('MAP_WORKER_PROTOCOL_INVALID')
  })

  it('payload 非 ArrayBuffer → 协议错误', () => {
    const { message } = runMapBuild({ type: 'build', requestId: 5, payload: 'bytes', options: OPTIONS })
    expect((message as MapBuildErrorResult).error.code).toBe('MAP_WORKER_PROTOCOL_INVALID')
  })

  it('options 缺失 → 协议错误', () => {
    const { message } = runMapBuild({ type: 'build', requestId: 5, payload: new ArrayBuffer(0) })
    expect((message as MapBuildErrorResult).error.code).toBe('MAP_WORKER_PROTOCOL_INVALID')
  })
})
