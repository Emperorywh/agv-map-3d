/**
 * Mock 数据源 × 当前真实地图集成测试（TASK-009；SPEC §9.3、§10.3；E1～E3）。
 *
 * 职责：从当前 json/map.json 驱动 MockVehicleDataSource 全链路（内核推进 →
 *       场景时间线 → 统一校验 → 归一化事件），并锁定当前输入下的验收事实：
 *       默认 60 台覆盖真实拓扑、120s 窗口内确定覆盖全部验收事件、两次运行
 *       事件序列逐位一致、250 台压力规模可用。输入变化时直接更新期望值。
 * 关键不变量：
 * 1. 事件内容经 fleet-monitoring 公开的 validateVehicle 同一校验路径产出，
 *    全部快照不可变且 entityKey 与地图 mapId 绑定；
 * 2. 固定 seed + 注入时钟/随机源下，事件序列（含 receivedAt）完全可复现；
 * 3. 车辆位置恒为有限值且落在当前地图坐标范围内。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMapModel, validateMap } from '@/features/map-visualization'
import { createDiagnosticsReporter } from '@/shared/diagnostics'
import {
  createMockVehicleDataSource,
  type MockVehicleDataSource,
} from '@/features/mock-simulation'
import type { VehicleDataEvent } from '@/features/fleet-monitoring'

const MAP_JSON_PATH = path.resolve(process.cwd(), 'json/map.json')
const RAW_MAP: unknown = JSON.parse(readFileSync(MAP_JSON_PATH, 'utf8'))
const MODEL = createMapModel(validateMap(RAW_MAP)).mapModel

const MAP_BOUNDS = (() => {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const node of MODEL.nodeList) {
    minX = Math.min(minX, node.x)
    minY = Math.min(minY, node.y)
    maxX = Math.max(maxX, node.x)
    maxY = Math.max(maxY, node.y)
  }
  return { minX, minY, maxX, maxY }
})()

function createSource(vehicleCount = 60): {
  source: MockVehicleDataSource
  events: VehicleDataEvent[]
} {
  const events: VehicleDataEvent[] = []
  const source = createMockVehicleDataSource({
    mapModel: MODEL,
    vehicleCount,
    now: () => Date.now(),
    random: () => 0.5,
    diagnostics: createDiagnosticsReporter({ sink: () => {} }),
  })
  source.onEvent((event) => events.push(event))
  return { source, events }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('真实地图上的 Mock 数据源', () => {
  it('默认 60 台：快照全量校验通过，位置落在当前地图坐标范围内', async () => {
    const { source, events } = createSource()
    await source.connect()
    const snapshot = events[0]
    if (snapshot.type !== 'snapshot') {
      throw new Error('首个事件应为 snapshot')
    }
    expect(snapshot.vehicles).toHaveLength(60)
    expect(snapshot.mapId).toBe(MODEL.mapId)
    for (const vehicle of snapshot.vehicles) {
      expect(Object.isFrozen(vehicle)).toBe(true)
      expect(vehicle.positionValid).toBe(true)
      expect(vehicle.position.x).toBeGreaterThanOrEqual(MAP_BOUNDS.minX)
      expect(vehicle.position.x).toBeLessThanOrEqual(MAP_BOUNDS.maxX)
      expect(vehicle.position.y).toBeGreaterThanOrEqual(MAP_BOUNDS.minY)
      expect(vehicle.position.y).toBeLessThanOrEqual(MAP_BOUNDS.maxY)
    }
    source.disconnect()
  })

  it('200s 内确定覆盖全部验收事件（E3），车辆位置始终有限', async () => {
    // 充电时序说明（当前输入 + 默认 seed）：低电车 1s 内触发寻充，沿有向
    // 路径行驶约 171s 后到站充电——首次 charging 出现在约 172s 仿真时间，
    // 因此本窗口取 200s；输入变化时直接更新该窗口与期望。
    const { source, events } = createSource()
    await source.connect()
    await vi.advanceTimersByTimeAsync(200_000)
    source.disconnect()

    const seen = {
      processing: false,
      faultOn: false,
      faultOff: false,
      offline: false,
      paused: false,
      traffic: false,
      lowLocalization: false,
      charging: false,
      remove: false,
      added: false,
    }
    for (const event of events) {
      if (event.type === 'remove' && event.agvKey === 'mock-agv-0060') {
        seen.remove = true
      }
      if (event.type === 'update' && event.vehicle.agvKey === 'mock-agv-0061') {
        seen.added = true
      }
      if (event.type !== 'update') {
        continue
      }
      const vehicle = event.vehicle
      expect(Number.isFinite(vehicle.position.x)).toBe(true)
      expect(Number.isFinite(vehicle.position.y)).toBe(true)
      if (vehicle.agvKey === 'mock-agv-0011' && vehicle.orderState === 'PROCESSING') {
        seen.processing = true
      }
      if (vehicle.agvKey === 'mock-agv-0012') {
        if (vehicle.rawErrorEntries.length > 0) {
          seen.faultOn = true
        } else if (seen.faultOn) {
          seen.faultOff = true
        }
      }
      if (vehicle.agvKey === 'mock-agv-0013' && vehicle.connectionState === 'OFFLINE') {
        seen.offline = true
      }
      if (vehicle.agvKey === 'mock-agv-0014' && vehicle.paused) {
        seen.paused = true
      }
      if (vehicle.agvKey === 'mock-agv-0015' && vehicle.vehicleProcStatus === 'TRAFFIC') {
        seen.traffic = true
      }
      if (vehicle.agvKey === 'mock-agv-0016' && vehicle.position.localizationScore === 0.3) {
        seen.lowLocalization = true
      }
      if (vehicle.battery.charging) {
        seen.charging = true
      }
    }
    expect(seen).toEqual({
      processing: true,
      faultOn: true,
      faultOff: true,
      offline: true,
      paused: true,
      traffic: true,
      lowLocalization: true,
      charging: true,
      remove: true,
      added: true,
    })
    // 删一增一后车队规模守恒
    expect(source.devControl.getVehicleCount()).toBe(60)
  })

  it('固定 seed 完整时间线重复一致（E1）：两次运行事件序列逐位一致', async () => {
    const a = createSource()
    const b = createSource()
    await a.source.connect()
    await b.source.connect()
    await vi.advanceTimersByTimeAsync(130_000)
    a.source.disconnect()
    b.source.disconnect()
    expect(a.events.length).toBe(b.events.length)
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events))
  })

  it('250 台压力规模：快照与增量流可用（可调至 250 台，SPEC §9.3）', async () => {
    const { source, events } = createSource(250)
    await source.connect()
    const snapshot = events[0]
    if (snapshot.type !== 'snapshot') {
      throw new Error('首个事件应为 snapshot')
    }
    expect(snapshot.vehicles).toHaveLength(250)
    await vi.advanceTimersByTimeAsync(2000)
    const updates = events.filter((event) => event.type === 'update')
    expect(updates.length).toBeGreaterThan(250)
    source.disconnect()
  })
})
