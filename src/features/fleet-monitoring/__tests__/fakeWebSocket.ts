/**
 * WebSocket 数据源测试夹具（仅供 fleet-monitoring 共置测试使用）。
 *
 * 职责：提供可控的 FakeWebSocket（手动触发 open/message/异常断开并记录
 *       发送帧）与 createTestProtocolAdapter（把测试 JSON 信封映射为归一化
 *       消息，复用生产 validateVehicle 路径）。
 * 边界：不包含任何被测逻辑的复制实现；测试专属协议外壳只存在于本夹具，
 *       不代表真实协议（真实映射属 TASK-021）。
 */
import { isFiniteNumber, isPlainObject } from '@/shared/validation'
import { StructuredError } from '@/shared/diagnostics'
import {
  WS_READY_STATE_CONNECTING,
  WS_READY_STATE_OPEN,
  type WebSocketFactory,
  type WebSocketLike,
} from '../data-source/websocket/WebSocketVehicleDataSource'
import type {
  ProtocolDecodeResult,
  ProtocolErrorCode,
  WebSocketProtocolAdapter,
} from '../data-source/websocket/protocolAdapter'
import { validateVehicle } from '../model/validateVehicle'
import type { VehicleSnapshot } from '../model/types'

/** 受控假 WebSocket：测试手动驱动生命周期与消息 */
export class FakeWebSocket implements WebSocketLike {
  readonly url: string
  readyState = WS_READY_STATE_CONNECTING
  /** send 收到的全部帧（快照请求断言用） */
  readonly sent: string[] = []
  /** close 收到的参数；null 表示尚未被主动关闭 */
  closedWith: { readonly code?: number; readonly reason?: string } | null = null
  onopen: (() => void) | null = null
  onclose: ((event?: { readonly code?: number; readonly reason?: string }) => void) | null = null
  onerror: ((event?: unknown) => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null

  constructor(url: string) {
    this.url = url
  }

  /** 模拟连接建立成功 */
  open(): void {
    this.readyState = WS_READY_STATE_OPEN
    this.onopen?.()
  }

  /** 模拟服务端下发一条消息（data 原样递给数据源） */
  serverMessage(data: unknown): void {
    this.onmessage?.({ data })
  }

  send(data: string): void {
    this.sent.push(data)
  }

  /** 模拟协议层主动关闭（close 握手） */
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) {
      return
    }
    this.readyState = 3
    this.closedWith = { code, reason }
    this.onclose?.({ code, reason })
  }

  /** 模拟网络层异常断开（无 close 握手，先 error 后 close） */
  drop(code = 1006): void {
    this.readyState = 3
    this.onerror?.(new Error('模拟网络异常'))
    this.onclose?.({ code })
  }
}

/** 收集型工厂：记录创建顺序，供「当前连接」与代次断言使用 */
export function createFakeSocketFactory(): {
  factory: WebSocketFactory
  sockets: FakeWebSocket[]
  current: () => FakeWebSocket
} {
  const sockets: FakeWebSocket[] = []
  return {
    sockets,
    factory: (url) => {
      const socket = new FakeWebSocket(url)
      sockets.push(socket)
      return socket
    },
    current: () => sockets[sockets.length - 1]!,
  }
}

function protocolError(code: ProtocolErrorCode, message: string, context: Record<string, unknown>): ProtocolDecodeResult {
  const error = new StructuredError({ code, message, context })
  return { ok: false, error }
}

/**
 * 测试协议适配器：JSON 信封 { type, schemaVersion?, sequence, ... }。
 * 外壳/版本/序号/字段校验的裁决路径与 SPEC §3.2 对适配边界的要求一致；
 * 车辆负载复用生产 validateVehicle（单车隔离语义）。
 */
export function createTestProtocolAdapter(mapId: string): WebSocketProtocolAdapter {
  const decode = (raw: unknown): ProtocolDecodeResult => {
    if (typeof raw !== 'string') {
      return protocolError('PROTOCOL_MESSAGE_SHELL', '消息帧不是字符串', {
        rawShape: typeof raw,
      })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return protocolError('PROTOCOL_JSON_PARSE', '消息帧不是合法 JSON', {})
    }
    if (!isPlainObject(parsed)) {
      return protocolError('PROTOCOL_MESSAGE_SHELL', '消息外壳不是对象', {})
    }
    const type = parsed['type']
    const sequence = parsed['sequence']
    const schemaVersion =
      typeof parsed['schemaVersion'] === 'string' ? parsed['schemaVersion'] : 'test/1'
    if (!isFiniteNumber(sequence) || !Number.isInteger(sequence) || sequence < 0) {
      return protocolError('PROTOCOL_SEQUENCE_INVALID', '序号缺失或非法', {
        sequence,
      })
    }
    switch (type) {
      case 'snapshot': {
        const rawVehicles = parsed['vehicles']
        if (!Array.isArray(rawVehicles)) {
          return protocolError('PROTOCOL_FIELD', 'snapshot 缺少 vehicles 数组', {
            type,
          })
        }
        const vehicles: VehicleSnapshot[] = []
        for (const entry of rawVehicles) {
          const result = validateVehicle(entry, mapId)
          if (result.ok) {
            vehicles.push(result.snapshot)
          }
        }
        // 全部条目被隔离：快照不携带任何可信信息，整条拒绝（防误删全队）
        if (rawVehicles.length > 0 && vehicles.length === 0) {
          return protocolError('PROTOCOL_VEHICLE_INVALID', '快照内全部车辆条目非法', {
            count: rawVehicles.length,
          })
        }
        return { ok: true, message: { type: 'snapshot', schemaVersion, sequence, vehicles } }
      }
      case 'update': {
        const result = validateVehicle(parsed['vehicle'], mapId)
        if (!result.ok) {
          return protocolError('PROTOCOL_VEHICLE_INVALID', '增量负载整车拒绝', {
            reason: result.reason,
          })
        }
        return { ok: true, message: { type: 'update', schemaVersion, sequence, vehicle: result.snapshot } }
      }
      case 'remove': {
        const agvKey = parsed['agvKey']
        if (typeof agvKey !== 'string' || agvKey.length === 0) {
          return protocolError('PROTOCOL_FIELD', 'remove 缺少 agvKey', { type })
        }
        return { ok: true, message: { type: 'remove', schemaVersion, sequence, agvKey } }
      }
      case 'heartbeat':
        return { ok: true, message: { type: 'heartbeat', schemaVersion, sequence } }
      default:
        return protocolError('PROTOCOL_MESSAGE_SHELL', '未知消息类型', { type })
    }
  }
  return {
    decode,
    encodeSnapshotRequest: () => JSON.stringify({ type: 'snapshotRequest' }),
  }
}
