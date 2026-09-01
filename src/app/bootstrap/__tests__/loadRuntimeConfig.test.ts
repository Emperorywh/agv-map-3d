/*
 * 运行时配置读取与严格校验测试（与实现共置）。
 *
 * 职责：覆盖 TASK-002 验证要求的「合法/非法/取消/网络/JSON/HTTPS-WS」全部
 *       配置路径；字段级非法用例直接走纯函数 validateRuntimeConfig。
 * 关键不变量（SPEC §10.1）：
 * 1. 配置 URL 以 baseUrl（document.baseURI）解析，支持根路径与子路径；
 * 2. 严格白名单：未知字段（含疑似凭据字段）一律 CONFIG_UNKNOWN_FIELD；
 * 3. dataSource=ws 必须提供 wsUrl；HTTPS 页面禁止明文 ws:，允许 wss: 与
 *    同源 https 代理；
 * 4. 网络 / HTTP / JSON / 字段失败分别抛出稳定错误码；取消原样抛出 AbortError；
 * 5. 通过校验的配置深度冻结。
 */
import { describe, expect, it } from 'vitest'
import { StructuredError, isAbortError } from '@/shared/diagnostics'
import {
  loadRuntimeConfig,
  validateRuntimeConfig,
  type RuntimeConfig,
} from '@/app/bootstrap/loadRuntimeConfig'

const HTTP_BASE = 'http://localhost:5173/'
const HTTPS_BASE = 'https://example.com/agv/'

/** 合法配置样本（与 public/config.json 同构） */
const VALID_CONFIG = {
  dataSource: 'mock',
  mapUrl: './json/map.json',
  wsUrl: null,
  maxVehicles: 256,
  staleAfterMs: 10000,
  renderer: { maxDpr: 1.5, shadowMapSize: 2048 },
  coordinateTransform: { scale: 1, rotation: 0, mirrorY: false, translateX: 0, translateY: 0 },
}

function structErrorOf(error: unknown): StructuredError {
  expect(error).toBeInstanceOf(StructuredError)
  return error as StructuredError
}

function expectFieldError(run: () => unknown, field: string): void {
  try {
    run()
    expect.unreachable('应当抛出 StructuredError')
  } catch (error) {
    const structured = structErrorOf(error)
    expect(structured.code).toBe('CONFIG_FIELD')
    expect(structured.context).toMatchObject({ field })
  }
}

function fetchOk(body: string): typeof fetch {
  return async () => new Response(body, { status: 200 })
}

describe('validateRuntimeConfig（纯校验）', () => {
  it('合法配置全部字段通过且深度冻结', () => {
    const config = validateRuntimeConfig(
      structuredClone(VALID_CONFIG),
      HTTP_BASE,
    ) as RuntimeConfig
    expect(config).toEqual(VALID_CONFIG)
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.renderer)).toBe(true)
    expect(Object.isFrozen(config.coordinateTransform)).toBe(true)
  })

  it('根不是对象时拒绝', () => {
    expectFieldError(() => validateRuntimeConfig([], HTTP_BASE), '(root)')
    expectFieldError(() => validateRuntimeConfig('x', HTTP_BASE), '(root)')
    expectFieldError(() => validateRuntimeConfig(null, HTTP_BASE), '(root)')
  })

  it('未知顶层字段拒绝（含疑似凭据字段，凭据无法借配置进入前端）', () => {
    for (const key of ['authToken', 'password', 'extra']) {
      try {
        validateRuntimeConfig({ ...VALID_CONFIG, [key]: 'x' }, HTTP_BASE)
        expect.unreachable('应当拒绝未知字段')
      } catch (error) {
        const structured = structErrorOf(error)
        expect(structured.code).toBe('CONFIG_UNKNOWN_FIELD')
        expect(structured.context).toMatchObject({ field: key })
      }
    }
  })

  it('dataSource 只接受 mock | ws', () => {
    expectFieldError(() => validateRuntimeConfig({ ...VALID_CONFIG, dataSource: 'polling' }, HTTP_BASE), 'dataSource')
    expectFieldError(() => validateRuntimeConfig({ ...VALID_CONFIG, dataSource: 1 }, HTTP_BASE), 'dataSource')
    expectFieldError(() => validateRuntimeConfig({ ...VALID_CONFIG, dataSource: undefined }, HTTP_BASE), 'dataSource')
  })

  it('mapUrl 必须为可解析的相对或 http(s) URL', () => {
    expectFieldError(() => validateRuntimeConfig({ ...VALID_CONFIG, mapUrl: '' }, HTTP_BASE), 'mapUrl')
    expectFieldError(() => validateRuntimeConfig({ ...VALID_CONFIG, mapUrl: 'ftp://host/m.json' }, HTTP_BASE), 'mapUrl')
    expectFieldError(() => validateRuntimeConfig({ ...VALID_CONFIG, mapUrl: 42 }, HTTP_BASE), 'mapUrl')
    // 合法：相对与绝对 https
    expect(validateRuntimeConfig({ ...VALID_CONFIG, mapUrl: 'maps/v2.json' }, HTTP_BASE).mapUrl).toBe('maps/v2.json')
    expect(validateRuntimeConfig({ ...VALID_CONFIG, mapUrl: 'https://cdn.example.com/m.json' }, HTTP_BASE).mapUrl).toBe(
      'https://cdn.example.com/m.json',
    )
  })

  it('maxVehicles 只接受 ≥1 的整数', () => {
    for (const bad of [0, -5, 1.5, '10', Number.NaN, null]) {
      expectFieldError(() => validateRuntimeConfig({ ...VALID_CONFIG, maxVehicles: bad }, HTTP_BASE), 'maxVehicles')
    }
  })

  it('staleAfterMs 必须为正有限数值', () => {
    for (const bad of [0, -1, 'x', Number.POSITIVE_INFINITY]) {
      expectFieldError(() => validateRuntimeConfig({ ...VALID_CONFIG, staleAfterMs: bad }, HTTP_BASE), 'staleAfterMs')
    }
  })

  it('renderer 严格校验（含嵌套未知字段）', () => {
    expectFieldError(() => validateRuntimeConfig({ ...VALID_CONFIG, renderer: null }, HTTP_BASE), 'renderer')
    expectFieldError(() => validateRuntimeConfig({ ...VALID_CONFIG, renderer: {} }, HTTP_BASE), 'renderer.maxDpr')
    expectFieldError(() => validateRuntimeConfig({ ...VALID_CONFIG, renderer: { maxDpr: 0, shadowMapSize: 2048 } }, HTTP_BASE), 'renderer.maxDpr')
    expectFieldError(() => validateRuntimeConfig({ ...VALID_CONFIG, renderer: { maxDpr: 1, shadowMapSize: 2.5 } }, HTTP_BASE), 'renderer.shadowMapSize')
    try {
      validateRuntimeConfig({ ...VALID_CONFIG, renderer: { maxDpr: 1, shadowMapSize: 2048, turbo: true } }, HTTP_BASE)
      expect.unreachable('应当拒绝未知字段')
    } catch (error) {
      expect(structErrorOf(error).context).toMatchObject({ field: 'renderer.turbo' })
      expect(structErrorOf(error).code).toBe('CONFIG_UNKNOWN_FIELD')
    }
  })

  it('coordinateTransform 严格校验五个字段与类型', () => {
    expectFieldError(
      () => validateRuntimeConfig({ ...VALID_CONFIG, coordinateTransform: undefined }, HTTP_BASE),
      'coordinateTransform',
    )
    expectFieldError(
      () => validateRuntimeConfig({ ...VALID_CONFIG, coordinateTransform: { ...VALID_CONFIG.coordinateTransform, scale: 0 } }, HTTP_BASE),
      'coordinateTransform.scale',
    )
    expectFieldError(
      () => validateRuntimeConfig({ ...VALID_CONFIG, coordinateTransform: { ...VALID_CONFIG.coordinateTransform, mirrorY: 'yes' } }, HTTP_BASE),
      'coordinateTransform.mirrorY',
    )
    expectFieldError(
      () => validateRuntimeConfig({ ...VALID_CONFIG, coordinateTransform: { ...VALID_CONFIG.coordinateTransform, translateX: Number.NaN } }, HTTP_BASE),
      'coordinateTransform.translateX',
    )
    try {
      validateRuntimeConfig(
        { ...VALID_CONFIG, coordinateTransform: { ...VALID_CONFIG.coordinateTransform, skew: 1 } },
        HTTP_BASE,
      )
      expect.unreachable('应当拒绝未知字段')
    } catch (error) {
      expect(structErrorOf(error).code).toBe('CONFIG_UNKNOWN_FIELD')
      expect(structErrorOf(error).context).toMatchObject({ field: 'coordinateTransform.skew' })
    }
  })

  describe('wsUrl 策略', () => {
    it('dataSource=ws 且 wsUrl=null → CONFIG_WS_REQUIRED', () => {
      try {
        validateRuntimeConfig({ ...VALID_CONFIG, dataSource: 'ws', wsUrl: null }, HTTPS_BASE)
        expect.unreachable('应当抛出 CONFIG_WS_REQUIRED')
      } catch (error) {
        expect(structErrorOf(error).code).toBe('CONFIG_WS_REQUIRED')
      }
    })

    it('HTTPS 页面禁止明文 ws: 与跨源 http(s) 代理，允许 wss: 与同源 https 代理', () => {
      // 明文 ws:
      try {
        validateRuntimeConfig({ ...VALID_CONFIG, dataSource: 'ws', wsUrl: 'ws://backend:8080/ws' }, HTTPS_BASE)
        expect.unreachable('应当抛出 CONFIG_WS_INSECURE')
      } catch (error) {
        expect(structErrorOf(error).code).toBe('CONFIG_WS_INSECURE')
      }
      // 跨源 http 绝对地址
      expectFieldError(
        () => validateRuntimeConfig({ ...VALID_CONFIG, dataSource: 'ws', wsUrl: 'http://other/api/ws' }, HTTPS_BASE),
        'wsUrl',
      )
      // 合法：wss 与同源 https 代理（相对路径）
      expect(
        validateRuntimeConfig({ ...VALID_CONFIG, dataSource: 'ws', wsUrl: 'wss://backend.example.com/ws' }, HTTPS_BASE).wsUrl,
      ).toBe('wss://backend.example.com/ws')
      expect(validateRuntimeConfig({ ...VALID_CONFIG, dataSource: 'ws', wsUrl: '/same-origin/ws' }, HTTPS_BASE).wsUrl).toBe(
        '/same-origin/ws',
      )
    })

    it('HTTP 页面允许 ws://，非 ws/wss 绝对地址拒绝', () => {
      expect(
        validateRuntimeConfig({ ...VALID_CONFIG, dataSource: 'ws', wsUrl: 'ws://localhost:9000' }, HTTP_BASE).wsUrl,
      ).toBe('ws://localhost:9000')
      expectFieldError(
        () => validateRuntimeConfig({ ...VALID_CONFIG, dataSource: 'ws', wsUrl: 'http://localhost:9000' }, HTTP_BASE),
        'wsUrl',
      )
    })
  })
})

describe('loadRuntimeConfig（读取链路）', () => {
  it('合法配置从子路径 baseUrl 读取成功并返回实际配置 URL', async () => {
    const baseUrl = 'https://example.com/agv/monitor/'
    const result = await loadRuntimeConfig({
      baseUrl,
      fetchImpl: fetchOk(JSON.stringify(VALID_CONFIG)),
    })
    expect(result.config).toEqual(VALID_CONFIG)
    expect(result.href).toBe('https://example.com/agv/monitor/config.json')
  })

  it('网络失败 → CONFIG_FETCH_FAILED 且携带 configUrl 上下文', async () => {
    const failing: typeof fetch = async () => {
      throw new TypeError('fetch failed: network down')
    }
    try {
      await loadRuntimeConfig({ baseUrl: HTTP_BASE, fetchImpl: failing })
      expect.unreachable('应当抛出 CONFIG_FETCH_FAILED')
    } catch (error) {
      const structured = structErrorOf(error)
      expect(structured.code).toBe('CONFIG_FETCH_FAILED')
      expect(structured.context).toMatchObject({ configUrl: `${HTTP_BASE}config.json` })
    }
  })

  it('HTTP 非 2xx → CONFIG_HTTP_STATUS 并携带状态码', async () => {
    const notFound: typeof fetch = async () => new Response('nope', { status: 404 })
    try {
      await loadRuntimeConfig({ baseUrl: HTTP_BASE, fetchImpl: notFound })
      expect.unreachable('应当抛出 CONFIG_HTTP_STATUS')
    } catch (error) {
      const structured = structErrorOf(error)
      expect(structured.code).toBe('CONFIG_HTTP_STATUS')
      expect(structured.context).toMatchObject({ status: 404 })
    }
  })

  it('非法 JSON → CONFIG_JSON_PARSE', async () => {
    try {
      await loadRuntimeConfig({ baseUrl: HTTP_BASE, fetchImpl: fetchOk('{ not-json') })
      expect.unreachable('应当抛出 CONFIG_JSON_PARSE')
    } catch (error) {
      expect(structErrorOf(error).code).toBe('CONFIG_JSON_PARSE')
    }
  })

  it('取消以 AbortError 原样抛出，不包装为配置错误', async () => {
    const controller = new AbortController()
    const hanging: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    const pending = loadRuntimeConfig({ baseUrl: HTTP_BASE, fetchImpl: hanging, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toSatisfy(isAbortError)
  })
})
