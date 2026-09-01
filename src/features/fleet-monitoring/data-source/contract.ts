/**
 * VehicleDataSource 公开合同（SPEC §3.1、§12.2～§12.4；TASK-006）。
 *
 * 职责：定义 Mock 与 WebSocket 必须共同输出的归一化事件模型（snapshot /
 *       update / remove / heartbeat 四类显式事件）、数据源生命周期接口与
 *       连接状态枚举。本合同是 fleet-monitoring 对 mock-simulation 与
 *       数据源实现暴露的最小稳定边界。
 * 边界：只声明类型合同，不含任何实现；协议适配、重连、序号管理属
 *       data-source/websocket（TASK-007）与 mock-simulation（TASK-008/009）。
 *       事件携带的 VehicleSnapshot 已由生产方完成单车校验与 mapId 补全。
 * 关键不变量：
 * 1. 事件类型、序号与删除语义全部显式：删除是独立的 remove 事件，禁止由
 *    数组长度或空值隐式推断（SPEC §3.1 注释约束）；
 * 2. receivedAt 是数据源在发出时刻打上的本地单调时钟时间（performance.now()
 *    口径），新鲜度计算只依赖它，不依赖服务端时间戳；
 * 3. connect/disconnect 必须幂等、可承受 StrictMode 重复挂载；手动断开不
 *    自动重连（约束写进合同注释，由 TASK-007/009 的实现与测试兑现）；
 * 4. 同一数据源实例绑定单一 mapId 上下文：跨地图不得复用实体键（SPEC §2.4）。
 */
import type { VehicleSnapshot } from '../model/types'

/** 快照事件：当前地图的全量车队基线；缺失实体按删除处理（由消费方 diff） */
export interface SnapshotEvent {
  readonly type: 'snapshot'
  readonly schemaVersion: string
  readonly mapId: string
  readonly sequence: number
  readonly receivedAt: number
  readonly vehicles: readonly VehicleSnapshot[]
}

/** 增量事件：单车上报；不得隐式删除其他车辆（SPEC §3.2） */
export interface UpdateEvent {
  readonly type: 'update'
  readonly schemaVersion: string
  readonly mapId: string
  readonly sequence: number
  readonly receivedAt: number
  readonly vehicle: VehicleSnapshot
}

/** 删除事件：只删除指定 agvKey；对不存在的键幂等 */
export interface RemoveEvent {
  readonly type: 'remove'
  readonly schemaVersion: string
  readonly mapId: string
  readonly sequence: number
  readonly receivedAt: number
  readonly agvKey: string
}

/** 心跳事件：仅表明数据通道存活；不刷新任何单车的数据新鲜度 */
export interface HeartbeatEvent {
  readonly type: 'heartbeat'
  readonly schemaVersion: string
  readonly mapId: string
  readonly sequence: number
  readonly receivedAt: number
}

export type VehicleDataEvent =
  | SnapshotEvent
  | UpdateEvent
  | RemoveEvent
  | HeartbeatEvent

export type SourceStatus =
  | 'IDLE'
  | 'CONNECTING'
  | 'OPEN'
  | 'RECONNECTING'
  | 'CLOSED'
  | 'ERROR'

/** 订阅退订句柄：重复调用必须幂等 */
export type Unsubscribe = () => void

/**
 * 数据源生命周期合同。
 * connect 与 disconnect 必须幂等，能够承受 React 开发模式下的重复挂载；
 * 手动断开不会自动重连，网络异常断开才进入重连状态（SPEC §3.1）。
 */
export interface VehicleDataSource {
  connect(signal?: AbortSignal): Promise<void>
  disconnect(): void
  /** 请求一次全量快照（重连对齐与 Mock 主动请求共用） */
  requestSnapshot(): void
  readonly status: SourceStatus
  onEvent(cb: (event: VehicleDataEvent) => void): Unsubscribe
  onStatusChange(cb: (status: SourceStatus) => void): Unsubscribe
}
