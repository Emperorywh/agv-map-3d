/**
 * Worker 构建主体（SPEC §3.1、§5.1、§11）：不依赖 Worker 全局的可测纯函数。
 *
 * 管线：fatal UTF-8 TextDecoder 解码 → JSON.parse → buildFactorySceneModel
 * （内含信封解码、§3.3 校验、领域规范化、几何构建与 transfer 前断言）
 * → 成功结果 + 全部 TypedArray 的 transfer 列表。
 *
 * 错误映射（§11，稳定错误码，不产出部分 SceneModel）：
 * - 非法 UTF-8            → MapParseError（MAP_INVALID_UTF8）
 * - JSON 语法错误          → MapParseError（MAP_JSON_SYNTAX）
 * - 信封非法              → MapEnvelopeError（透传 decodeMapEnvelope）
 * - §3.3 不变量失败        → MapValidationError（透传）
 * - 容量/范围超限          → MapCapacityError（透传）
 * - 几何无法产生有限结果    → MapGeometryError（透传）
 * - transfer 前断言失败    → SceneBuildError（透传）
 * - 请求形状非法           → SceneBuildError（MAP_WORKER_PROTOCOL_INVALID）
 * - 其余未捕获异常         → SceneBuildError（MAP_WORKER_UNEXPECTED）
 *
 * 无论成败都返回结果消息（Worker 必须总能 postMessage 应答，否则主线程
 * 将永远等待）；requestId 无法读取时以 -1 占位——主线程 requestId 从 1 开始
 * 单调递增，-1 永不匹配，会被当作过期结果丢弃（§5.1）。
 */

import { FactoryMapError, MapParseError, SceneBuildError } from '../../domain/errors'
import { describeValue, isPlainObject } from '../../domain/invariants'
import { buildFactorySceneModel } from './builders/buildFactorySceneModel'
import type { SceneBuildOptions } from './builders/buildFactorySceneModel'
import { createMapBuildErrorResult, createMapBuildSuccessResult } from './workerProtocol'
import type { MapBuildResult, TransferableMessage } from './workerProtocol'

/** requestId 无法读取时的占位值：永不匹配主线程的单调递增 id（从 1 开始） */
export const UNREADABLE_REQUEST_ID = -1

/** 尽力读取 requestId：请求可能根本不合协议，读不到就用占位值 */
function readRequestId(request: unknown): number {
  if (!isPlainObject(request)) return UNREADABLE_REQUEST_ID
  const requestId = request.requestId
  if (typeof requestId !== 'number' || !Number.isFinite(requestId)) return UNREADABLE_REQUEST_ID
  return requestId
}

/** 校验请求形状；非法请求以 SceneBuildError 表达（§11：Worker 绑定失败语义） */
function readBuildRequest(request: unknown): { payload: ArrayBuffer; options: SceneBuildOptions } {
  if (!isPlainObject(request)) {
    throw new SceneBuildError(
      'MAP_WORKER_PROTOCOL_INVALID',
      `Worker 构建请求必须是非 null 对象，实际为 ${describeValue(request)}`,
    )
  }
  if (request.type !== 'build') {
    throw new SceneBuildError(
      'MAP_WORKER_PROTOCOL_INVALID',
      `Worker 构建请求 type 必须是 "build"，实际为 ${describeValue(request.type)}`,
    )
  }
  if (!(request.payload instanceof ArrayBuffer)) {
    throw new SceneBuildError(
      'MAP_WORKER_PROTOCOL_INVALID',
      `Worker 构建请求 payload 必须是 ArrayBuffer，实际为 ${describeValue(request.payload)}`,
    )
  }
  if (!isPlainObject(request.options)) {
    throw new SceneBuildError(
      'MAP_WORKER_PROTOCOL_INVALID',
      `Worker 构建请求 options 必须是非 null 对象，实际为 ${describeValue(request.options)}`,
    )
  }
  return { payload: request.payload, options: request.options as unknown as SceneBuildOptions }
}

/** §3.1：new TextDecoder('utf-8', { fatal: true }) 解码；非法 UTF-8 → MapParseError */
function decodeUtf8(payload: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(payload)
  } catch (error) {
    throw new MapParseError('MAP_INVALID_UTF8', '地图数据不是合法的 UTF-8 文本', { cause: error })
  }
}

/** JSON 解析；语法错误 → MapParseError（§11：不展示原始响应内容） */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new MapParseError('MAP_JSON_SYNTAX', '地图数据不是合法的 JSON 文本', { cause: error })
  }
}

/** 未捕获异常兜底（§11 SceneBuildError 行）；领域错误原样透传 */
function toWorkerBuildError(error: unknown): FactoryMapError {
  if (error instanceof FactoryMapError) return error
  return new SceneBuildError('MAP_WORKER_UNEXPECTED', '场景构建发生未捕获异常', { cause: error })
}

/**
 * 执行一次构建请求，返回结果消息与 transfer 列表。
 * 本函数不抛出：任何失败都归入 §11 错误结果（错误结果的 transfer 列表为空）。
 */
export function runMapBuild(request: unknown): TransferableMessage<MapBuildResult> {
  const requestId = readRequestId(request)
  try {
    const { payload, options } = readBuildRequest(request)
    const model = buildFactorySceneModel(parseJson(decodeUtf8(payload)), options)
    return createMapBuildSuccessResult(requestId, model)
  } catch (error) {
    return createMapBuildErrorResult(requestId, toWorkerBuildError(error))
  }
}
