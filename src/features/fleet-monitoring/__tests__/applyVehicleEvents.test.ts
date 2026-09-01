/*
 * createFleetRuntime 事件归并测试（TASK-006 / C1、§3.2、§11.6、§11.8）。
 *
 * 覆盖：四类事件语义、空快照全删、快照内重复键后到覆盖、update 不隐式删除、
 *       remove 幂等、跨地图实体隔离、非法事件外壳整条拒绝并记诊断、
 *       非法位置车辆保留实体并传播 INVALID_DATA。
 */
import { describe, expect, it } from 'vitest'
import { createDiagnosticsReporter } from '@/shared/diagnostics'
import { createFleetRuntime } from '../model/createFleetRuntime'
import { createVehicleEntityKey } from '../model/types'
import {
  heartbeatEvent,
  makeRawVehicle,
  removeEvent,
  snapshotEvent,
  snapshotOf,
  updateEvent,
} from './testVehicles'

const MAP = 'map-under-test'

describe('snapshot 全量基线归并', () => {
  it('两台车 → added 两条；实体可按实体键查询', () => {
    const runtime = createFleetRuntime()
    const a = snapshotOf(makeRawVehicle({ agvKey: 'a' }))
    const b = snapshotOf(makeRawVehicle({ agvKey: 'b' }))
    const diff = runtime.applyEvent(snapshotEvent([a, b]))
    expect(diff).toEqual({ added: [a.entityKey, b.entityKey], updated: [], removed: [] })
    expect(runtime.count).toBe(2)
    expect(runtime.get(a.entityKey)?.agvKey).toBe('a')
  })

  it('全量基线 diff：再次快照缺失的实体被删除（added/updated/removed 互不相交）', () => {
    const runtime = createFleetRuntime()
    const a = snapshotOf(makeRawVehicle({ agvKey: 'a' }))
    const b = snapshotOf(makeRawVehicle({ agvKey: 'b' }))
    const c = snapshotOf(makeRawVehicle({ agvKey: 'c' }))
    runtime.applyEvent(snapshotEvent([a, b]))
    const diff = runtime.applyEvent(snapshotEvent([b, c], 2_000))
    expect(diff.added).toEqual([c.entityKey])
    expect(diff.updated).toEqual([b.entityKey])
    expect(diff.removed).toEqual([a.entityKey])
    expect(runtime.count).toBe(2)
  })

  it('空快照删除全部实体，不崩溃', () => {
    const runtime = createFleetRuntime()
    runtime.applyEvent(snapshotEvent([snapshotOf(makeRawVehicle())]))
    const diff = runtime.applyEvent(snapshotEvent([], 2_000))
    expect(diff.removed).toHaveLength(1)
    expect(runtime.count).toBe(0)
  })

  it('快照内重复 agvKey：后到条目覆盖先到，实体只保留一份', () => {
    const runtime = createFleetRuntime()
    const first = snapshotOf(makeRawVehicle({ agvKey: 'a', loaded: false }))
    const second = snapshotOf(makeRawVehicle({ agvKey: 'a', loaded: true }))
    runtime.applyEvent(snapshotEvent([first, second]))
    expect(runtime.count).toBe(1)
    expect(runtime.get(first.entityKey)?.snapshot.loaded).toBe(true)
  })
})

describe('update / remove / heartbeat 语义', () => {
  it('update 只影响目标车，不隐式删除其他车辆', () => {
    const runtime = createFleetRuntime()
    const a = snapshotOf(makeRawVehicle({ agvKey: 'a' }))
    const b = snapshotOf(makeRawVehicle({ agvKey: 'b' }))
    runtime.applyEvent(snapshotEvent([a, b]))
    const a2 = snapshotOf(makeRawVehicle({ agvKey: 'a', agvPosition: { x: 9, y: 9, theta: 1, localizationScore: 0.9 } }))
    const diff = runtime.applyEvent(updateEvent(a2, 2_000))
    expect(diff).toEqual({ added: [], updated: [a2.entityKey], removed: [] })
    expect(runtime.count).toBe(2)
    expect(runtime.get(a2.entityKey)?.snapshot.position.x).toBe(9)
  })

  it('update 可新增此前不存在的车辆（added）', () => {
    const runtime = createFleetRuntime()
    const x = snapshotOf(makeRawVehicle({ agvKey: 'x' }))
    const diff = runtime.applyEvent(updateEvent(x))
    expect(diff.added).toEqual([x.entityKey])
    expect(runtime.count).toBe(1)
  })

  it('remove 删除目标车；对不存在的键幂等（空 diff）', () => {
    const runtime = createFleetRuntime()
    const a = snapshotOf(makeRawVehicle({ agvKey: 'a' }))
    runtime.applyEvent(snapshotEvent([a]))
    expect(runtime.applyEvent(removeEvent(MAP, 'a', 2_000)).removed).toEqual([a.entityKey])
    expect(runtime.count).toBe(0)
    const again = runtime.applyEvent(removeEvent(MAP, 'a', 3_000))
    expect(again).toEqual({ added: [], updated: [], removed: [] })
  })

  it('heartbeat 不改变任何实体与 diff', () => {
    const runtime = createFleetRuntime()
    const a = snapshotOf(makeRawVehicle({ agvKey: 'a' }))
    runtime.applyEvent(snapshotEvent([a]))
    const before = runtime.get(a.entityKey)
    const diff = runtime.applyEvent(heartbeatEvent(2_000))
    expect(diff).toEqual({ added: [], updated: [], removed: [] })
    expect(runtime.get(a.entityKey)?.lastReceivedAt).toBe(before?.lastReceivedAt)
  })
})

describe('地图隔离（实体键 (mapId, agvKey)）', () => {
  it('不同地图的同名车互不干扰；基线删除只作用于事件 mapId 的实体空间', () => {
    const runtime = createFleetRuntime()
    const m1a = snapshotOf(makeRawVehicle({ agvKey: 'a' }), 'm1')
    const m2a = snapshotOf(makeRawVehicle({ agvKey: 'a' }), 'm2')
    runtime.applyEvent(snapshotEvent([m1a], 1_000, 1, 'm1'))
    runtime.applyEvent(snapshotEvent([m2a], 1_000, 1, 'm2'))
    expect(runtime.count).toBe(2)
    expect(m1a.entityKey).not.toBe(m2a.entityKey)
    // m1 的空快照只删除 m1 的车，m2 的同名车保持不动
    const diff = runtime.applyEvent(snapshotEvent([], 2_000, 2, 'm1'))
    expect(diff.removed).toEqual([m1a.entityKey])
    expect(runtime.count).toBe(1)
    expect(runtime.get(m2a.entityKey)?.mapId).toBe('m2')
  })
})

describe('事件外壳防御与单车隔离（§11.7、§11.8）', () => {
  it('外壳非法的事件整条拒绝：不修改数据并记录采样诊断', () => {
    const records: { code: string }[] = []
    const runtime = createFleetRuntime({
      diagnostics: createDiagnosticsReporter({ sink: (r) => records.push(r) }),
    })
    const a = snapshotOf(makeRawVehicle())
    runtime.applyEvent(snapshotEvent([a]))
    expect(runtime.applyEvent({ type: 'nonsense', mapId: MAP, receivedAt: 2_000 } as never)).toEqual({
      added: [],
      updated: [],
      removed: [],
    })
    expect(runtime.applyEvent({ type: 'snapshot', mapId: '', receivedAt: 2_000 } as never)).toEqual({
      added: [],
      updated: [],
      removed: [],
    })
    expect(runtime.count).toBe(1)
    // 首条同码诊断立即发出；窗口内的重复上报被采样合并（TASK-002 语义）
    expect(records).toHaveLength(1)
    expect(records[0]?.code).toBe('FLEET_EVENT_REJECTED')
  })

  it('非法位置车辆保留实体并传播 INVALID_DATA（不抛弃整车）', () => {
    const runtime = createFleetRuntime()
    const broken = snapshotOf(
      makeRawVehicle({ agvKey: 'bad', agvPosition: { x: Number.NaN, y: 2, theta: 0 } }),
    )
    const diff = runtime.applyEvent(snapshotEvent([broken]))
    expect(diff.added).toEqual([broken.entityKey])
    const entity = runtime.get(broken.entityKey)
    expect(entity?.snapshot.positionValid).toBe(false)
    expect(entity?.staticState.alerts.map((alert) => alert.type)).toContain('INVALID_DATA')
  })

  it('receivedAt 缺失时以注入单调时钟兜底，不产生 NaN 时间戳', () => {
    let now = 5_000
    const runtime = createFleetRuntime({ now: () => now })
    const a = snapshotOf(makeRawVehicle())
    runtime.applyEvent({ ...snapshotEvent([a]), receivedAt: undefined } as never)
    expect(runtime.get(a.entityKey)?.lastReceivedAt).toBe(5_000)
    now = 6_000
    runtime.tick(6_000)
    expect(runtime.get(a.entityKey)?.freshness).toBe('FRESH')
  })
})

describe('实体键唯一性（长度前缀编码）', () => {
  it('任意不透明字符串组合都不产生键冲突', () => {
    expect(createVehicleEntityKey('m1', '2:x')).not.toBe(createVehicleEntityKey('m1:2', 'x'))
    expect(createVehicleEntityKey('11', '1:2')).not.toBe(createVehicleEntityKey('1', '1:112'))
  })
})
