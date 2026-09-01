/*
 * deriveVehicleState / projectDisplayState 表驱动组合测试（TASK-006 / §2.6、D1、D5）。
 *
 * 覆盖：connectivity 严格映射、operation 固定优先级链（FAULT→PAUSED→CHARGING→
 *       TRAFFIC_WAIT→EXECUTING→IDLE→UNKNOWN）、loadState、多告警并存与阈值
 *       边界、主状态投影顺序（STALE 冻结 > 断连灰 > FRESH 业务色）与副徽标。
 */
import { describe, expect, it } from 'vitest'
import {
  deriveVehicleState,
  projectDisplayState,
} from '../model/deriveVehicleState'
import { makeRawVehicle, snapshotOf } from './testVehicles'

/** 以覆盖字段构造快照的派生状态（生产路径：makeRaw → validate → derive） */
function derive(overrides: Record<string, unknown>) {
  return deriveVehicleState(snapshotOf(makeRawVehicle(overrides)))
}

describe('connectivity 严格映射（未知枚举不归入已知值）', () => {
  const cases: readonly [unknown, string][] = [
    ['ONLINE', 'ONLINE'],
    ['OFFLINE', 'OFFLINE'],
    ['UNKNOWN', 'UNKNOWN'],
    ['online', 'UNKNOWN'],
    ['HIBERNATING', 'UNKNOWN'],
    [null, 'UNKNOWN'],
    [undefined, 'UNKNOWN'],
  ]
  for (const [raw, expected] of cases) {
    it(`connectionState=${String(raw)} → ${expected}`, () => {
      expect(derive({ connectionState: raw }).connectivity).toBe(expected)
    })
  }
})

describe('operation 固定优先级链（D1 组合表驱动）', () => {
  const cases: readonly { name: string; overrides: Record<string, unknown>; expected: string }[] = [
    {
      name: 'FAULT 压倒一切：故障 + OFFLINE + 暂停 + 充电 + TRAFFIC + PROCESSING',
      overrides: {
        errorEntryList: [{ code: 'E1' }],
        connectionState: 'OFFLINE',
        paused: true,
        batteryState: { charging: true },
        vehicleProcStatus: 'TRAFFIC',
        orderState: 'PROCESSING',
      },
      expected: 'FAULT',
    },
    {
      name: 'PAUSED 压倒 CHARGING/TRAFFIC/PROCESSING（PAUSED+CHARGING 组合）',
      overrides: {
        paused: true,
        batteryState: { charging: true },
        vehicleProcStatus: 'TRAFFIC',
        orderState: 'PROCESSING',
      },
      expected: 'PAUSED',
    },
    {
      name: 'CHARGING 压倒 TRAFFIC/PROCESSING',
      overrides: {
        batteryState: { charging: true },
        vehicleProcStatus: 'TRAFFIC',
        orderState: 'PROCESSING',
      },
      expected: 'CHARGING',
    },
    {
      name: 'TRAFFIC_WAIT 压倒 PROCESSING（TRAFFIC+PROCESSING 组合，D5）',
      overrides: { vehicleProcStatus: 'TRAFFIC', orderState: 'PROCESSING' },
      expected: 'TRAFFIC_WAIT',
    },
    { name: '仅 PROCESSING → EXECUTING', overrides: { orderState: 'PROCESSING' }, expected: 'EXECUTING' },
    { name: '已知空闲 procStatus → IDLE', overrides: { vehicleProcStatus: 'IDLE' }, expected: 'IDLE' },
    { name: '无法识别组合 → UNKNOWN（不猜测为 IDLE）', overrides: { vehicleProcStatus: 'PATROLLING' }, expected: 'UNKNOWN' },
    { name: 'procStatus 缺失 → UNKNOWN', overrides: { vehicleProcStatus: null }, expected: 'UNKNOWN' },
  ]
  for (const c of cases) {
    it(c.name, () => {
      expect(derive(c.overrides).operation).toBe(c.expected)
    })
  }
})

describe('loadState 派生', () => {
  it('true → LOADED、false → EMPTY、非布尔 → UNKNOWN', () => {
    expect(derive({ loaded: true }).loadState).toBe('LOADED')
    expect(derive({ loaded: false }).loadState).toBe('EMPTY')
    expect(derive({ loaded: 'yes' }).loadState).toBe('UNKNOWN')
    expect(derive({ loaded: null }).loadState).toBe('UNKNOWN')
  })
})

describe('多告警并存与阈值边界（§7.3）', () => {
  it('电量边界：14.99 CRITICAL / 15 LOW / 29.99 LOW / 30 无 / null 无', () => {
    const charge = (value: unknown) =>
      derive({ batteryState: { batteryCharge: value } }).alerts.map((a) => a.type)
    expect(charge(14.99)).toEqual(['CRITICAL_BATTERY'])
    expect(charge(15)).toEqual(['LOW_BATTERY'])
    expect(charge(29.99)).toEqual(['LOW_BATTERY'])
    expect(charge(30)).toEqual([])
    expect(charge(null)).toEqual([])
  })

  it('定位边界：0.49 LOW_LOCALIZATION / 0.5 无 / 缺失无（缺失按 UNKNOWN 不伪装正常）', () => {
    const withScore = (value: unknown) =>
      derive({ agvPosition: { x: 1, y: 2, theta: 0, localizationScore: value } }).alerts.map((a) => a.type)
    expect(withScore(0.49)).toEqual(['LOW_LOCALIZATION'])
    expect(withScore(0.5)).toEqual([])
    expect(withScore(undefined)).toEqual([])
  })

  it('多告警同时存在：低电量 + 低定位 + 非法尺寸', () => {
    const state = derive({
      batteryState: { batteryCharge: 20 },
      agvDimension: undefined,
      agvPosition: { x: 1, y: 2, theta: 0, localizationScore: 0.1 },
    })
    expect(state.alerts.map((a) => a.type)).toEqual([
      'LOW_BATTERY',
      'LOW_LOCALIZATION',
      'INVALID_DATA',
    ])
  })

  it('非法位置传播 INVALID_DATA；尺寸/位置都合法时无 INVALID_DATA', () => {
    const badPosition = derive({ agvPosition: { x: Number.NaN, y: 2, theta: 0 } })
    expect(badPosition.alerts.map((a) => a.type)).toContain('INVALID_DATA')
    const healthy = derive({})
    expect(healthy.alerts.map((a) => a.type)).not.toContain('INVALID_DATA')
  })
})

describe('projectDisplayState 主状态投影（SPEC §2.6 顺序）', () => {
  it('STALE 优先：任何连接/业务状态下主状态为冻结灰，副徽标保留最后业务状态', () => {
    const state = derive({ errorEntryList: [{ code: 'E1' }], connectionState: 'OFFLINE' })
    const projection = projectDisplayState(state, 'STALE')
    expect(projection.primary).toBe('STALE')
    expect(projection.secondary).toBe('FAULT')
  })

  it('FRESH + OFFLINE/UNKNOWN 连接 → DISCONNECTED 深灰 + 副徽标（FAULT+OFFLINE 组合）', () => {
    const offline = projectDisplayState(derive({ connectionState: 'OFFLINE' }), 'FRESH')
    expect(offline).toEqual({ primary: 'DISCONNECTED', secondary: 'IDLE' })
    const unknownConn = projectDisplayState(derive({ connectionState: 'WEIRD' }), 'FRESH')
    expect(unknownConn.primary).toBe('DISCONNECTED')
  })

  it('FRESH + ONLINE → 业务状态本身，无副徽标（含 TRAFFIC_WAIT，D5）', () => {
    const state = derive({ vehicleProcStatus: 'TRAFFIC', orderState: 'PROCESSING' })
    expect(projectDisplayState(state, 'FRESH')).toEqual({
      primary: 'TRAFFIC_WAIT',
      secondary: null,
    })
  })

  it('业务状态 UNKNOWN 时不产生副徽标（未知不作为业务徽标）', () => {
    const state = derive({ vehicleProcStatus: 'PATROLLING', connectionState: 'OFFLINE' })
    const projection = projectDisplayState(state, 'STALE')
    expect(projection).toEqual({ primary: 'STALE', secondary: null })
  })
})
