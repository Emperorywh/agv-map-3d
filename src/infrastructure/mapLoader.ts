/**
 * map.json 加载管线（SPEC §4.4 / §10）：
 *   fetch(`${import.meta.env.BASE_URL}map.json`)（拼 BASE_URL 兼容子路径部署）+ 进度上报
 *   → 默认 Web Worker 内 JSON.parse + 规范化（normalize.worker.ts）
 *   → Worker 创建 / 运行失败时 console 警告并回退主线程执行同一套纯函数。
 * 请求失败 / JSON 损坏 / 顶层结构缺失时抛出带原因的错误（进全屏错误页）。
 */

import { MapDataError, normalizeMapFromJson } from '../domain/normalize'
import type { NormalizeResult, NormalizeStats } from '../domain/normalize'
import type { NormalizedMap } from '../domain/types'
import type { NormalizeWorkerRequest, NormalizeWorkerResponse } from './normalize.worker'

/** 加载进度（供进度条 UI 订阅） */
export interface MapLoadProgress {
  /** fetch = 下载中（按字节推进）；normalize = 解析与规范化中（不定进度） */
  phase: 'fetch' | 'normalize'
  loadedBytes: number
  /** 响应 Content-Length；缺失（如 gzip 传输）时为 null，UI 按不定进度展示 */
  totalBytes: number | null
}

export interface LoadMapOptions {
  /** BEZIER 细分弦高差容差（米），由组合层从 config 传入；缺省用 domain 默认值 */
  bezierTolerance?: number
  onProgress?: (progress: MapLoadProgress) => void
}

export interface LoadedMap {
  map: NormalizedMap
  stats: NormalizeStats
  /** true = 在 Web Worker 中完成规范化；false = Worker 失败回退主线程（SPEC §10） */
  usedWorker: boolean
}

/** 加载 map.json 并规范化为 NormalizedMap */
export async function loadMap(options?: LoadMapOptions): Promise<LoadedMap> {
  const onProgress = options?.onProgress
  const bezierTolerance = options?.bezierTolerance

  const { jsonText, totalBytes } = await fetchMapJsonText(onProgress)
  onProgress?.({ phase: 'normalize', loadedBytes: jsonText.length, totalBytes })

  try {
    const result = await normalizeInWorker(jsonText, bezierTolerance)
    return { ...result, usedWorker: true }
  } catch (error) {
    // 数据错误（JSON 损坏 / 顶层结构缺失）是确定性的，主线程重试结果相同，直接抛出
    if (error instanceof MapDataError) {
      throw error
    }
    console.warn('[mapLoader] Worker 创建 / 运行失败，回退主线程规范化：', error)
    const result = normalizeMapFromJson(jsonText, { bezierTolerance })
    return { ...result, usedWorker: false }
  }
}

// ---------------------------------------------------------------------------
// fetch + 下载进度
// ---------------------------------------------------------------------------

interface FetchedMapJson {
  jsonText: string
  totalBytes: number | null
}

/** 请求失败（网络错误 / HTTP 非 2xx）时抛出带原因的错误 */
async function fetchMapJsonText(
  onProgress?: (progress: MapLoadProgress) => void,
): Promise<FetchedMapJson> {
  const url = `${import.meta.env.BASE_URL}map.json`
  let response: Response
  try {
    response = await fetch(url)
  } catch (error) {
    throw new Error(
      `map.json 请求失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!response.ok) {
    throw new Error(`map.json 请求失败：HTTP ${response.status} ${response.statusText}`)
  }

  const lengthHeader = response.headers.get('Content-Length')
  const parsedLength = lengthHeader === null ? NaN : Number(lengthHeader)
  const totalBytes = Number.isFinite(parsedLength) ? parsedLength : null

  const body = response.body
  if (body === null) {
    // 响应无流式体（极少见的环境）：一次性读取文本
    const jsonText = await response.text()
    onProgress?.({ phase: 'fetch', loadedBytes: jsonText.length, totalBytes })
    return { jsonText, totalBytes }
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let loadedBytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    chunks.push(value)
    loadedBytes += value.byteLength
    onProgress?.({ phase: 'fetch', loadedBytes, totalBytes })
  }

  const merged = new Uint8Array(loadedBytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { jsonText: new TextDecoder().decode(merged), totalBytes }
}

// ---------------------------------------------------------------------------
// Worker 规范化
// ---------------------------------------------------------------------------

/**
 * 在 Worker 中执行 JSON.parse + 规范化。
 * 拒绝（reject）分两类：
 * - MapDataError：Worker 内跑完纯函数后报出的数据错误，调用方不应回退重试；
 * - 其他 Error：Worker 创建失败（CSP / 环境不支持）或脚本加载失败，调用方回退主线程。
 */
function normalizeInWorker(
  jsonText: string,
  bezierTolerance: number | undefined,
): Promise<NormalizeResult> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./normalize.worker.ts', import.meta.url), { type: 'module' })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    worker.onmessage = (event: MessageEvent<NormalizeWorkerResponse>) => {
      const message = event.data
      worker.terminate()
      if (message.ok) {
        resolve(message.result)
      } else if (message.dataError) {
        reject(new MapDataError(message.reason))
      } else {
        reject(new Error(message.reason))
      }
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(`Worker 运行失败：${event.message || '未知错误'}`))
    }
    const request: NormalizeWorkerRequest = { jsonText, bezierTolerance }
    worker.postMessage(request)
  })
}
