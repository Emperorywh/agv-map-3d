/**
 * HTTP 地图仓库：MapRepository 端口的 fetch 适配器（SPEC §3.1、§11）。
 *
 * 职责边界（只搬运字节，不解析内容——JSON 解析与信封校验是 domain/Worker 职责）：
 * - URL：默认 /map.json；允许 VITE_MAP_URL 指定同契约 URL（resolveDefaultMapUrl）
 * - 容量：Content-Length 声明值或流式累计字节 > MAX_MAP_BYTES 时立即中止读取，
 *   reject MapCapacityError（含实际值与上限，§3.1、§11）
 * - 超时：内部 AbortController 实施 timeoutMs 硬超时（由组合根注入 config 的
 *   MAP_REQUEST_TIMEOUT_MS；infrastructure 不反向依赖 config 层，§12）；
 *   超时、网络失败、请求被非当前流程意外中断 → MapNetworkError（§11）
 * - 中止串联：外部 signal 中止优先于超时与一切错误，reject AbortError 语义，
 *   绝不误报；所有异步等待都与中止通道 race，不依赖底层 fetch/stream
 *   是否响应 signal（mock 或异常底层同样可终止）
 * - HTTP 非 2xx → MapHttpError，展示 URL 已移除 query/hash（§11）
 */

import { FactoryMapError, MapCapacityError, MapHttpError, MapNetworkError } from '../domain/errors'
import { MAX_MAP_BYTES } from '../domain/limits'
import type { MapRepository } from '../application/ports/MapRepository'

/** 默认地图 URL（§3.1：public/map.json，换图只换文件不重新打包） */
export const DEFAULT_MAP_URL = '/map.json'

/** 解析地图请求 URL（§3.1）：envUrl 为非空字符串时覆盖默认 URL（同契约），否则 /map.json */
export function resolveMapUrl(envUrl?: string | null): string {
  return typeof envUrl === 'string' && envUrl.length > 0 ? envUrl : DEFAULT_MAP_URL
}

/** 从构建环境解析地图 URL：import.meta.env.VITE_MAP_URL 覆盖，缺省 /map.json（§3.1） */
export function resolveDefaultMapUrl(): string {
  return resolveMapUrl(import.meta.env.VITE_MAP_URL)
}

export interface HttpMapRepositoryOptions {
  /**
   * 单次请求硬超时（毫秒）。由组合根注入 config 的 MAP_REQUEST_TIMEOUT_MS：
   * infrastructure 不反向依赖 config 层（§12 层依赖方向）。
   */
  readonly timeoutMs: number
  /** fetch 实现；缺省全局 fetch。测试注入 mock，不依赖真实网络（§15.1） */
  readonly fetchImpl?: typeof fetch
}

/** 中止语义归一化：外部 signal 中止一律以 AbortError reject（端口契约） */
function toAbortRejection(reason: unknown): unknown {
  if (typeof reason === 'object' && reason !== null && 'name' in reason && reason.name === 'AbortError') {
    return reason
  }
  return new DOMException('The operation was aborted', 'AbortError')
}

/** 非当前流程的意外中断识别：reject 值带 AbortError 名（§11 MapNetworkError 行） */
function isAbortLike(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

/** §11：MapHttpError 展示 URL 移除 query/hash（不暴露鉴权参数等敏感信息） */
function toDisplayUrl(url: string): string {
  const queryIndex = url.indexOf('?')
  const hashIndex = url.indexOf('#')
  const end = Math.min(
    queryIndex === -1 ? url.length : queryIndex,
    hashIndex === -1 ? url.length : hashIndex,
  )
  return url.slice(0, end)
}

/** §11 MapCapacityError：错误信息含实际字节数与上限 */
function payloadTooLargeError(actual: number): MapCapacityError {
  return new MapCapacityError(
    'MAP_BYTES_EXCEEDED',
    `地图数据超过大小上限：实际 ${actual} 字节，上限 ${MAX_MAP_BYTES} 字节（20MiB）`,
    { actual, limit: MAX_MAP_BYTES },
  )
}

/** 立即中止读取并尽力释放底层连接；释放失败不掩盖已判定的错误结论 */
async function cancelQuietly(cancel: () => Promise<void>): Promise<void> {
  try {
    await cancel()
  } catch {
    // 中止读取是资源释放动作，不改变已判定的容量错误
  }
}

/**
 * 创建 HTTP 地图仓库（唯一 MapRepository 生产实现）。
 * 成功 resolve 为字节完整的新建 ArrayBuffer，可直接 transfer 给 Worker。
 */
export function createHttpMapRepository(options: HttpMapRepositoryOptions): MapRepository {
  const { timeoutMs, fetchImpl = fetch } = options

  return {
    async fetchPayload(url, signal) {
      if (signal.aborted) {
        throw toAbortRejection(signal.reason)
      }

      // 内部 controller 串联外部 signal 与硬超时；外部中止优先（§3.1、§5.1）
      const inner = new AbortController()
      let timedOut = false
      const onExternalAbort = (): void => {
        inner.abort(signal.reason)
      }
      const timer = setTimeout(() => {
        timedOut = true
        inner.abort()
      }, timeoutMs)
      signal.addEventListener('abort', onExternalAbort, { once: true })

      // 统一中止通道：每个异步等待都与它 race，任何中止源都能终止等待
      const aborted = new Promise<never>((_resolve, reject) => {
        inner.signal.addEventListener(
          'abort',
          () => reject(toAbortRejection(inner.signal.reason)),
          { once: true },
        )
      })
      const orAborted = <T>(pending: Promise<T>): Promise<T> => Promise.race([pending, aborted])

      try {
        const response = await orAborted(fetchImpl(url, { signal: inner.signal }))

        if (!response.ok) {
          const displayUrl = toDisplayUrl(url)
          throw new MapHttpError(
            'MAP_HTTP_NON_2XX',
            `地图请求失败：HTTP ${response.status}（${displayUrl}）`,
            { fieldPath: displayUrl },
          )
        }

        const body = response.body
        const contentLength = response.headers.get('content-length')
        const declared = contentLength === null ? Number.NaN : Number(contentLength)
        if (declared > MAX_MAP_BYTES) {
          // Content-Length 已超限：不读任何字节，立即中止（§3.1）
          await orAborted(cancelQuietly(() => body?.cancel() ?? Promise.resolve()))
          throw payloadTooLargeError(declared)
        }

        if (body === null) {
          // 2xx 无 body（如 204）：空 payload；解析/信封校验由 Worker 判定
          return new ArrayBuffer(0)
        }

        const reader = body.getReader()
        const chunks: Uint8Array[] = []
        let total = 0
        for (;;) {
          const { done, value } = await orAborted(reader.read())
          if (done) break
          total += value.byteLength
          if (total > MAX_MAP_BYTES) {
            // 流式累计超限：立即中止读取，不再消费后续分块（§3.1）
            await orAborted(cancelQuietly(() => reader.cancel()))
            throw payloadTooLargeError(total)
          }
          chunks.push(value)
        }

        const payload = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          payload.set(chunk, offset)
          offset += chunk.byteLength
        }
        return payload.buffer
      } catch (error) {
        // 外部中止优先：绝不把中止误报为超时/网络/HTTP/容量错误（端口契约）
        if (signal.aborted) {
          throw toAbortRejection(signal.reason)
        }
        if (error instanceof FactoryMapError) {
          throw error
        }
        if (timedOut) {
          throw new MapNetworkError('MAP_REQUEST_TIMEOUT', `地图请求超时：${timeoutMs} 毫秒内未完成响应读取`, {
            cause: error,
          })
        }
        if (isAbortLike(error)) {
          // 非外部 signal、非超时的 AbortError：请求被非当前流程意外中断（§11）
          throw new MapNetworkError('MAP_REQUEST_INTERRUPTED', '地图请求被意外中断', { cause: error })
        }
        throw new MapNetworkError('MAP_NETWORK_FAILURE', '地图数据网络请求失败', { cause: error })
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onExternalAbort)
      }
    },
  }
}
