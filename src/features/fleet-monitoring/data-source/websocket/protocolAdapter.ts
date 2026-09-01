/**
 * WebSocket 协议适配边界（SPEC §3.2、§11.7、§11.8；TASK-007）。
 *
 * 职责：定义「任意原始 WebSocket 消息 → 归一化车辆消息或结构化错误」的
 *       唯一适配合同。真实协议的 JSON 解析、消息类型识别、版本检查、字段
 *       校验与鉴权/快照请求方式全部收敛在本边界内（TASK-021 落地真实映射），
 *       不得侵入车辆运行时模型、数据源状态机、Hook 或渲染组件。
 * 边界：本模块只声明合同与默认拒绝实现，不猜测真实消息外壳或 payload 结构；
 *       单车负载的归一化复用 model/validateVehicle（隔离语义见其注释）。
 * 关键不变量：
 * 1. decode 的输入是任意 unknown（字符串帧、二进制帧、畸形负载都可能出现），
 *    适配器绝不允许抛出异常——一切失败都以携带稳定错误码的 StructuredError
 *    返回，由数据源层累计解码错误（SPEC §11.7）；
 * 2. 成功结果的 NormalizedVehicleMessage 必须已通过外壳与字段校验：车辆负载
 *    经 validateVehicle 归一化，单车字段异常只隔离该车，不拖垮整条消息；
 * 3. 在真实协议映射（TASK-021）就绪前，默认适配器对一切消息显式拒绝
 *    （PROTOCOL_UNMAPPED），绝不猜测消息结构（SPEC §3.2 / TASK-007 不做项）；
 * 4. encodeSnapshotRequest 返回 null 表示「该协议无法表达快照请求」，数据源
 *    退化为等待服务端主动推送全量快照，不得伪造请求帧。
 */
import { StructuredError } from '@/shared/diagnostics'
import type { VehicleSnapshot } from '../../model/types'

/** 归一化车辆消息：已过外壳与字段校验、尚未打本地接收时间与地图上下文 */
export type NormalizedVehicleMessage =
  | {
      readonly type: 'snapshot'
      readonly schemaVersion: string
      readonly sequence: number
      readonly vehicles: readonly VehicleSnapshot[]
    }
  | {
      readonly type: 'update'
      readonly schemaVersion: string
      readonly sequence: number
      readonly vehicle: VehicleSnapshot
    }
  | {
      readonly type: 'remove'
      readonly schemaVersion: string
      readonly sequence: number
      readonly agvKey: string
    }
  | {
      readonly type: 'heartbeat'
      readonly schemaVersion: string
      readonly sequence: number
    }

/** 解码结果：成功携带恰一条归一化消息；失败携带稳定错误码的结构化错误 */
export type ProtocolDecodeResult =
  | { readonly ok: true; readonly message: NormalizedVehicleMessage }
  | { readonly ok: false; readonly error: StructuredError }

/** 协议层稳定错误码（TASK-021 真实适配器必须复用同一码表） */
export type ProtocolErrorCode =
  | 'PROTOCOL_UNMAPPED'
  | 'PROTOCOL_JSON_PARSE'
  | 'PROTOCOL_MESSAGE_SHELL'
  | 'PROTOCOL_SCHEMA_VERSION'
  | 'PROTOCOL_SEQUENCE_INVALID'
  | 'PROTOCOL_FIELD'
  | 'PROTOCOL_VEHICLE_INVALID'

/**
 * WebSocket 协议适配器合同。
 * 实现方必须自行完成 JSON 解析与全部校验，且不得抛出异常（不变量 1）。
 */
export interface WebSocketProtocolAdapter {
  /** 将一条原始消息（WS message 事件的 data 原样）映射为归一化消息或错误 */
  decode(raw: unknown): ProtocolDecodeResult
  /** 构造全量快照请求帧；null 表示协议无法表达请求（等待服务端推送） */
  encodeSnapshotRequest(): string | null
}

/** 仅描述原始消息的形态类型，绝不携带负载内容（可能含敏感信息） */
function describeRawShape(raw: unknown): string {
  if (typeof raw === 'string') {
    return `string(${raw.length})`
  }
  if (raw instanceof ArrayBuffer) {
    return `ArrayBuffer(${raw.byteLength})`
  }
  if (ArrayBuffer.isView(raw)) {
    return `TypedArray(${raw.byteLength})`
  }
  if (raw === null) {
    return 'null'
  }
  return typeof raw
}

/**
 * 默认协议适配器：真实 WebSocket 协议映射未提供（TASK-021 WAITING_EXTERNAL）。
 * 对一切消息显式拒绝并说明原因，绝不猜测消息外壳或字段结构；
 * 快照请求同样无法表达（返回 null），数据源退化为等待服务端推送。
 */
export function createUnmappedProtocolAdapter(): WebSocketProtocolAdapter {
  return {
    decode(raw: unknown): ProtocolDecodeResult {
      return {
        ok: false,
        error: new StructuredError({
          code: 'PROTOCOL_UNMAPPED',
          message:
            '真实 WebSocket 协议映射尚未提供（TASK-021），拒绝猜测消息结构；该消息被整条丢弃',
          context: { rawShape: describeRawShape(raw) },
        }),
      }
    },
    encodeSnapshotRequest(): string | null {
      return null
    },
  }
}
