/**
 * 确定性验收场景调度器测试（TASK-009 / SPEC §9.3「保证所有事件在规定窗口
 * 内至少发生一次，不依赖随机概率碰巧命中」；E3）。
 *
 * 覆盖：窗口内全事件覆盖（接单/完成、故障/恢复、掉线/恢复、暂停/恢复、
 *       交通等待/解除、低定位/恢复、删车、增车）、投递顺序与一次性（单调
 *       游标）、时间倒退不重放、循环窗口持续复现、reset 归零、确定性。
 */
import { describe, expect, it } from 'vitest'
import {
  ACCEPTANCE_TARGET_SERIAL_BASE,
  createAcceptanceScenario,
  DEFAULT_ACCEPTANCE_WINDOW_SECONDS,
  type MockScenarioDirective,
} from '../scenarios/acceptanceScenario'

/** 把指令序列折叠成可读的「field@time」断言辅助 */
const kinds = (directives: readonly MockScenarioDirective[]): string[] =>
  directives.map((d) => (d.kind === 'patch' ? `patch:${d.patch.field}:${d.patch.value}` : d.kind))

describe('验收时间线覆盖', () => {
  it('一个完整窗口内覆盖全部验收事件，且成对出现（开/关、删/增）', () => {
    const scenario = createAcceptanceScenario()
    expect(scenario.windowSeconds).toBe(DEFAULT_ACCEPTANCE_WINDOW_SECONDS)
    const all: MockScenarioDirective[] = []
    // 以 1s 步长推进两个窗口
    for (let t = 0; t <= 2 * scenario.windowSeconds; t += 1) {
      all.push(...scenario.advance(t))
    }
    const patches = all.flatMap((d) => (d.kind === 'patch' ? [d.patch] : []))
    const values = (field: string): string[] =>
      patches.filter((p) => p.field === field).map((p) => p.value)

    expect(values('order')).toEqual(['assign', 'complete', 'assign', 'complete'])
    expect(values('fault')).toEqual(['on', 'off', 'on', 'off'])
    expect(values('offline')).toEqual(['on', 'off', 'on', 'off'])
    expect(values('paused')).toEqual(['on', 'off', 'on', 'off'])
    expect(values('traffic')).toEqual(['on', 'off', 'on', 'off'])
    expect(values('lowLocalization')).toEqual(['on', 'off', 'on', 'off'])
    expect(kinds(all).filter((k) => k === 'remove')).toHaveLength(2)
    expect(kinds(all).filter((k) => k === 'add')).toHaveLength(2)
  })

  it('场景目标序号与内核低电量前 N 台错开（默认数据源前 2 台低电量）', () => {
    expect(ACCEPTANCE_TARGET_SERIAL_BASE).toBeGreaterThan(2)
  })

  it('指令按表序一次性投递；重复或倒退的 simTime 不产生增量', () => {
    const scenario = createAcceptanceScenario()
    expect(scenario.advance(0)).toEqual([])
    const at2 = scenario.advance(2)
    expect(at2).toHaveLength(1)
    expect(at2[0]).toEqual({
      kind: 'patch',
      serial: 11,
      patch: { field: 'order', value: 'assign' },
    })
    // 同一时刻重复推进：无增量
    expect(scenario.advance(2)).toEqual([])
    // 时间倒退：无增量（单调游标，不重放）
    expect(scenario.advance(0.5)).toEqual([])
  })

  it('跨越窗口末尾后从下一周期开头继续循环', () => {
    const scenario = createAcceptanceScenario({ windowSeconds: 100 })
    let emitted: MockScenarioDirective[] = []
    for (let t = 0; t <= 100; t += 1) {
      emitted = emitted.concat([...scenario.advance(t)])
    }
    const cycle1Count = emitted.length
    expect(cycle1Count).toBeGreaterThan(0)
    const firstOfCycle2 = scenario.advance(102)
    expect(firstOfCycle2).toHaveLength(1)
    expect(firstOfCycle2[0]).toEqual(emitted[0])
  })

  it('reset 归零游标：同一时间线可整体重放', () => {
    const scenario = createAcceptanceScenario()
    const firstPass: MockScenarioDirective[] = []
    for (let t = 0; t <= 90; t += 1) {
      firstPass.push(...scenario.advance(t))
    }
    scenario.reset()
    const replay: MockScenarioDirective[] = []
    for (let t = 0; t <= 90; t += 1) {
      replay.push(...scenario.advance(t))
    }
    expect(replay).toEqual(firstPass)
  })
})
