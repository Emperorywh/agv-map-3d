/*
 * Mock 车辆数据源测试（TASK-009 / SPEC §3.1、§9.3、§11.6；E1）。
 *
 * 覆盖：connect/disconnect/requestSnapshot 幂等与完整状态机、首连全量快照、
 *       2Hz 基频 ±50% 抖动、心跳、确定性时间线重复一致与不同种子不同、
 *       暂停不积累位移、验收场景事件覆盖（接单/完成、故障/恢复、掉线/恢复、
 *       暂停、交通等待+有效矩形、低定位、充电、增删车）、开发控制（车队规模、
 *       复位、场景开关）、AbortSignal、StrictMode 式快速重连与订阅者异常隔离。
 * 手法：vi.useFakeTimers 驱动自调度计时链；时钟注入 Date.now（fake timers 同
 *       步模拟）；随机源注入固定值锁定抖动间隔。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDiagnosticsReporter,
  type DiagnosticRecord,
} from '@/shared/diagnostics'
import {
  createMockVehicleDataSource,
  MOCK_SCHEMA_VERSION,
  type MockVehicleDataSource,
} from '@/features/mock-simulation/data-source/MockVehicleDataSource'
import type { VehicleDataEvent } from '@/features/fleet-monitoring'
import { buildModel, makeLineEdge, makeNode } from './fixtures'

/** 有向充电环 W→C→W2→W：含 charge 节点，可验证确定性充电循环 */
function buildChargeCycle() {
  return buildModel({
    nodes: [
      makeNode({ id: 'w', name: 'W', x: 0, y: 0 }),
      makeNode({ id: 'c', name: 'C', type: 'charge', x: 10, y: 0 }),
      makeNode({ id: 'w2', name: 'W2', x: 10, y: 10 }),
    ],
    edges: [
      makeLineEdge({ id: 'e-w-c', sx: 0, sy: 0, ex: 10, ey: 0, snodeId: 'w', enodeId: 'c' }),
      makeLineEdge({ id: 'e-c-w2', sx: 10, sy: 0, ex: 10, ey: 10, snodeId: 'c', enodeId: 'w2' }),
      makeLineEdge({ id: 'e-w2-w', sx: 10, sy: 10, ex: 0, ey: 0, snodeId: 'w2', enodeId: 'w' }),
    ],
  })
}

interface Harness {
  source: MockVehicleDataSource
  events: VehicleDataEvent[]
  statuses: string[]
  diagnostics: DiagnosticRecord[]
  map: ReturnType<typeof buildChargeCycle>
}

function setup(overrides: Record<string, unknown> = {}): Harness {
  const events: VehicleDataEvent[] = []
  const statuses: string[] = []
  const diagnostics: DiagnosticRecord[] = []
  const source = createMockVehicleDataSource({
    mapModel: buildChargeCycle(),
    now: () => Date.now(),
    random: () => 0.5, // 抖动系数 1.0 → 间隔恰为 500ms
    diagnostics: createDiagnosticsReporter({
      sink: (record) => diagnostics.push(record),
    }),
    ...overrides,
  }) as MockVehicleDataSource
  source.onEvent((event) => events.push(event))
  source.onStatusChange((status) => statuses.push(status))
  return { source, events, statuses, diagnostics, map: buildChargeCycle() }
}

/** 推进 fake timers（每个 tick 自调度下一个 500ms 计时器） */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('连接生命周期与四类事件', () => {
  it('connect：IDLE→CONNECTING→OPEN，首连发布 60 台全量快照（序号 1）', async () => {
    const h = setup()
    expect(h.source.status).toBe('IDLE')
    await h.source.connect()
    expect(h.statuses).toEqual(['CONNECTING', 'OPEN'])
    expect(h.source.status).toBe('OPEN')

    const snapshot = h.events[0]
    expect(snapshot.type).toBe('snapshot')
    if (snapshot.type !== 'snapshot') {
      return
    }
    expect(snapshot.vehicles).toHaveLength(60)
    expect(snapshot.schemaVersion).toBe(MOCK_SCHEMA_VERSION)
    expect(snapshot.sequence).toBe(1)
    expect(snapshot.mapId).toBe(h.map.mapId)
    expect(snapshot.vehicles[0].entityKey).toContain(h.map.mapId)
    // 快照由统一校验路径产出：不可变
    expect(Object.isFrozen(snapshot.vehicles[0])).toBe(true)
    h.source.disconnect()
  })

  it('connect 幂等：重复 connect 只产生一份基线快照', async () => {
    const h = setup()
    await h.source.connect()
    await h.source.connect()
    await h.source.connect()
    expect(h.events).toHaveLength(1)
    h.source.disconnect()
  })

  it('推进后 update 持续到达，四类事件共用严格递增序号', async () => {
    const h = setup()
    await h.source.connect()
    await advance(2000) // 4 个 500ms tick
    const updates = h.events.filter((event) => event.type === 'update')
    expect(updates.length).toBeGreaterThan(0)
    for (let i = 1; i < h.events.length; i += 1) {
      expect(h.events[i].sequence).toBe(h.events[i - 1].sequence + 1)
    }
    h.source.disconnect()
  })

  it('心跳按仿真时间 5s 间隔出现', async () => {
    const h = setup()
    await h.source.connect()
    await advance(5000)
    const heartbeats = h.events.filter((event) => event.type === 'heartbeat')
    expect(heartbeats.length).toBeGreaterThanOrEqual(1)
    h.source.disconnect()
  })

  it('requestSnapshot：非 OPEN 为无操作，OPEN 每次发布当前全量', async () => {
    const h = setup()
    h.source.requestSnapshot()
    expect(h.events).toHaveLength(0)
    await h.source.connect()
    h.source.requestSnapshot()
    const snapshots = h.events.filter((event) => event.type === 'snapshot')
    expect(snapshots).toHaveLength(2)
    const again = snapshots[1]
    if (again.type === 'snapshot') {
      expect(again.vehicles).toHaveLength(60)
      expect(again.sequence).toBe(2)
    }
    h.source.disconnect()
    h.source.requestSnapshot()
    expect(h.events.filter((event) => event.type === 'snapshot')).toHaveLength(2)
  })

  it('disconnect：CLOSED 终态、计时链清理、绝不自动重连；可再次 connect', async () => {
    const h = setup()
    await h.source.connect()
    h.source.disconnect()
    expect(h.source.status).toBe('CLOSED')
    const countAtDisconnect = h.events.length
    await advance(5000)
    expect(h.events).toHaveLength(countAtDisconnect)

    await h.source.connect()
    expect(h.source.status).toBe('OPEN')
    expect(h.statuses).toEqual(['CONNECTING', 'OPEN', 'CLOSED', 'CONNECTING', 'OPEN'])
    // 重连以新快照重新对齐（车队状态延续）
    const last = h.events[h.events.length - 1]
    expect(last.type).toBe('snapshot')
    h.source.disconnect()
  })

  it('StrictMode 式快速断开重连：事件不重复应用、状态机完整', async () => {
    const h = setup()
    await h.source.connect()
    h.source.disconnect()
    await h.source.connect()
    h.source.disconnect()
    await h.source.connect()
    await advance(1000)
    const snapshots = h.events.filter((event) => event.type === 'snapshot')
    expect(snapshots).toHaveLength(3)
    // 每次只有一条活跃计时链：断开后不再产生事件
    h.source.disconnect()
    const before = h.events.length
    await advance(3000)
    expect(h.events).toHaveLength(before)
  })

  it('AbortSignal：连接前中止拒绝 AbortError；OPEN 后中止拆除会话', async () => {
    const controller = new AbortController()
    controller.abort()
    const h = setup()
    await expect(h.source.connect(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(h.source.status).toBe('IDLE')

    const controller2 = new AbortController()
    const source2 = setup().source
    await source2.connect(controller2.signal)
    controller2.abort()
    expect(source2.status).toBe('IDLE')
    const count = h.events.length
    await advance(2000)
    expect(h.events).toHaveLength(count)
    source2.disconnect()
    h.source.disconnect()
  })

  it('订阅者异常被隔离：后续订阅者照常收到事件，诊断采样记录', async () => {
    const h = setup()
    const received: number[] = []
    const unsubscribe = h.source.onEvent(() => {
      received.push(1)
      throw new Error('订阅者故障')
    })
    await h.source.connect()
    expect(received.length).toBeGreaterThan(0)
    expect(h.diagnostics.map((record) => record.code)).toContain(
      'MOCK_SUBSCRIBER_ERROR',
    )
    unsubscribe()
    h.source.disconnect()
  })
})

describe('推送节奏（2Hz ±50% 抖动）', () => {
  it('随机系数 0 → 间隔 250ms（下界）', async () => {
    const h = setup({ random: () => 0 })
    await h.source.connect()
    await advance(249)
    expect(h.events.filter((event) => event.type === 'update')).toHaveLength(0)
    await advance(1)
    expect(h.events.filter((event) => event.type === 'update').length).toBeGreaterThan(0)
    h.source.disconnect()
  })

  it('随机系数趋近 1 → 间隔趋近 750ms（上界）', async () => {
    let call = 0
    const h = setup({
      random: () => {
        call += 1
        return call === 1 ? 0.5 : 0.999999 // 首个延迟 500ms，其后 ≈750ms
      },
    })
    await h.source.connect()
    await advance(500) // 第一次 tick
    const countAfterFirst = h.events.filter((event) => event.type === 'update').length
    expect(countAfterFirst).toBeGreaterThan(0)
    await advance(730) // 距上界尚有约 20ms（避开运行时延迟取整）
    expect(h.events.filter((event) => event.type === 'update')).toHaveLength(countAfterFirst)
    await advance(50)
    expect(h.events.filter((event) => event.type === 'update').length).toBeGreaterThan(
      countAfterFirst,
    )
    h.source.disconnect()
  })
})

describe('暂停不积累位移', () => {
  it('暂停期间无事件、仿真时钟冻结；恢复后首步位移不超过一个周期', async () => {
    const h = setup()
    await h.source.connect()
    await advance(2000)
    h.source.devControl.setPaused(true)
    expect(h.source.devControl.isPaused()).toBe(true)

    const lastUpdate = [...h.events].reverse().find((event) => event.type === 'update')
    if (lastUpdate?.type !== 'update') {
      throw new Error('暂停前应有 update 事件')
    }
    const pausedPosition = lastUpdate.vehicle.position
    const statsAtPause = h.source.devControl.getStats()
    const eventCountAtPause = h.events.length

    await advance(10000) // 暂停 10s
    expect(h.source.devControl.getStats().simTimeSeconds).toBe(
      statsAtPause.simTimeSeconds,
    )
    // 暂停期间不发布任何数据事件
    expect(h.events).toHaveLength(eventCountAtPause)

    h.source.devControl.setPaused(false)
    await advance(500)
    expect(h.events.length).toBeGreaterThan(eventCountAtPause)
    const resumed = [...h.events].reverse().find((event) => event.type === 'update')
    if (resumed?.type !== 'update') {
      throw new Error('恢复后应有 update 事件')
    }
    // 只推进一个普通周期（≤0.5s × ≤1.5m/s ≈ 0.75m），绝不补走暂停期间的 10s
    const jump = Math.hypot(
      resumed.vehicle.position.x - pausedPosition.x,
      resumed.vehicle.position.y - pausedPosition.y,
    )
    expect(jump).toBeLessThan(2)
    h.source.disconnect()
  })
})

describe('确定性（E1：固定种子完整时间线重复一致）', () => {
  it('同 seed 同注入：两次运行的完整事件序列逐位一致', async () => {
    const runA = setup()
    const runB = setup()
    await runA.source.connect()
    await runB.source.connect()
    await advance(130_000) // 覆盖一个完整验收窗口 + 余量
    runA.source.disconnect()
    runB.source.disconnect()
    expect(JSON.stringify(runA.events)).toBe(JSON.stringify(runB.events))
  })

  it('不同 seed 产生不同事件内容', async () => {
    const runA = setup({ seed: 20260901 })
    const runB = setup({ seed: 20260902 })
    await runA.source.connect()
    await runB.source.connect()
    await advance(10_000)
    runA.source.disconnect()
    runB.source.disconnect()
    expect(JSON.stringify(runA.events)).not.toBe(JSON.stringify(runB.events))
  })
})

describe('验收时间线覆盖（120s 固定窗口，E3）', () => {
  it('窗口内确定出现故障、掉线、暂停、交通等待+矩形、低定位、订单、增删车', async () => {
    const h = setup()
    await h.source.connect()
    await advance(100_000)
    h.source.disconnect()

    let sawFaultOn = false
    let sawFaultOff = false
    let sawOffline = false
    let sawPaused = false
    let sawTraffic = false
    let sawLowLocalization = false
    let sawProcessing = false
    let sawRemove = false
    let sawAddedVehicle = false

    for (const event of h.events) {
      if (event.type === 'remove' && event.agvKey === 'mock-agv-0060') {
        sawRemove = true
      }
      if (event.type === 'update' && event.vehicle.agvKey === 'mock-agv-0061') {
        sawAddedVehicle = true
      }
      if (event.type !== 'update') {
        continue
      }
      const vehicle = event.vehicle
      if (vehicle.agvKey === 'mock-agv-0012') {
        if (vehicle.rawErrorEntries.length > 0) {
          sawFaultOn = true
        } else if (sawFaultOn) {
          sawFaultOff = true
        }
      }
      if (vehicle.agvKey === 'mock-agv-0013' && vehicle.connectionState === 'OFFLINE') {
        sawOffline = true
      }
      if (vehicle.agvKey === 'mock-agv-0014' && vehicle.paused) {
        sawPaused = true
      }
      if (vehicle.agvKey === 'mock-agv-0015' && vehicle.vehicleProcStatus === 'TRAFFIC') {
        sawTraffic = true
        const resources = vehicle.trafficShapeResources
        expect(resources).not.toBeNull()
        if (resources) {
          expect(resources.lockedRectangles).toHaveLength(1)
          expect(resources.applyingRectangles).toHaveLength(2)
          const quads = [
            ...resources.lockedRectangles,
            ...resources.applyingRectangles,
          ] as readonly number[][]
          for (const quad of quads) {
            expect(quad).toHaveLength(8)
            for (const value of quad) {
              expect(Number.isFinite(value)).toBe(true)
            }
          }
        }
      }
      if (vehicle.agvKey === 'mock-agv-0016' && vehicle.position.localizationScore === 0.3) {
        sawLowLocalization = true
      }
      if (vehicle.agvKey === 'mock-agv-0011' && vehicle.orderState === 'PROCESSING') {
        sawProcessing = true
      }
    }

    expect(sawProcessing).toBe(true)
    expect(sawFaultOn).toBe(true)
    expect(sawFaultOff).toBe(true)
    expect(sawOffline).toBe(true)
    expect(sawPaused).toBe(true)
    expect(sawTraffic).toBe(true)
    expect(sawLowLocalization).toBe(true)
    expect(sawRemove).toBe(true)
    expect(sawAddedVehicle).toBe(true)

    // 删一增一：车队规模守恒为 60
    expect(h.source.devControl.getVehicleCount()).toBe(60)
  })

  it('前 2 台初始低电量车辆在窗口内进入充电（charging=true）', async () => {
    const h = setup()
    await h.source.connect()
    await advance(100_000)
    h.source.disconnect()
    const chargingSnapshots = h.events.filter(
      (event) => event.type === 'update' && event.vehicle.battery.charging,
    )
    expect(chargingSnapshots.length).toBeGreaterThan(0)
    const charged = chargingSnapshots[0]
    if (charged.type === 'update') {
      // 充电中 operation 派生为 CHARGING（优先级高于空闲）
      expect(['mock-agv-0001', 'mock-agv-0002']).toContain(charged.vehicle.agvKey)
    }
  })
})

describe('开发控制（__AGV_MOCK__ 命令面）', () => {
  it('setVehicleCount：增删到目标规模并发布显式事件；超出上限被钳制', async () => {
    const h = setup({ maxVehicleCount: 65 })
    await h.source.connect()
    const baseEvents = h.events.length

    h.source.devControl.setVehicleCount(62)
    expect(h.source.devControl.getVehicleCount()).toBe(62)
    const added = h.events.slice(baseEvents).filter((event) => event.type === 'update')
    expect(added.map((event) => (event.type === 'update' ? event.vehicle.agvKey : ''))).toEqual([
      'mock-agv-0061',
      'mock-agv-0062',
    ])

    const afterAdd = h.events.length
    h.source.devControl.setVehicleCount(60)
    const removed = h.events.slice(afterAdd).filter((event) => event.type === 'remove')
    expect(removed.map((event) => (event.type === 'remove' ? event.agvKey : ''))).toEqual([
      'mock-agv-0062',
      'mock-agv-0061',
    ])
    expect(h.source.devControl.getVehicleCount()).toBe(60)

    h.source.devControl.setVehicleCount(10_000)
    expect(h.source.devControl.getVehicleCount()).toBe(65)
    h.source.disconnect()
  })

  it('setScenarioEnabled(false)：时间线停走，不出现脚本覆盖事件', async () => {
    const h = setup()
    h.source.devControl.setScenarioEnabled(false)
    await h.source.connect()
    await advance(100_000)
    h.source.disconnect()
    const faulted = h.events.some(
      (event) => event.type === 'update' && event.vehicle.rawErrorEntries.length > 0,
    )
    expect(faulted).toBe(false)
    expect(h.source.devControl.isScenarioEnabled()).toBe(false)
  })

  it('resetSimulation：换种子重建车队并以新快照对齐', async () => {
    const h = setup()
    await h.source.connect()
    await advance(2000)
    const snapshotsBefore = h.events.filter((event) => event.type === 'snapshot').length
    h.source.devControl.resetSimulation({ seed: 42 })
    expect(h.source.devControl.getSeed()).toBe(42)
    const snapshots = h.events.filter((event) => event.type === 'snapshot')
    expect(snapshots).toHaveLength(snapshotsBefore + 1)
    const reset = snapshots[snapshots.length - 1]
    if (reset.type === 'snapshot') {
      expect(reset.vehicles).toHaveLength(60)
    }
    expect(h.source.devControl.getStats().simTimeSeconds).toBe(0)
    h.source.disconnect()
  })
})

describe('压力规模', () => {
  it('250 台车队：快照规模与增量流稳定', async () => {
    const h = setup({ vehicleCount: 250 })
    await h.source.connect()
    const snapshot = h.events[0]
    if (snapshot.type === 'snapshot') {
      expect(snapshot.vehicles).toHaveLength(250)
    }
    await advance(2000)
    const updates = h.events.filter((event) => event.type === 'update')
    expect(updates.length).toBeGreaterThan(250)
    h.source.disconnect()
  })
})
