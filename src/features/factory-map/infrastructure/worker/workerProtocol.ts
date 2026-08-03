/**
 * Worker 构建协议（SPEC §3.1、§5.1、§11）：主线程与 mapBuild Worker 之间
 * 唯一可序列化 request/result 契约。
 *
 * - 请求：携带 requestId（单调递增，供丢弃竞态过期结果）、transferable
 *   ArrayBuffer payload 与 §13 场景构建选项（由组合根从 config 层注入，
 *   Worker 不反向依赖 config）；payload 列入 transfer 列表，零拷贝进入 Worker
 * - 成功结果：携带完整 FactorySceneModel，模型内全部 TypedArray 的底层
 *   ArrayBuffer 列入 transfer 列表（13 个，见 collectSceneModelTransferables），
 *   零拷贝回到主线程
 * - 错误结果：携带稳定错误码、字段路径、简体中文摘要与错误名（用于主线程
 *   重建 §11 对应错误类型）；MapValidationError 的 totalCount 与
 *   MapCapacityError 的 actual/limit 一并保真
 *
 * 协议的接收侧校验（parseMapBuildResult）只做形状检查：success 模型的逐字段
 * 再校验由主线程 binder 完成（§5.1，bindFactorySceneModel）。
 * 任何协议非法都以 SceneBuildError（MAP_WORKER_PROTOCOL_INVALID）表达，
 * 主线程不会把不可信消息当作场景模型或领域错误使用。
 */

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
import { describeValue, isPlainObject } from '../../domain/invariants'
import type { SceneBuildOptions } from './builders/buildFactorySceneModel'

// ---------------------------------------------------------------------------
// 消息形状
// ---------------------------------------------------------------------------

/** 构建请求：payload 的所有权随 postMessage transfer 移交给 Worker（§3.1） */
export interface MapBuildRequest {
  readonly type: 'build'
  /** 单调递增请求号；结果原样携带，主线程据此丢弃竞态过期结果（§5.1） */
  readonly requestId: number
  /** 地图 UTF-8 字节（transferable） */
  readonly payload: ArrayBuffer
  /** §13 场景构建选项（config 固定值，由组合根注入） */
  readonly options: SceneBuildOptions
}

/** 错误结果的可序列化载体：稳定错误码 + 字段路径 + 中文摘要 + 错误名（§3.3、§11） */
export interface SerializedMapError {
  /** 领域错误类名（如 MapValidationError），主线程据此重建对应错误类型 */
  readonly name: string
  readonly code: string
  readonly message: string
  readonly fieldPath: string | undefined
  /** MapValidationError 的错误总数（§11：显示首个错误路径与错误总数） */
  readonly totalCount: number | undefined
  /** MapCapacityError 的实际值与上限（§11：显示实际值与上限） */
  readonly actual: number | undefined
  readonly limit: number | undefined
}

export interface MapBuildSuccessResult {
  readonly type: 'success'
  readonly requestId: number
  readonly model: FactorySceneModel
}

export interface MapBuildErrorResult {
  readonly type: 'error'
  readonly requestId: number
  readonly error: SerializedMapError
}

export type MapBuildResult = MapBuildSuccessResult | MapBuildErrorResult

/** 连同 transfer 列表一起发送的消息（postMessage(message, transfer) 的两个实参） */
export interface TransferableMessage<T> {
  readonly message: T
  readonly transfer: ArrayBuffer[]
}

// ---------------------------------------------------------------------------
// 请求构造
// ---------------------------------------------------------------------------

/** 构造构建请求；payload 列入 transfer 列表（调用后调用方不得再读取 payload） */
export function createMapBuildRequest(
  requestId: number,
  payload: ArrayBuffer,
  options: SceneBuildOptions,
): TransferableMessage<MapBuildRequest> {
  return {
    message: { type: 'build', requestId, payload, options },
    transfer: [payload],
  }
}

// ---------------------------------------------------------------------------
// 结果构造与 transfer 列表
// ---------------------------------------------------------------------------

/**
 * 收集 SceneModel 内全部 TypedArray 的底层 ArrayBuffer（§3.1、§5.1 transfer 契约）。
 * 固定 13 个：路径正/反向各 positions+normals+indices，箭头正/反向 matrices，
 * 节点圆点 matrices，站点圆环 matrices+colors，站点朝向 matrices+colors。
 * 构建器只产生独立 ArrayBuffer（非 SharedArrayBuffer），此处据此断言类型。
 */
export function collectSceneModelTransferables(model: FactorySceneModel): ArrayBuffer[] {
  const views: readonly (Float32Array | Uint32Array)[] = [
    model.paths.forward.positions,
    model.paths.forward.normals,
    model.paths.forward.indices,
    model.paths.backward.positions,
    model.paths.backward.normals,
    model.paths.backward.indices,
    model.arrows.forward.matrices,
    model.arrows.backward.matrices,
    model.nodes.dots.matrices,
    model.nodes.rings.matrices,
    model.nodes.rings.colors,
    model.nodes.directions.matrices,
    model.nodes.directions.colors,
  ]
  return views.map((view) => view.buffer as ArrayBuffer)
}

/** 构造成功结果；模型内全部 TypedArray 列入 transfer 列表（§3.1） */
export function createMapBuildSuccessResult(
  requestId: number,
  model: FactorySceneModel,
): TransferableMessage<MapBuildResult> {
  return {
    message: { type: 'success', requestId, model },
    transfer: collectSceneModelTransferables(model),
  }
}

/** 构造错误结果（序列化 §11 领域错误，不传递不可序列化的 cause 链） */
export function createMapBuildErrorResult(
  requestId: number,
  error: FactoryMapError,
): TransferableMessage<MapBuildResult> {
  return {
    message: { type: 'error', requestId, error: serializeMapError(error) },
    transfer: [],
  }
}

// ---------------------------------------------------------------------------
// 错误序列化 / 反序列化（§11 错误类型跨线程保真）
// ---------------------------------------------------------------------------

/** FactoryMapError → 可序列化载体；totalCount/actual/limit 按错误类型保真 */
export function serializeMapError(error: FactoryMapError): SerializedMapError {
  return {
    name: error.name,
    code: error.code,
    message: error.message,
    fieldPath: error.fieldPath,
    totalCount: error instanceof MapValidationError ? error.totalCount : undefined,
    actual: error instanceof MapCapacityError ? error.actual : undefined,
    limit: error instanceof MapCapacityError ? error.limit : undefined,
  }
}

/**
 * 可序列化载体 → §11 对应错误类型实例（instanceof 语义在主线程恢复）。
 * 未识别的错误名归为 SceneBuildError（保留原错误码/摘要/字段路径）：
 * Worker 端产生了主线程不认识的错误，属于场景构建失败（§11）。
 */
export function deserializeMapError(serialized: SerializedMapError): FactoryMapError {
  const { code, message, fieldPath } = serialized
  switch (serialized.name) {
    case 'MapParseError':
      return new MapParseError(code, message, { fieldPath })
    case 'MapEnvelopeError':
      return new MapEnvelopeError(code, message, { fieldPath })
    case 'MapValidationError':
      return new MapValidationError(code, message, { fieldPath, totalCount: serialized.totalCount })
    case 'MapCapacityError':
      return new MapCapacityError(code, message, {
        fieldPath,
        actual: serialized.actual,
        limit: serialized.limit,
      })
    case 'MapGeometryError':
      return new MapGeometryError(code, message, { fieldPath })
    case 'SceneBuildError':
      return new SceneBuildError(code, message, { fieldPath })
    default:
      return new SceneBuildError(code, message, { fieldPath })
  }
}

// ---------------------------------------------------------------------------
// 接收侧协议校验
// ---------------------------------------------------------------------------

/** 协议非法统一表达为 SceneBuildError（§11：Worker 崩溃或绑定失败） */
function protocolViolation(reason: string): SceneBuildError {
  return new SceneBuildError('MAP_WORKER_PROTOCOL_INVALID', `Worker 构建协议非法：${reason}`)
}

function readRequiredFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw protocolViolation(`${field} 必须是有限数值，实际为 ${describeValue(value)}`)
  }
  return value
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw protocolViolation(`${field} 必须是字符串或缺省，实际为 ${describeValue(value)}`)
  }
  return value
}

function readOptionalFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw protocolViolation(`${field} 必须是有限数值或缺省，实际为 ${describeValue(value)}`)
  }
  return value
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw protocolViolation(`${field} 必须是字符串，实际为 ${describeValue(value)}`)
  }
  return value
}

function parseSerializedError(value: unknown): SerializedMapError {
  if (!isPlainObject(value)) {
    throw protocolViolation(`error 结果的错误载体必须是非 null 对象，实际为 ${describeValue(value)}`)
  }
  return {
    name: readRequiredString(value.name, 'error.name'),
    code: readRequiredString(value.code, 'error.code'),
    message: readRequiredString(value.message, 'error.message'),
    fieldPath: readOptionalString(value.fieldPath, 'error.fieldPath'),
    totalCount: readOptionalFiniteNumber(value.totalCount, 'error.totalCount'),
    actual: readOptionalFiniteNumber(value.actual, 'error.actual'),
    limit: readOptionalFiniteNumber(value.limit, 'error.limit'),
  }
}

/**
 * 校验并解析 Worker 结果消息；协议非法抛 SceneBuildError（MAP_WORKER_PROTOCOL_INVALID）。
 * success 模型的逐字段再校验由主线程 binder 完成（§5.1），此处只校验信封形状。
 */
export function parseMapBuildResult(value: unknown): MapBuildResult {
  if (!isPlainObject(value)) {
    throw protocolViolation(`结果消息必须是非 null 对象，实际为 ${describeValue(value)}`)
  }
  const requestId = readRequiredFiniteNumber(value.requestId, 'requestId')
  if (value.type === 'success') {
    if (!isPlainObject(value.model)) {
      throw protocolViolation(`success 结果的 model 必须是非 null 对象，实际为 ${describeValue(value.model)}`)
    }
    return { type: 'success', requestId, model: value.model as unknown as FactorySceneModel }
  }
  if (value.type === 'error') {
    return { type: 'error', requestId, error: parseSerializedError(value.error) }
  }
  throw protocolViolation(`未知结果类型 ${describeValue(value.type)}`)
}
