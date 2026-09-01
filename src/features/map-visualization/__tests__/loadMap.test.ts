/*
 * 地图资源读取测试（与实现共置）。
 *
 * 职责：覆盖 loadMap 加载链路的全部稳定错误码与注入点行为：URL 解析、
 *       网络/HTTP/JSON 失败、根结构致命错误、取消透传、子路径基准解析，
 *       以及仿射参数向世界变换的正确传递。
 * 关键不变量（SPEC §10.1～§10.2、§11.10）：
 * 1. mapUrl 以注入 baseUrl（默认 document.baseURI）解析，同一相对地址在
 *    根路径与子路径部署下语义一致；
 * 2. 取消（AbortError）原样上抛，不包装为地图错误；
 * 3. 逐项异常随结果返回，不因 warn 级异常失败。
 */
import { describe, expect, it } from 'vitest'
import { loadMap } from '@/features/map-visualization/services/loadMap'
import { isAbortError, StructuredError } from '@/shared/diagnostics'
import { makeLineEdge, makeNode } from './fixtures'

const TINY_MAP = {
  nodes: [
    makeNode({ id: 'a', x: 0, y: 0 }),
    makeNode({ id: 'b', x: 4, y: 0 }),
  ],
  edges: [makeLineEdge({ sx: 0, sy: 0, ex: 4, ey: 0 })],
  zones: [],
  nodeEdgeGroups: [],
}

function fetchJson(body: unknown, status = 200): typeof fetch {
  return async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
}

describe('loadMap', () => {
  it('成功加载并建模：返回 MapModel、世界变换、实际 URL 与空异常列表', async () => {
    const result = await loadMap({
      mapUrl: './json/map.json',
      baseUrl: 'http://localhost:5173/',
      fetchImpl: fetchJson(TINY_MAP),
    })
    expect(result.url).toBe('http://localhost:5173/json/map.json')
    expect(result.mapModel.nodes.size).toBe(2)
    expect(result.mapModel.edgeList[0].length).toBe(4)
    expect(result.anomalies).toHaveLength(0)
    expect(result.worldTransform.origin).toEqual({ x: 2, y: 0 })
  })

  it('子路径部署：mapUrl 相对 baseUrl 解析，同一配置读取子路径资源', async () => {
    const result = await loadMap({
      mapUrl: './json/map.json',
      baseUrl: 'https://example.com/monitor/',
      fetchImpl: fetchJson(TINY_MAP),
    })
    expect(result.url).toBe('https://example.com/monitor/json/map.json')
  })

  it('mapUrl 无法解析时抛出 MAP_URL_INVALID', async () => {
    await expect(
      loadMap({ mapUrl: 'http://exam ple.com', baseUrl: 'http://localhost:5173/', fetchImpl: fetchJson(TINY_MAP) }),
    ).rejects.toMatchObject({ code: 'MAP_URL_INVALID' })
  })

  it('HTTP 非 2xx 抛出 MAP_HTTP_STATUS；网络异常抛出 MAP_FETCH_FAILED', async () => {
    await expect(
      loadMap({ mapUrl: './json/map.json', baseUrl: 'http://localhost:5173/', fetchImpl: fetchJson('nope', 500) }),
    ).rejects.toMatchObject({ code: 'MAP_HTTP_STATUS', context: { status: 500 } })

    const networkFail: typeof fetch = async () => {
      throw new TypeError('offline')
    }
    await expect(
      loadMap({ mapUrl: './json/map.json', baseUrl: 'http://localhost:5173/', fetchImpl: networkFail }),
    ).rejects.toMatchObject({ code: 'MAP_FETCH_FAILED' })
  })

  it('非法 JSON 抛出 MAP_JSON_PARSE；根结构致命错误抛出 MAP_ROOT_INVALID', async () => {
    await expect(
      loadMap({ mapUrl: './json/map.json', baseUrl: 'http://localhost:5173/', fetchImpl: fetchJson('{oops') }),
    ).rejects.toMatchObject({ code: 'MAP_JSON_PARSE' })

    await expect(
      loadMap({ mapUrl: './json/map.json', baseUrl: 'http://localhost:5173/', fetchImpl: fetchJson([1, 2, 3]) }),
    ).rejects.toMatchObject({ code: 'MAP_ROOT_INVALID' })
  })

  it('取消透传：fetch 抛出 AbortError 时不包装为地图错误', async () => {
    // 桩必须处理「信号已中止」的竞态：aborted 为真时立即拒绝
    const aborting: typeof fetch = (_input, init) => {
      if (init?.signal?.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'))
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    }
    const controller = new AbortController()
    controller.abort()
    await expect(
      loadMap({
        mapUrl: './json/map.json',
        baseUrl: 'http://localhost:5173/',
        fetchImpl: aborting,
        signal: controller.signal,
      }),
    ).rejects.toSatisfy(isAbortError)
  })

  it('逐项异常随结果返回：未知类型不阻断加载', async () => {
    const result = await loadMap({
      mapUrl: './json/map.json',
      baseUrl: 'http://localhost:5173/',
      fetchImpl: fetchJson({
        nodes: [makeNode({ id: 'a', type: 'mystery' }), makeNode({ id: 'b', x: 4, y: 0 })],
        edges: [],
      }),
    })
    expect(result.mapModel.nodes.size).toBe(2)
    expect(result.anomalies.map((anomaly) => anomaly.code)).toEqual(['MAP_NODE_UNKNOWN_TYPE'])
    expect(result.anomalies[0]).toBeInstanceOf(Object)
    expect(Object.isFrozen(result.anomalies[0])).toBe(true)
  })

  it('coordinateTransform 传递给世界变换：原点为变换后的包围盒中心', async () => {
    const result = await loadMap({
      mapUrl: './json/map.json',
      baseUrl: 'http://localhost:5173/',
      fetchImpl: fetchJson(TINY_MAP),
      coordinateTransform: { scale: 2, rotation: 0, mirrorY: false, translateX: 5, translateY: 7 },
    })
    // 中心 (2,0) → 缩放 (4,0) → 平移 (9,7)
    expect(result.worldTransform.origin).toEqual({ x: 9, y: 7 })
  })

  it('错误对象为携带稳定错误码的 StructuredError（可供调用方按码分支）', async () => {
    const error = await loadMap({
      mapUrl: './json/map.json',
      baseUrl: 'http://localhost:5173/',
      fetchImpl: fetchJson('nope', 404),
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(StructuredError)
    expect((error as StructuredError).code).toBe('MAP_HTTP_STATUS')
  })
})
