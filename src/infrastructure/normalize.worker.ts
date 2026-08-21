/**
 * 规范化 Web Worker（SPEC §4.4）：JSON.parse + 规范化 + BEZIER 细分在 Worker 线程执行，
 * 避免 6.5 MB map.json 的解析阻塞主线程。
 * 由 mapLoader 经 new Worker(new URL('./normalize.worker.ts', import.meta.url), { type: 'module' }) 创建；
 * Worker 创建失败时由 mapLoader 回退主线程执行同一套纯函数（SPEC §10）。
 */

import { MapDataError, normalizeMapFromJson } from '../domain/normalize'
import type { NormalizeResult } from '../domain/normalize'

/** 主线程 → Worker 请求 */
export interface NormalizeWorkerRequest {
  jsonText: string
  bezierTolerance?: number
  corridorGeometryTolerance?: number
}

/** Worker → 主线程响应；dataError=true 表示数据本身的确定性错误（主线程重试结果相同，无需回退） */
export type NormalizeWorkerResponse =
  | { ok: true; result: NormalizeResult }
  | { ok: false; reason: string; dataError: boolean }

// tsconfig 仅含 DOM lib（无 webworker lib），这里显式收窄到 Worker 全局作用域所需的最小接口
const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<NormalizeWorkerRequest>) => void) | null
  postMessage: (message: NormalizeWorkerResponse) => void
}

workerScope.onmessage = (event) => {
  const { jsonText, bezierTolerance, corridorGeometryTolerance } = event.data
  try {
    const result = normalizeMapFromJson(jsonText, { bezierTolerance, corridorGeometryTolerance })
    workerScope.postMessage({ ok: true, result })
  } catch (error) {
    workerScope.postMessage({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      dataError: error instanceof MapDataError,
    })
  }
}
