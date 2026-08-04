/**
 * errorViewModel 单元测试（SPEC §11 错误矩阵逐行）。
 * 纯函数、无 DOM；断言九类错误的标题/错误码/摘要/明细行/动作按钮，
 * 以及可选字段缺省时明细行省略。
 */

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
} from '../domain/errors'
import { buildFactoryMapErrorViewModel } from './errorViewModel'

describe('§11 错误矩阵 → 视图模型', () => {
  it('MapNetworkError：错误码 + 摘要 +「重新加载」，无明细行', () => {
    const view = buildFactoryMapErrorViewModel(
      new MapNetworkError('MAP_REQUEST_TIMEOUT', '地图请求超时：15000 毫秒内未完成响应读取'),
    )
    expect(view).toEqual({
      title: '网络请求失败',
      code: 'MAP_REQUEST_TIMEOUT',
      summary: '地图请求超时：15000 毫秒内未完成响应读取',
      details: [],
      action: { kind: 'retry', label: '重新加载' },
    })
  })

  it('MapHttpError：摘要含 HTTP 状态，请求地址为移除 query/hash 的 URL', () => {
    const view = buildFactoryMapErrorViewModel(
      new MapHttpError('MAP_HTTP_NON_2XX', '地图请求失败：HTTP 404（/map.json）', {
        fieldPath: '/map.json',
      }),
    )
    expect(view.title).toBe('服务器响应错误')
    expect(view.summary).toContain('HTTP 404')
    expect(view.details).toEqual([{ label: '请求地址', value: '/map.json' }])
    expect(view.action).toEqual({ kind: 'retry', label: '重新加载' })
  })

  it('MapParseError：展示解析错误码，无明细行（不展示原始响应内容）', () => {
    const view = buildFactoryMapErrorViewModel(
      new MapParseError('MAP_JSON_SYNTAX', '地图数据不是合法的 JSON 文本'),
    )
    expect(view.title).toBe('地图数据解析失败')
    expect(view.code).toBe('MAP_JSON_SYNTAX')
    expect(view.details).toEqual([])
    expect(view.action.kind).toBe('retry')
  })

  it('MapEnvelopeError：错误码 + 字段路径', () => {
    const view = buildFactoryMapErrorViewModel(
      new MapEnvelopeError('MAP_ENVELOPE_CODE_INVALID', '信封 code 必须严格等于 200', {
        fieldPath: 'code',
      }),
    )
    expect(view.title).toBe('地图数据信封错误')
    expect(view.code).toBe('MAP_ENVELOPE_CODE_INVALID')
    expect(view.details).toEqual([{ label: '字段路径', value: 'code' }])
  })

  it('MapValidationError：首个错误路径 + 摘要 + 错误总数', () => {
    const view = buildFactoryMapErrorViewModel(
      new MapValidationError('MAP_NODE_TYPE_INVALID', '节点类型必须是 node/work/park/charge 之一', {
        fieldPath: 'nodes[17].type',
        totalCount: 6,
      }),
    )
    expect(view.title).toBe('地图数据校验失败')
    expect(view.details).toEqual([
      { label: '首个错误路径', value: 'nodes[17].type' },
      { label: '错误总数', value: '6' },
    ])
  })

  it('MapCapacityError：展示实际值与上限', () => {
    const view = buildFactoryMapErrorViewModel(
      new MapCapacityError('MAP_BYTES_EXCEEDED', '地图数据超过大小上限', {
        actual: 21_000_000,
        limit: 20_971_520,
      }),
    )
    expect(view.title).toBe('地图数据超出容量上限')
    expect(view.details).toEqual([
      { label: '实际值', value: '21000000' },
      { label: '上限', value: '20971520' },
    ])
  })

  it('MapGeometryError：边 id（fieldPath）+ 错误原因（摘要）', () => {
    const view = buildFactoryMapErrorViewModel(
      new MapGeometryError('MAP_GEOMETRY_POLYLINE_DEGENERATE', '路径 "edge-9" 采样去重后不足 2 个点，无法构建条带', {
        fieldPath: 'edges[].id=edge-9',
      }),
    )
    expect(view.title).toBe('地图几何构建失败')
    expect(view.summary).toContain('edge-9')
    expect(view.details).toEqual([{ label: '出错路径', value: 'edges[].id=edge-9' }])
  })

  it('SceneBuildError：提示不自动重试，动作为「重新加载」', () => {
    const view = buildFactoryMapErrorViewModel(
      new SceneBuildError('MAP_WORKER_CRASHED', '场景构建 Worker 崩溃'),
    )
    expect(view.title).toBe('三维场景构建失败')
    expect(view.details).toHaveLength(1)
    expect(view.details[0].label).toBe('提示')
    expect(view.details[0].value).toContain('不会自动重试')
    expect(view.details[0].value).toContain('重新加载')
    expect(view.action).toEqual({ kind: 'retry', label: '重新加载' })
  })

  it('WebGLUnavailableError：硬件/浏览器不支持提示，动作为「刷新页面」', () => {
    const view = buildFactoryMapErrorViewModel(
      new WebGLUnavailableError('WEBGL_CONTEXT_LOST', 'WebGL 渲染上下文已丢失，请刷新页面'),
    )
    expect(view.title).toBe('无法初始化三维渲染')
    expect(view.details[0].value).toContain('不支持 WebGL2')
    expect(view.action).toEqual({ kind: 'reloadPage', label: '刷新页面' })
  })

  it('可选字段缺省时对应明细行省略', () => {
    const http = buildFactoryMapErrorViewModel(new MapHttpError('MAP_HTTP_NON_2XX', '地图请求失败：HTTP 500'))
    expect(http.details).toEqual([])

    const capacity = buildFactoryMapErrorViewModel(
      new MapCapacityError('MAP_ELEMENTS_EXCEEDED', '元素总数超限'),
    )
    expect(capacity.details).toEqual([])

    const envelope = buildFactoryMapErrorViewModel(
      new MapEnvelopeError('MAP_ENVELOPE_MISSING', '信封缺失'),
    )
    expect(envelope.details).toEqual([])
  })

  it('九类之外的 FactoryMapError：错误码 + 摘要 +「重新加载」', () => {
    const view = buildFactoryMapErrorViewModel(
      new FactoryMapError('FactoryMapError', 'MAP_UNKNOWN', '未知错误'),
    )
    expect(view).toEqual({
      title: '地图加载失败',
      code: 'MAP_UNKNOWN',
      summary: '未知错误',
      details: [],
      action: { kind: 'retry', label: '重新加载' },
    })
  })
})
