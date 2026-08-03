import { afterEach, describe, expect, it, vi } from 'vitest'

import { MapCapacityError, MapHttpError, MapNetworkError } from '../domain/errors'
import { MAX_MAP_BYTES } from '../domain/limits'
import {
  DEFAULT_MAP_URL,
  createHttpMapRepository,
  resolveDefaultMapUrl,
  resolveMapUrl,
} from './HttpMapRepository'

// ---------------------------------------------------------------------------
// 测试夹具（全部 mock fetch/stream，不依赖真实网络与系统时间，§15.1）
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 15_000
const TEST_URL = '/map.json'

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

function mockFetch(impl: FetchImpl) {
  const fetchMock = vi.fn(impl)
  return { fetchImpl: fetchMock as unknown as typeof fetch, fetchMock }
}

function bytes(length: number, fill = 1): Uint8Array<ArrayBuffer> {
  return new Uint8Array(length).fill(fill)
}

/** 构造一次性 enqueue 全部分块的 ReadableStream（可附 cancel 间谍等 source 行为） */
function streamOf(chunks: ReadonlyArray<Uint8Array<ArrayBuffer>>, source: Partial<UnderlyingSource<Uint8Array>> = {}) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
    ...source,
  })
}

function responseOf(chunks: ReadonlyArray<Uint8Array<ArrayBuffer>>, init?: ResponseInit): Response {
  return new Response(streamOf(chunks), init)
}

interface FakeResponseInit {
  readonly status?: number
  readonly headers?: Record<string, string>
  readonly body: ReadableStream<Uint8Array> | null
}

/**
 * 手工 Response 替身：body 原样持有传入流（undici 会包装/预读 Response 的 body，
 * 需要精确观测 cancel 语义时使用）。
 */
function fakeResponse(init: FakeResponseInit): Response {
  const status = init.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(init.headers),
    body: init.body,
  } as unknown as Response
}

/** 立即挂接 rejection 处理器（避免未处理拒绝），返回捕获到的错误 */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('预期 reject，实际 resolve')
}

function expectAbortError(error: unknown): void {
  expect(error).toBeInstanceOf(DOMException)
  expect((error as DOMException).name).toBe('AbortError')
}

/** 宏任务冲刷：排空全部挂起的微任务链（非定时等待） */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// URL 解析（§3.1：默认 /map.json，VITE_MAP_URL 覆盖同契约 URL）
// ---------------------------------------------------------------------------

describe('resolveMapUrl / resolveDefaultMapUrl（§3.1）', () => {
  it('默认 URL 为 /map.json；envUrl 缺省/空串/null 均回落默认', () => {
    expect(DEFAULT_MAP_URL).toBe('/map.json')
    expect(resolveMapUrl(undefined)).toBe('/map.json')
    expect(resolveMapUrl('')).toBe('/map.json')
    expect(resolveMapUrl(null)).toBe('/map.json')
  })

  it('envUrl 为非空字符串时覆盖默认 URL（同契约，原样透传）', () => {
    expect(resolveMapUrl('/other/map.json')).toBe('/other/map.json')
    expect(resolveMapUrl('https://maps.example.com/factory.json')).toBe(
      'https://maps.example.com/factory.json',
    )
  })

  it('resolveDefaultMapUrl 读取 import.meta.env.VITE_MAP_URL', () => {
    expect(resolveDefaultMapUrl()).toBe('/map.json')
    vi.stubEnv('VITE_MAP_URL', '/custom/factory-map.json')
    expect(resolveDefaultMapUrl()).toBe('/custom/factory-map.json')
  })
})

// ---------------------------------------------------------------------------
// 成功路径：字节完整的 ArrayBuffer，不解析 body 内容
// ---------------------------------------------------------------------------

describe('fetchPayload 成功路径（§3.1、§15.1 合法 ArrayBuffer transfer）', () => {
  it('多个流式分块拼接为字节完整的 ArrayBuffer，原样透传不解析内容', async () => {
    const { fetchImpl, fetchMock } = mockFetch(() =>
      Promise.resolve(responseOf([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])])),
    )
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const result = await repository.fetchPayload(TEST_URL, new AbortController().signal)

    expect(result).toBeInstanceOf(ArrayBuffer)
    expect(result.byteLength).toBe(5)
    // 内容不是合法 JSON 也原样返回：仓库不解析 body、不做信封判断
    expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(TEST_URL)
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('返回的 ArrayBuffer 可被 transfer（transfer 后原 buffer 分离）', async () => {
    const { fetchImpl } = mockFetch(() => Promise.resolve(responseOf([new Uint8Array([9, 8, 7])])))
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const result = await repository.fetchPayload(TEST_URL, new AbortController().signal)
    const transferred = structuredClone(result, { transfer: [result] })

    expect(result.byteLength).toBe(0)
    expect(new Uint8Array(transferred)).toEqual(new Uint8Array([9, 8, 7]))
  })

  it('缺省 fetchImpl 使用全局 fetch', async () => {
    const globalFetch = vi.fn(() => Promise.resolve(responseOf([new Uint8Array([1])])))
    vi.stubGlobal('fetch', globalFetch)
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS })

    const result = await repository.fetchPayload(TEST_URL, new AbortController().signal)

    expect(globalFetch).toHaveBeenCalledTimes(1)
    expect(new Uint8Array(result)).toEqual(new Uint8Array([1]))
  })

  it('2xx 无 body（null body）→ 空 ArrayBuffer，不视为错误', async () => {
    const { fetchImpl } = mockFetch(() => Promise.resolve(new Response(null, { status: 200 })))
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const result = await repository.fetchPayload(TEST_URL, new AbortController().signal)

    expect(result).toBeInstanceOf(ArrayBuffer)
    expect(result.byteLength).toBe(0)
  })

  it('Content-Length 非法数值时忽略声明，以流式累计为准', async () => {
    const { fetchImpl } = mockFetch(() =>
      Promise.resolve(responseOf([new Uint8Array([1, 2])], { headers: { 'content-length': 'abc' } })),
    )
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const result = await repository.fetchPayload(TEST_URL, new AbortController().signal)

    expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2]))
  })

  it('Content-Length 欠额声明不截断：以实际流式字节为准', async () => {
    const { fetchImpl } = mockFetch(() =>
      Promise.resolve(
        responseOf([new Uint8Array([1, 2, 3, 4, 5])], { headers: { 'content-length': '2' } }),
      ),
    )
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const result = await repository.fetchPayload(TEST_URL, new AbortController().signal)

    expect(result.byteLength).toBe(5)
  })

  it('边界：Content-Length 恰好等于 20MiB 不超限', async () => {
    const { fetchImpl } = mockFetch(() =>
      Promise.resolve(
        responseOf([new Uint8Array([7])], { headers: { 'content-length': String(MAX_MAP_BYTES) } }),
      ),
    )
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const result = await repository.fetchPayload(TEST_URL, new AbortController().signal)

    expect(new Uint8Array(result)).toEqual(new Uint8Array([7]))
  })

  it('边界：流式累计恰好等于 20MiB 不超限', async () => {
    const { fetchImpl } = mockFetch(() =>
      Promise.resolve(responseOf([bytes(MAX_MAP_BYTES - 1, 2), bytes(1, 3)])),
    )
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const result = await repository.fetchPayload(TEST_URL, new AbortController().signal)

    expect(result.byteLength).toBe(MAX_MAP_BYTES)
    expect(new Uint8Array(result)[0]).toBe(2)
    expect(new Uint8Array(result)[MAX_MAP_BYTES - 1]).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 容量上限（§3.1、§15.1：Content-Length 超限 / 流式累计超限 → MapCapacityError）
// ---------------------------------------------------------------------------

describe('fetchPayload 容量上限（§3.1 MAX_MAP_BYTES=20MiB）', () => {
  it('Content-Length 超限：不读任何字节，立即中止 body 并 reject MapCapacityError', async () => {
    const cancelSpy = vi.fn()
    const { fetchImpl, fetchMock } = mockFetch(() =>
      Promise.resolve(
        fakeResponse({
          headers: { 'content-length': String(MAX_MAP_BYTES + 1) },
          // 不 close：流保持 readable，body.cancel() 才会调用底层 source.cancel
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes(1))
            },
            cancel: cancelSpy,
          }),
        }),
      ),
    )
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const error = await captureRejection(repository.fetchPayload(TEST_URL, new AbortController().signal))

    expect(error).toBeInstanceOf(MapCapacityError)
    const capacity = error as MapCapacityError
    expect(capacity.code).toBe('MAP_BYTES_EXCEEDED')
    expect(capacity.actual).toBe(MAX_MAP_BYTES + 1)
    expect(capacity.limit).toBe(MAX_MAP_BYTES)
    expect(capacity.message).toContain(String(MAX_MAP_BYTES + 1))
    expect(capacity.message).toContain(String(MAX_MAP_BYTES))
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('Content-Length 超限且 body 为 null：仍 reject MapCapacityError', async () => {
    const { fetchImpl } = mockFetch(() =>
      Promise.resolve(
        new Response(null, {
          status: 200,
          headers: { 'content-length': String(MAX_MAP_BYTES * 2) },
        }),
      ),
    )
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const error = await captureRejection(repository.fetchPayload(TEST_URL, new AbortController().signal))

    expect(error).toBeInstanceOf(MapCapacityError)
    expect((error as MapCapacityError).actual).toBe(MAX_MAP_BYTES * 2)
  })

  it('流式累计超限：立即中止读取，不再消费后续分块，actual 为越界时实际累计值', async () => {
    const cancelSpy = vi.fn()
    // 第三个分块若被读取 total 会到 MAX+2；断言 actual=MAX+1 证明越界后立即停止
    const stream = streamOf([bytes(MAX_MAP_BYTES, 1), bytes(1, 2), bytes(1, 3)], { cancel: cancelSpy })
    const { fetchImpl } = mockFetch(() => Promise.resolve(new Response(stream)))
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const error = await captureRejection(repository.fetchPayload(TEST_URL, new AbortController().signal))

    expect(error).toBeInstanceOf(MapCapacityError)
    const capacity = error as MapCapacityError
    expect(capacity.code).toBe('MAP_BYTES_EXCEEDED')
    expect(capacity.actual).toBe(MAX_MAP_BYTES + 1)
    expect(capacity.limit).toBe(MAX_MAP_BYTES)
    expect(capacity.message).toContain(String(MAX_MAP_BYTES + 1))
    expect(cancelSpy).toHaveBeenCalledTimes(1)
  })

  it('流式累计超限：reader.cancel 失败不掩盖容量错误', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(MAX_MAP_BYTES, 1))
        controller.enqueue(bytes(1, 2))
        // 不 close：流保持 readable，reader.cancel 才会进入底层 cancel
      },
      cancel() {
        throw new Error('cancel failed')
      },
    })
    const { fetchImpl } = mockFetch(() => Promise.resolve(new Response(stream)))
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const error = await captureRejection(repository.fetchPayload(TEST_URL, new AbortController().signal))

    expect(error).toBeInstanceOf(MapCapacityError)
    expect((error as MapCapacityError).code).toBe('MAP_BYTES_EXCEEDED')
  })
})

// ---------------------------------------------------------------------------
// 15 秒硬超时（fake timers，不依赖系统时间）
// ---------------------------------------------------------------------------

describe('fetchPayload 硬超时（§3.1 MAP_REQUEST_TIMEOUT_MS=15000）', () => {
  it('fetch 挂起超过 15000ms → MapNetworkError MAP_REQUEST_TIMEOUT（fake timers）', async () => {
    vi.useFakeTimers()
    const { fetchImpl, fetchMock } = mockFetch(() => new Promise<Response>(() => {}))
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const captured = captureRejection(repository.fetchPayload(TEST_URL, new AbortController().signal))
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    const error = await captured

    expect(error).toBeInstanceOf(MapNetworkError)
    const network = error as MapNetworkError
    expect(network.code).toBe('MAP_REQUEST_TIMEOUT')
    expect(network.message).toContain('15000')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('流式读取期间挂起超过 15000ms → MapNetworkError MAP_REQUEST_TIMEOUT', async () => {
    vi.useFakeTimers()
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        // 永不 enqueue：read 永远挂起
      },
    })
    const { fetchImpl } = mockFetch(() => Promise.resolve(new Response(stream)))
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const captured = captureRejection(repository.fetchPayload(TEST_URL, new AbortController().signal))
    await vi.advanceTimersByTimeAsync(0) // fetch 兑现并进入 read 等待
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    const error = await captured

    expect(error).toBeInstanceOf(MapNetworkError)
    expect((error as MapNetworkError).code).toBe('MAP_REQUEST_TIMEOUT')
  })

  it('14999ms 内完成则不触发超时', async () => {
    vi.useFakeTimers()
    const { fetchImpl } = mockFetch(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(responseOf([new Uint8Array([1])])), TIMEOUT_MS - 1)
        }),
    )
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const pending = repository.fetchPayload(TEST_URL, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1)
    const result = await pending

    expect(new Uint8Array(result)).toEqual(new Uint8Array([1]))
  })
})

// ---------------------------------------------------------------------------
// 外部 AbortSignal：中止优先，绝不误报（端口契约、§5.1）
// ---------------------------------------------------------------------------

describe('fetchPayload 外部 AbortSignal 中止', () => {
  it('入口时 signal 已中止：不发起 fetch，直接 reject AbortError', async () => {
    const { fetchImpl, fetchMock } = mockFetch(() => Promise.resolve(responseOf([new Uint8Array([1])])))
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })
    const controller = new AbortController()
    controller.abort()

    const error = await captureRejection(repository.fetchPayload(TEST_URL, controller.signal))

    expectAbortError(error)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetch 挂起期间中止（底层响应 signal）→ AbortError，不误报网络错误', async () => {
    const { fetchImpl } = mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted', 'AbortError')),
            { once: true },
          )
        }),
    )
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })
    const controller = new AbortController()

    const captured = captureRejection(repository.fetchPayload(TEST_URL, controller.signal))
    controller.abort()
    const error = await captured

    expectAbortError(error)
  })

  it('底层不响应 signal（永不兑现的 mock）→ 外部中止仍能终止等待', async () => {
    const { fetchImpl } = mockFetch(() => new Promise<Response>(() => {}))
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })
    const controller = new AbortController()

    const captured = captureRejection(repository.fetchPayload(TEST_URL, controller.signal))
    controller.abort()
    const error = await captured

    expectAbortError(error)
  })

  it('流式读取期间外部中止 → AbortError', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        // 永不 enqueue：read 挂起
      },
    })
    const { fetchImpl } = mockFetch(() => Promise.resolve(new Response(stream)))
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })
    const controller = new AbortController()

    const captured = captureRejection(repository.fetchPayload(TEST_URL, controller.signal))
    await flush() // fetch 兑现并进入 read 等待
    controller.abort()
    const error = await captured

    expectAbortError(error)
  })

  it('自定义 abort reason 归一化为 AbortError', async () => {
    const { fetchImpl } = mockFetch(() => new Promise<Response>(() => {}))
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })
    const controller = new AbortController()

    const captured = captureRejection(repository.fetchPayload(TEST_URL, controller.signal))
    controller.abort('页面切换')
    const error = await captured

    expectAbortError(error)
  })

  it('容量中止的 cancel 挂起期间外部中止 → AbortError 优先于 MapCapacityError', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(MAX_MAP_BYTES, 1))
        controller.enqueue(bytes(1, 2))
        // 不 close：流保持 readable，reader.cancel 才会等待底层 cancel（永不兑现）
      },
      cancel: () => new Promise<void>(() => {}),
    })
    const { fetchImpl } = mockFetch(() => Promise.resolve(fakeResponse({ body: stream })))
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })
    const controller = new AbortController()

    const captured = captureRejection(repository.fetchPayload(TEST_URL, controller.signal))
    await flush() // 读完两个分块，进入挂起的 cancel
    controller.abort()
    const error = await captured

    expectAbortError(error)
  })

  it('外部中止优先于超时：中止后到达超时不误报 MAP_REQUEST_TIMEOUT', async () => {
    vi.useFakeTimers()
    const { fetchImpl } = mockFetch(() => new Promise<Response>(() => {}))
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })
    const controller = new AbortController()

    const captured = captureRejection(repository.fetchPayload(TEST_URL, controller.signal))
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS / 2)
    controller.abort()
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    const error = await captured

    expectAbortError(error)
  })
})

// ---------------------------------------------------------------------------
// HTTP 非 2xx（§11：MapHttpError 含状态码与移除 query/hash 的 URL）
// ---------------------------------------------------------------------------

describe('fetchPayload HTTP 非 2xx（§11 MapHttpError）', () => {
  it('HTTP 404：错误含状态码，展示 URL 移除 query/hash，请求 URL 原样发出', async () => {
    const url = 'https://internal.example.com/map.json?token=secret&ts=1#frag'
    const { fetchImpl, fetchMock } = mockFetch(() => Promise.resolve(new Response('x', { status: 404 })))
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const error = await captureRejection(repository.fetchPayload(url, new AbortController().signal))

    expect(error).toBeInstanceOf(MapHttpError)
    const http = error as MapHttpError
    expect(http.code).toBe('MAP_HTTP_NON_2XX')
    expect(http.message).toContain('404')
    expect(http.message).toContain('https://internal.example.com/map.json')
    expect(http.message).not.toContain('token')
    expect(http.message).not.toContain('secret')
    expect(http.message).not.toContain('frag')
    expect(http.fieldPath).toBe('https://internal.example.com/map.json')
    // 实际请求 URL 不做净化，原样发出
    expect(fetchMock.mock.calls[0]?.[0]).toBe(url)
  })

  it('HTTP 500：无 query/hash 的 URL 原样展示', async () => {
    const { fetchImpl } = mockFetch(() => Promise.resolve(new Response('x', { status: 500 })))
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const error = await captureRejection(repository.fetchPayload(TEST_URL, new AbortController().signal))

    expect(error).toBeInstanceOf(MapHttpError)
    expect((error as MapHttpError).message).toContain('500')
    expect((error as MapHttpError).fieldPath).toBe(TEST_URL)
  })

  it('HTTP 403：hash 位于 query 之前时同样截断', async () => {
    const { fetchImpl } = mockFetch(() => Promise.resolve(new Response('x', { status: 403 })))
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const error = await captureRejection(
      repository.fetchPayload('/map.json#section?later=1', new AbortController().signal),
    )

    expect((error as MapHttpError).fieldPath).toBe('/map.json')
  })
})

// ---------------------------------------------------------------------------
// 网络失败与意外中断（§11 MapNetworkError）
// ---------------------------------------------------------------------------

describe('fetchPayload 网络失败与意外中断（§11 MapNetworkError）', () => {
  it('fetch reject TypeError → MapNetworkError MAP_NETWORK_FAILURE，cause 保留', async () => {
    const cause = new TypeError('fetch failed')
    const { fetchImpl } = mockFetch(() => Promise.reject(cause))
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const error = await captureRejection(repository.fetchPayload(TEST_URL, new AbortController().signal))

    expect(error).toBeInstanceOf(MapNetworkError)
    expect((error as MapNetworkError).code).toBe('MAP_NETWORK_FAILURE')
    expect((error as MapNetworkError).cause).toBe(cause)
  })

  it('fetch reject 非 Error 值 → MapNetworkError MAP_NETWORK_FAILURE', async () => {
    const { fetchImpl } = mockFetch(() => Promise.reject('socket reset'))
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const error = await captureRejection(repository.fetchPayload(TEST_URL, new AbortController().signal))

    expect(error).toBeInstanceOf(MapNetworkError)
    expect((error as MapNetworkError).code).toBe('MAP_NETWORK_FAILURE')
  })

  it('流式读取期间底层错误 → MapNetworkError MAP_NETWORK_FAILURE', async () => {
    const cause = new TypeError('stream broke')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.error(cause)
      },
    })
    const { fetchImpl } = mockFetch(() => Promise.resolve(new Response(stream)))
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const error = await captureRejection(repository.fetchPayload(TEST_URL, new AbortController().signal))

    expect(error).toBeInstanceOf(MapNetworkError)
    expect((error as MapNetworkError).code).toBe('MAP_NETWORK_FAILURE')
    expect((error as MapNetworkError).cause).toBe(cause)
  })

  it('非外部 signal、非超时的 AbortError → 意外中断 MapNetworkError MAP_REQUEST_INTERRUPTED', async () => {
    const { fetchImpl } = mockFetch(() =>
      Promise.reject(new DOMException('The operation was aborted', 'AbortError')),
    )
    const repository = createHttpMapRepository({ timeoutMs: TIMEOUT_MS, fetchImpl })

    const error = await captureRejection(repository.fetchPayload(TEST_URL, new AbortController().signal))

    expect(error).toBeInstanceOf(MapNetworkError)
    expect((error as MapNetworkError).code).toBe('MAP_REQUEST_INTERRUPTED')
    expect((error as MapNetworkError).message).not.toContain('超时')
  })
})
