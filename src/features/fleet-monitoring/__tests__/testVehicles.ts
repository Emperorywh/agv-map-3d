/**
 * 车队模型测试夹具助手（仅供 fleet-monitoring 共置测试使用）。
 *
 * 职责：提供与当前 vehicle.json 同构的合法单车原始负载构造器与事件构造器，
 *       测试用覆盖字段表达被测规则；事件一律经 validateVehicle 走生产路径。
 * 边界：不包含任何被测逻辑的复制实现；不做断言。
 */
import { validateVehicle } from '../model/validateVehicle'
import type { VehicleDataEvent } from '../data-source/contract'
import type { VehicleSnapshot } from '../model/types'

/** 与 json/vehicle.json 同构的最小合法单车原始负载 */
export function makeRawVehicle(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    agvKey: 'agv-001',
    agvName: '测试车 001',
    type: 1,
    agvPosition: { x: 100, y: 50, theta: 0, localizationScore: 0.9 },
    agvDimension: {
      length: 1.8,
      width: 0.7,
      loadLength: 1.8,
      loadWidth: 0.7,
      centerOffset: 0.25,
    },
    batteryState: {
      batteryCharge: 80,
      batteryHealth: 100,
      batteryVoltage: 220,
      charging: false,
    },
    connectionState: 'ONLINE',
    dispatchState: 'ENABLE',
    errorEntryList: [],
    loaded: false,
    orderState: 'NONE',
    paused: false,
    vehicleProcStatus: 'IDLE',
    velocity: { vx: 0, vy: 0, omega: 0 },
    createTime: 1787622275389,
    trafficShapeResources: { lockedRectangles: [], applyingRectangles: [] },
    ...overrides,
  }
}

/** 原始负载 → 已校验快照（生产路径） */
export function snapshotOf(
  raw: unknown,
  mapId = 'map-under-test',
): VehicleSnapshot {
  const result = validateVehicle(raw, mapId)
  if (!result.ok) {
    throw new Error(`测试夹具校验失败：${result.reason}`)
  }
  return result.snapshot
}

export function snapshotEvent(
  vehicles: readonly VehicleSnapshot[],
  receivedAt = 1_000,
  sequence = 1,
  mapId = 'map-under-test',
): Extract<VehicleDataEvent, { type: 'snapshot' }> {
  return {
    type: 'snapshot',
    schemaVersion: 'test/1',
    mapId,
    sequence,
    receivedAt,
    vehicles,
  }
}

export function updateEvent(
  vehicle: VehicleSnapshot,
  receivedAt = 1_000,
  sequence = 2,
): Extract<VehicleDataEvent, { type: 'update' }> {
  return {
    type: 'update',
    schemaVersion: 'test/1',
    mapId: vehicle.mapId,
    sequence,
    receivedAt,
    vehicle,
  }
}

export function removeEvent(
  mapId: string,
  agvKey: string,
  receivedAt = 1_000,
): Extract<VehicleDataEvent, { type: 'remove' }> {
  return {
    type: 'remove',
    schemaVersion: 'test/1',
    mapId,
    sequence: 3,
    receivedAt,
    agvKey,
  }
}

export function heartbeatEvent(
  receivedAt = 1_000,
  mapId = 'map-under-test',
): Extract<VehicleDataEvent, { type: 'heartbeat' }> {
  return {
    type: 'heartbeat',
    schemaVersion: 'test/1',
    mapId,
    sequence: 4,
    receivedAt,
  }
}
