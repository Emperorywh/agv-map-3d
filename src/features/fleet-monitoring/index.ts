/**
 * fleet-monitoring Feature 公开入口（SPEC §12.2～§12.4；TASK-006）。
 *
 * 职责：向 app 组合层与协作 Feature（mock-simulation、camera-navigation、
 *       数据源实现）暴露最小稳定合同：归一化事件与数据源接口、经校验的
 *       快照与派生状态类型、实体键编码、高频运行时的只读查询视图类型、
 *       WebSocket 数据源工厂与协议适配边界（TASK-007）、车队运行时 Provider。
 * 边界：外部模块只允许从这里导入本 Feature；内部文件（model/data-source
 *       细分模块）不对 Feature 外暴露。不导出可变实体表、脏集合或 Store
 *       实例——高频运行时由 Provider 在 Feature 内部持有，app 只经 props
 *       注入数据源并组合 Provider（SPEC §12.3/§12.5）。
 * 关键不变量：VehicleSnapshot 与 VehicleDataEvent 是跨 Feature 冻结合同；
 *       实体键恒为 (mapId, agvKey)；只读视图类型不含任何写入通道。
 */
export type {
  HeartbeatEvent,
  RemoveEvent,
  SnapshotEvent,
  SourceStatus,
  Unsubscribe,
  UpdateEvent,
  VehicleDataEvent,
  VehicleDataSource,
} from './data-source/contract'
export type {
  RawTrafficResources,
  StaticVehicleState,
  VehicleAlert,
  VehicleAlertType,
  VehicleBattery,
  VehicleConnectivity,
  VehicleDimension,
  VehicleDisplayState,
  VehicleFreshness,
  VehicleLoadState,
  VehicleOperation,
  VehiclePosition,
  VehiclePrimaryDisplayState,
  VehicleSnapshot,
  VehicleVelocity,
} from './model/types'
export { createVehicleEntityKey, DEFAULT_VEHICLE_DIMENSION } from './model/types'
export { validateVehicle } from './model/validateVehicle'
export type { ValidateVehicleResult, VehicleInvalidReason } from './model/validateVehicle'
export {
  BATTERY_NORMAL_THRESHOLD,
  deriveVehicleState,
  LOW_BATTERY_THRESHOLD,
  LOW_LOCALIZATION_THRESHOLD,
  projectDisplayState,
} from './model/deriveVehicleState'
export { DEFAULT_STALE_AFTER_MS } from './model/createFleetRuntime'
export type { DirtyBatch, FleetDiff, ReadonlyFleetEntity, ReadonlyFleetRuntime } from './model/createFleetRuntime'
export { FleetRuntimeProvider } from './components/FleetRuntimeProvider'
export { FleetMonitoringFeature } from './components/FleetMonitoringFeature'
export type { FleetMonitoringFeatureProps } from './components/FleetMonitoringFeature'
export { SLOT_BATCH_CAPACITY, SLOT_CAPACITY_STEP, SLOT_HARD_CAP } from './model/instanceSlots'
export type { VehicleSlot } from './model/instanceSlots'
export {
  computeVehiclePartLayout,
  computeVehicleWorldPose,
  createVehicleResources,
  INSTANCE_COLOR_PARTS,
  VEHICLE_PART_KINDS,
} from './scene/createVehicleGeometry'
export type {
  PartPlacement,
  VehiclePartKind,
  VehiclePartLayout,
  VehicleResources,
  VehicleWorldPose,
} from './scene/createVehicleGeometry'
export { shellColorOf } from './scene/fleetAppearance'
export {
  WS_MAX_CONSECUTIVE_DECODE_FAILURES,
  WS_READY_STATE_CONNECTING,
  WS_READY_STATE_OPEN,
  WS_RECONNECT_BASE_MS,
  WS_RECONNECT_MAX_MS,
  WS_SILENT_AFTER_MS,
  WS_STABLE_RESET_MS,
  createWebSocketVehicleDataSource,
} from './data-source/websocket/WebSocketVehicleDataSource'
export type {
  WebSocketDataSourceOptions,
  WebSocketFactory,
  WebSocketLike,
} from './data-source/websocket/WebSocketVehicleDataSource'
export { createUnmappedProtocolAdapter } from './data-source/websocket/protocolAdapter'
export type {
  NormalizedVehicleMessage,
  ProtocolDecodeResult,
  ProtocolErrorCode,
  WebSocketProtocolAdapter,
} from './data-source/websocket/protocolAdapter'
