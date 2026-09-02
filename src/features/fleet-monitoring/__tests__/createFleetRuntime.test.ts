/*
 * createFleetRuntime 新鲜度与脏集合测试（TASK-006 / §2.6、§4、§11.1、F5）。
 *
 * 覆盖：单调接收时间只增不减、10s 阈值边界与 STALE 恢复、heartbeat 不刷新
 *       单车新鲜度、tick 只在跃迁处标记脏、脏集合最小化（未变化槽位不标记）、
 *       consumeDirty 消费即清空、staleAfterMs 可注入。
 */
import { describe, expect, it } from 'vitest'
import { createFleetRuntime } from '../model/createFleetRuntime'
import {
  heartbeatEvent,
  makeRawVehicle,
  snapshotEvent,
  snapshotOf,
  updateEvent,
} from './testVehicles'

const MAP = 'map-under-test'

/** 构造注入虚拟时钟的运行时与一把仅改电量的「无位移」更新事件 */
function setup(staleAfterMs = 10_000) {
  let now = 0
  const runtime = createFleetRuntime({
    staleAfterMs,
    now: () => now,
  })
  const advance = (ms: number): void => {
    now += ms
  }
  return { runtime, advance, now: () => now }
}

describe('freshness：10s 阈值、跃迁与恢复（§11.1）', () => {
  it('lastReceivedAt 之内 FRESH；达到 staleAfterMs 整数阈值即 STALE', () => {
    const { runtime, advance } = setup()
    const a = snapshotOf(makeRawVehicle())
    runtime.applyEvent(snapshotEvent([a], 1_000))
    advance(8_999)
    runtime.tick(9_999)
    expect(runtime.get(a.entityKey)?.freshness).toBe('FRESH')
    // 1_000 + 10_000 = 11_000：恰好达到阈值即过期
    advance(1_001)
    runtime.tick(11_000)
    expect(runtime.get(a.entityKey)?.freshness).toBe('STALE')
  })

  it('跃迁只在边界发生一次：持续 tick 不重复标记 display 脏', () => {
    const { runtime, advance } = setup()
    const a = snapshotOf(makeRawVehicle())
    runtime.applyEvent(snapshotEvent([a], 1_000))
    runtime.consumeDirty()
    advance(10_000)
    runtime.tick(11_000)
    const first = runtime.consumeDirty()
    expect(first.display).toEqual([a.entityKey])
    advance(1_000)
    runtime.tick(12_000)
    expect(runtime.consumeDirty().display).toEqual([])
  })

  it('有效 update 立即恢复 FRESH（10s STALE 后恢复）', () => {
    const { runtime, advance } = setup()
    const a = snapshotOf(makeRawVehicle())
    runtime.applyEvent(snapshotEvent([a], 1_000))
    advance(11_000)
    runtime.tick(11_000)
    expect(runtime.get(a.entityKey)?.freshness).toBe('STALE')
    const a2 = snapshotOf(makeRawVehicle({ agvKey: 'agv-001', agvPosition: { x: 5, y: 5, theta: 0, localizationScore: 0.9 } }))
    runtime.applyEvent(updateEvent(a2, 11_500))
    expect(runtime.get(a.entityKey)?.freshness).toBe('FRESH')
  })

  it('heartbeat 不刷新单车新鲜度：数据沉默仍会 STALE', () => {
    const { runtime, advance } = setup()
    const a = snapshotOf(makeRawVehicle())
    runtime.applyEvent(snapshotEvent([a], 1_000))
    advance(5_000)
    runtime.applyEvent(heartbeatEvent(6_000))
    advance(5_500)
    runtime.tick(11_500)
    expect(runtime.get(a.entityKey)?.freshness).toBe('STALE')
  })

  it('单调接收时间：receivedAt 回退不缩减 lastReceivedAt（只增不减）', () => {
    const { runtime } = setup()
    const a = snapshotOf(makeRawVehicle())
    runtime.applyEvent(snapshotEvent([a], 10_000))
    const newer = snapshotOf(makeRawVehicle({ agvKey: 'agv-001', batteryState: { batteryCharge: 70, batteryHealth: 100, batteryVoltage: 220, charging: false } }))
    runtime.applyEvent(updateEvent(newer, 9_000))
    expect(runtime.get(a.entityKey)?.lastReceivedAt).toBe(10_000)
  })

  it('staleAfterMs 可注入（配置 staleAfterMs 通道）', () => {
    const { runtime, advance } = setup(5_000)
    const a = snapshotOf(makeRawVehicle())
    runtime.applyEvent(snapshotEvent([a], 0))
    advance(5_000)
    runtime.tick(5_000)
    expect(runtime.get(a.entityKey)?.freshness).toBe('STALE')
  })
})

describe('脏集合最小化（F5：未变化不写）', () => {
  it('新增实体同时进入 pose 与 display；consume 后清空', () => {
    const { runtime } = setup()
    const a = snapshotOf(makeRawVehicle())
    runtime.applyEvent(snapshotEvent([a]))
    const batch = runtime.consumeDirty()
    expect(batch.pose).toEqual([a.entityKey])
    expect(batch.display).toEqual([a.entityKey])
    expect(runtime.consumeDirty()).toEqual({ pose: [], display: [], removed: [] })
  })

  it('仅电量变化 → 只 display 脏；位姿不变不标记 pose', () => {
    const { runtime } = setup()
    const a = snapshotOf(makeRawVehicle({ batteryState: { batteryCharge: 80, batteryHealth: 100, batteryVoltage: 220, charging: false } }))
    runtime.applyEvent(snapshotEvent([a]))
    runtime.consumeDirty()
    const samePose = snapshotOf(makeRawVehicle({ batteryState: { batteryCharge: 79, batteryHealth: 100, batteryVoltage: 220, charging: false } }))
    runtime.applyEvent(updateEvent(samePose, 2_000))
    const batch = runtime.consumeDirty()
    expect(batch.pose).toEqual([])
    expect(batch.display).toEqual([a.entityKey])
  })

  it('位置变化 → pose 脏；与最新快照完全相同的更新 → diff.updated 有值但脏集合为空', () => {
    const { runtime } = setup()
    const a = snapshotOf(makeRawVehicle())
    runtime.applyEvent(snapshotEvent([a]))
    runtime.consumeDirty()
    const movedRaw = { agvKey: 'agv-001', agvPosition: { x: 101, y: 50, theta: 0, localizationScore: 0.9 } }
    runtime.applyEvent(updateEvent(snapshotOf(makeRawVehicle(movedRaw)), 2_000))
    expect(runtime.consumeDirty().pose).toEqual([a.entityKey])
    // 与当前最新快照完全一致的重复更新：事件级 diff 记 updated，但不产生任何脏标记
    const diff = runtime.applyEvent(updateEvent(snapshotOf(makeRawVehicle(movedRaw)), 3_000))
    expect(diff.updated).toEqual([a.entityKey])
    const batch = runtime.consumeDirty()
    expect(batch.pose).toEqual([])
    expect(batch.display).toEqual([])
  })

  it('告警变化与 STALE 跃迁走 display；删除进入 removed 且从其他脏集合清理', () => {
    const { runtime, advance } = setup()
    const a = snapshotOf(makeRawVehicle({ batteryState: { batteryCharge: 20, batteryHealth: 100, batteryVoltage: 220, charging: false } }))
    runtime.applyEvent(snapshotEvent([a]))
    runtime.consumeDirty()
    const drained = snapshotOf(makeRawVehicle({ batteryState: { batteryCharge: 10, batteryHealth: 100, batteryVoltage: 220, charging: false } }))
    runtime.applyEvent(updateEvent(drained, 2_000))
    const afterAlert = runtime.consumeDirty()
    expect(afterAlert.pose).toEqual([])
    expect(afterAlert.display).toEqual([a.entityKey])
    // 2_000 + 10_000 = 12_000：达到阈值，STALE 跃迁只标记 display
    advance(12_000)
    runtime.tick(12_000)
    expect(runtime.consumeDirty().display).toEqual([a.entityKey])
    // 删除：removed 脏；该键不再出现在 pose/display
    const diff = runtime.applyEvent({ type: 'remove', schemaVersion: 't', mapId: MAP, sequence: 9, receivedAt: 12_500, agvKey: a.agvKey })
    expect(diff.removed).toEqual([a.entityKey])
    const batch = runtime.consumeDirty()
    expect(batch.removed).toEqual([a.entityKey])
    expect(batch.pose).toEqual([])
    expect(batch.display).toEqual([])
    expect(runtime.count).toBe(0)
  })
})

describe('markAllDirty：回前台强制全量脏标记（§11.5；TASK-015）', () => {
  it('把全部存活实体标记为 pose+display 脏，与此前是否已消费无关', () => {
    const { runtime } = setup()
    const a = snapshotOf(makeRawVehicle())
    const b = snapshotOf(makeRawVehicle({
      agvKey: 'agv-002',
      agvName: '测试车 002',
      agvPosition: { x: 200, y: 60, theta: 1, localizationScore: 0.9 },
    }))
    runtime.applyEvent(snapshotEvent([a, b]))
    runtime.consumeDirty()
    // 无新事件：正常消费应为空
    expect(runtime.consumeDirty()).toEqual({ pose: [], display: [], removed: [] })
    runtime.markAllDirty()
    const batch = runtime.consumeDirty()
    expect([...batch.pose].sort()).toEqual([a.entityKey, b.entityKey].sort())
    expect([...batch.display].sort()).toEqual([a.entityKey, b.entityKey].sort())
    expect(batch.removed).toEqual([])
    // 幂等：再次标记继续有效（回前台可能连续触发）
    runtime.markAllDirty()
    expect(runtime.consumeDirty().pose.length).toBe(2)
  })

  it('不伪造 removed：已删除实体不因 markAllDirty 复活', () => {
    const { runtime } = setup()
    const a = snapshotOf(makeRawVehicle())
    runtime.applyEvent(snapshotEvent([a]))
    runtime.applyEvent({ type: 'remove', schemaVersion: 't', mapId: MAP, sequence: 9, receivedAt: 1_500, agvKey: a.agvKey })
    runtime.consumeDirty()
    runtime.markAllDirty()
    const batch = runtime.consumeDirty()
    expect(batch.removed).toEqual([])
    expect(batch.pose).toEqual([])
    expect(batch.display).toEqual([])
  })

  it('空运行时 markAllDirty 为 no-op，空表运行时不产生差异', () => {
    const { runtime } = setup()
    runtime.markAllDirty()
    expect(runtime.consumeDirty()).toEqual({ pose: [], display: [], removed: [] })
  })
})
