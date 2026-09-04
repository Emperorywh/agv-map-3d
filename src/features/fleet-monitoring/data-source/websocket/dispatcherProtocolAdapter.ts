/**
 * 调度系统 getDispatcherMonitor WebSocket 协议适配器（TASK-021 真实映射）。
 *
 * 协议事实（源自调度系统前端实现的线上行为，单车负载样例见仓库根
 * json/vehicle.json 真实抓包夹具）：
 * - 订阅方式：连接打开后客户端向服务端发送地图 ID 的「裸字符串帧」（非 JSON），
 *   服务端据此开始推送该地图的调度监控数据；
 * - 消息形态：服务端持续推送 JSON 全量快照 `{ vehicles: [...], orderRecords:
 *   [...] }`——无消息类型字段、无序号字段，每条消息都是当前地图的全量车队
 *   基线（缺席车辆即已离场）；orderRecords 前端不消费，此处同样忽略；
 * - 单车负载：agvKey / agvName / type / agvPosition{x,y,theta,localizationScore}
 *   / agvDimension / batteryState / velocity / connectionState / dispatchState /
 *   orderState / vehicleProcStatus / loaded / paused / errorEntryList /
 *   trafficShapeResources / createTime，字段级裁决全部复用 model/validateVehicle。
 * 边界：JSON 解析、外壳校验、逐车隔离校验与订阅帧构造全部收敛在本适配器内，
 *       不侵入数据源状态机与车辆运行时；协议无序号，适配器以内部计数器合成
 *       严格递增 sequence（同一连接内单调，满足序号治理）。
 * 关键不变量：
 * 1. decode 绝不抛出异常：解析/外壳失败以稳定错误码返回（PROTOCOL_JSON_PARSE /
 *    PROTOCOL_MESSAGE_SHELL），单车字段异常只隔离该车（采样上报），不拖垮整帧；
 * 2. 地图上下文未绑定（TASK-017 并行初始化）时无法打实体键：整帧暂不产出，
 *    以心跳消息维持通道活跃语义（喂静默看门狗、通过序号治理、不消耗解码失败
 *    预算）；监控流为持续推送，绑定落地后的下一帧即建立全量基线；
 * 3. encodeSnapshotRequest 在上下文未绑定时返回 null（无法构造订阅帧），绑定
 *    落地后返回裸地图 ID——数据源在连接打开与绑定落地两个时机都会尝试发送；
 * 4. 全量快照语义：每条消息映射为 snapshot 事件（非 update），缺席车辆由
 *    fleet runtime 的快照归并按删除处理。
 */
import { isPlainObject } from '@/shared/validation'
import { StructuredError, type DiagnosticsReporter } from '@/shared/diagnostics'
import { validateVehicle } from '../../model/validateVehicle'
import type { VehicleSnapshot } from '../../model/types'
import type {
  ProtocolDecodeResult,
  WebSocketProtocolAdapter,
} from './protocolAdapter'

/** 归一化消息的协议版本标识（适配器自我描述，服务端无此字段） */
export const DISPATCHER_PROTOCOL_SCHEMA_VERSION = 'dispatcher-monitor/1'

export interface DispatcherProtocolAdapterOptions {
  /**
   * 地图上下文：订阅帧与实体键的 mapId 来源。与 WS 数据源共用同一
   * string | Promise<string> 形态（TASK-017 并行初始化）——promise 被拒绝时
   * 数据源会进入 ERROR 终态，本适配器保持未绑定即可，无需额外恢复。
   */
  mapId: string | Promise<string>
  /** 结构化诊断通道；缺省时仅构造、不上报 */
  diagnostics?: DiagnosticsReporter
}

/**
 * 创建调度监控协议适配器。
 * 返回对象满足 WebSocketProtocolAdapter 合同：decode 不抛异常、失败携带稳定
 * 错误码；订阅帧在地图上下文绑定前无法表达（返回 null）。
 */
export function createDispatcherProtocolAdapter(
  options: DispatcherProtocolAdapterOptions,
): WebSocketProtocolAdapter {
  /** 已绑定的地图上下文；null 表示延迟绑定尚未落地 */
  let boundMapId: string | null =
    typeof options.mapId === 'string' ? options.mapId : null
  /** 合成序号：协议无序号字段，按本地受理顺序合成严格递增值 */
  let sequence = 0
  const diagnostics = options.diagnostics

  if (boundMapId === null) {
    void (options.mapId as Promise<string>).then(
      (resolved) => {
        boundMapId = resolved
      },
      (error: unknown) => {
        // 绑定拒绝由数据源的同一 promise 消费方进入 ERROR 终态；此处只留采样诊断
        diagnostics?.report(
          'WS_MAP_CONTEXT_FAILED',
          'warn',
          '协议适配器的地图上下文绑定失败，订阅帧与解码保持不可用',
          { reason: error instanceof Error ? error.message : String(error) },
        )
      },
    )
  }

  /** 解析并校验消息外壳：字符串帧 → JSON 对象 → vehicles 数组 */
  type ParsedFrame =
    | { readonly ok: false; readonly error: StructuredError }
    | { readonly ok: true; readonly vehicles: unknown[] }

  const parseFrame = (raw: unknown): ParsedFrame => {
    if (typeof raw !== 'string') {
      return {
        ok: false,
        error: new StructuredError({
          code: 'PROTOCOL_MESSAGE_SHELL',
          message: '调度监控协议只接受 JSON 文本帧，该消息被整条丢弃',
          context: {},
        }),
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return {
        ok: false,
        error: new StructuredError({
          code: 'PROTOCOL_JSON_PARSE',
          message: '调度监控消息不是合法 JSON，该消息被整条丢弃',
          context: { reason: error instanceof Error ? error.message : String(error) },
        }),
      }
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed['vehicles'])) {
      return {
        ok: false,
        error: new StructuredError({
          code: 'PROTOCOL_MESSAGE_SHELL',
          message: '调度监控消息缺少 vehicles 数组，无法识别为全量快照，该消息被整条丢弃',
          context: {},
        }),
      }
    }
    return { ok: true, vehicles: parsed['vehicles'] as unknown[] }
  }

  return {
    decode(raw: unknown): ProtocolDecodeResult {
      const parsed = parseFrame(raw)
      if (!parsed.ok) {
        return { ok: false, error: parsed.error }
      }
      if (boundMapId === null) {
        // 地图上下文未绑定：车辆负载无法打实体键，整帧暂不产出。以心跳维持
        // 通道活跃语义——数据源的静默看门狗被喂住、序号治理通过、解码失败
        // 预算不消耗；绑定落地后的下一帧推送即建立全量基线（持续推送流）。
        sequence += 1
        return {
          ok: true,
          message: {
            type: 'heartbeat',
            schemaVersion: DISPATCHER_PROTOCOL_SCHEMA_VERSION,
            sequence,
          },
        }
      }
      // 逐车隔离校验：单车负载异常只丢弃该车，不影响同帧其他车辆
      const vehicles: VehicleSnapshot[] = []
      let rejected = 0
      for (const item of parsed.vehicles) {
        const result = validateVehicle(item, boundMapId)
        if (result.ok) {
          vehicles.push(result.snapshot)
        } else {
          rejected += 1
        }
      }
      if (rejected > 0) {
        diagnostics?.report(
          'WS_VEHICLE_REJECTED',
          'warn',
          '快照内部分车辆负载无法锚定实体，已隔离丢弃',
          { rejected, accepted: vehicles.length },
        )
      }
      sequence += 1
      return {
        ok: true,
        message: {
          type: 'snapshot',
          schemaVersion: DISPATCHER_PROTOCOL_SCHEMA_VERSION,
          sequence,
          vehicles,
        },
      }
    },

    encodeSnapshotRequest(): string | null {
      if (boundMapId === null) {
        // 上下文未落地无法构造订阅帧：等待绑定（数据源在绑定落地后会补发）
        return null
      }
      // 协议订阅帧是地图 ID 的裸字符串（非 JSON）——与调度系统前端行为一致
      return boundMapId
    },
  }
}
