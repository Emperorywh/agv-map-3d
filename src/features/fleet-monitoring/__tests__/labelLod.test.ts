/*
 * 车辆标签 LOD 与重点标签纯函数测试（TASK-011 / SPEC §6.4、§7.3）。
 *
 * 职责：锁定显示决策的全部边界——
 * 1. 投影档位：恰 8px 显示名称、恰 20px 进入完整档，低于 8px 与非有限值隐藏；
 * 2. 重点优先级：选中 > FAULT > STALE > OFFLINE（断连）> 严重低电量 > 低定位，
 *    多条件并存取最高优先级，普通车辆为 null；
 * 3. 告警级：L2 优先于 L1，与 §7.3 告警表逐项一致；
 * 4. 状态芯片取值：FRESH 显示业务主状态，STALE/断连保留最后已知业务状态，
 *    UNKNOWN 不作为徽标；
 * 5. 远景截断：按（秩, 扁平槽位）升序稳定保留前 20。
 */
import { describe, expect, it } from 'vitest'
import type { VehicleAlert } from '../model/types'
import {
  capImportantLabels,
  labelAlertLevel,
  labelChipOf,
  labelImportanceRank,
  labelLevelForPixels,
} from '../scene/labelLod'

const NO_ALERTS: readonly VehicleAlert[] = Object.freeze([])

describe('labelLevelForPixels 投影档位边界', () => {
  it('恰 8px 显示名称（1 档），恰 20px 进入完整档（2 档）', () => {
    expect(labelLevelForPixels(7.999)).toBe(0)
    expect(labelLevelForPixels(8)).toBe(1)
    expect(labelLevelForPixels(12.5)).toBe(1)
    expect(labelLevelForPixels(19.999)).toBe(1)
    expect(labelLevelForPixels(20)).toBe(2)
    expect(labelLevelForPixels(300)).toBe(2)
  })

  it('非有限投影长度一律隐藏（NaN/Infinity 不进入比较）', () => {
    expect(labelLevelForPixels(Number.NaN)).toBe(0)
    expect(labelLevelForPixels(Number.POSITIVE_INFINITY)).toBe(0)
    expect(labelLevelForPixels(-5)).toBe(0)
  })
})

describe('labelImportanceRank 重点优先级', () => {
  it('优先级次序固定：选中 > FAULT > STALE > 断连 > 严重低电量 > 低定位', () => {
    const rankOf = (input: Parameters<typeof labelImportanceRank>[0]) =>
      labelImportanceRank(input)
    expect(rankOf({ selected: true, primary: 'IDLE', alerts: NO_ALERTS })).toBe(0)
    expect(rankOf({ selected: false, primary: 'FAULT', alerts: NO_ALERTS })).toBe(1)
    expect(rankOf({ selected: false, primary: 'STALE', alerts: NO_ALERTS })).toBe(2)
    expect(rankOf({ selected: false, primary: 'DISCONNECTED', alerts: NO_ALERTS })).toBe(3)
    expect(
      rankOf({
        selected: false,
        primary: 'IDLE',
        alerts: [{ type: 'CRITICAL_BATTERY' }],
      }),
    ).toBe(4)
    expect(
      rankOf({
        selected: false,
        primary: 'IDLE',
        alerts: [{ type: 'LOW_LOCALIZATION' }],
      }),
    ).toBe(5)
    expect(rankOf({ selected: false, primary: 'EXECUTING', alerts: NO_ALERTS })).toBe(null)
  })

  it('多条件并存取最高优先级：选中压过一切；严重低电量压过低定位', () => {
    expect(
      labelImportanceRank({
        selected: true,
        primary: 'STALE',
        alerts: [{ type: 'CRITICAL_BATTERY' }],
      }),
    ).toBe(0)
    expect(
      labelImportanceRank({
        selected: false,
        primary: 'IDLE',
        alerts: [{ type: 'LOW_LOCALIZATION' }, { type: 'CRITICAL_BATTERY' }],
      }),
    ).toBe(4)
  })
})

describe('labelAlertLevel 告警级', () => {
  it('L2 触发：FAULT/STALE/断连投影、严重低电量与 INVALID_DATA', () => {
    expect(labelAlertLevel('FAULT', NO_ALERTS)).toBe(2)
    expect(labelAlertLevel('STALE', NO_ALERTS)).toBe(2)
    expect(labelAlertLevel('DISCONNECTED', NO_ALERTS)).toBe(2)
    expect(labelAlertLevel('IDLE', [{ type: 'CRITICAL_BATTERY' }])).toBe(2)
    expect(labelAlertLevel('IDLE', [{ type: 'INVALID_DATA' }])).toBe(2)
  })

  it('L1 触发：低电量与低定位；L2 优先于 L1；无告警为 0', () => {
    expect(labelAlertLevel('IDLE', [{ type: 'LOW_BATTERY' }])).toBe(1)
    expect(labelAlertLevel('IDLE', [{ type: 'LOW_LOCALIZATION' }])).toBe(1)
    expect(
      labelAlertLevel('IDLE', [{ type: 'LOW_BATTERY' }, { type: 'INVALID_DATA' }]),
    ).toBe(2)
    expect(labelAlertLevel('EXECUTING', NO_ALERTS)).toBe(0)
  })
})

describe('labelChipOf 状态芯片取值', () => {
  it('FRESH 显示业务主状态；UNKNOWN 不作为徽标', () => {
    expect(labelChipOf('TRAFFIC_WAIT', null)).toBe('TRAFFIC_WAIT')
    expect(labelChipOf('EXECUTING', null)).toBe('EXECUTING')
    expect(labelChipOf('UNKNOWN', null)).toBe(null)
  })

  it('STALE/断连保留最后已知业务状态副徽标；最后状态未知时隐藏', () => {
    expect(labelChipOf('STALE', 'IDLE')).toBe('IDLE')
    expect(labelChipOf('DISCONNECTED', 'CHARGING')).toBe('CHARGING')
    expect(labelChipOf('STALE', null)).toBe(null)
  })
})

describe('capImportantLabels 远景截断', () => {
  it('不超过上限返回 null（无需截断）；超限按（秩, 扁平槽位）稳定保留', () => {
    const entries = [{ flatSlot: 3, rank: 1 }, { flatSlot: 1, rank: 1 }]
    expect(capImportantLabels(entries, 20)).toBe(null)

    // 25 个候选只保留 20：秩小者优先，同秩按扁平槽位升序
    const many = Array.from({ length: 25 }, (_, i) => ({ flatSlot: i, rank: 1 }))
    const kept = capImportantLabels(many, 20)
    expect(kept).not.toBe(null)
    expect(kept!.size).toBe(20)
    for (let slot = 0; slot < 20; slot += 1) {
      expect(kept!.has(slot)).toBe(true)
    }
    expect(kept!.has(24)).toBe(false)
  })

  it('高优先级（选中）在截断中压过低秩普通重点', () => {
    const many = [
      ...Array.from({ length: 20 }, (_, i) => ({ flatSlot: i, rank: 5 })),
      { flatSlot: 100, rank: 0 }, // 选中车：必须入选
    ]
    const kept = capImportantLabels(many, 20)
    expect(kept).not.toBe(null)
    expect(kept!.has(100)).toBe(true)
    expect(kept!.size).toBe(20)
    // 选中车占一个名额：秩 5 中扁平序最大的槽位 19 被挤出
    expect(kept!.has(19)).toBe(false)
    expect(kept!.has(18)).toBe(true)
  })
})
