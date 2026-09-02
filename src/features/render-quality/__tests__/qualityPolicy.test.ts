/*
 * 质量策略与能力映射测试（TASK-014 / SPEC §6.5）。
 *
 * 职责：以纯函数方式锁定质量控制的全部裁决语义——车队规模→目标帧率、
 *       等级→能力开关映射（四个降级动作严格按 SPEC 顺序叠加）、DPR 上限、
 *       迟滞状态机（105%/3s/5s 降级、75%/30s/30s 恢复、钳制、抖动重置、
 *       断流重置、样本钳制与非有限样本忽略）。
 * 关键不变量：所有时间序列为测试内累计的单调帧时间，与真实渲染循环共用同
 *       一确定性裁决路径；任何等级的能力映射都不含隐藏核心语义的开关。
 */
import { describe, expect, it } from 'vitest'
import {
  capabilitiesForLevel,
  createQualityPolicy,
  DOWNGRADE_COOLDOWN_MS,
  effectiveDprFor,
  OVERSHOOT_SUSTAIN_MS,
  targetFpsForVehicleCount,
  UNDERSHOOT_SUSTAIN_MS,
  UPGRADE_COOLDOWN_MS,
  type QualityLevel,
} from '@/features/render-quality'

/** 以固定步长喂入帧时间序列：返回结束时刻（毫秒） */
function feed(
  policy: ReturnType<typeof createQualityPolicy>,
  frameMs: number,
  fromMs: number,
  toMs: number,
  stepMs: number,
): number {
  let now = fromMs
  while (now <= toMs) {
    policy.pushSample(frameMs, now)
    now += stepMs
  }
  return now - stepMs
}

describe('targetFpsForVehicleCount（SPEC §6.5 目标帧率）', () => {
  it('≤100 台 60fps；101 台及以上 30fps；非有限/非正回退 60fps', () => {
    expect(targetFpsForVehicleCount(0)).toBe(60)
    expect(targetFpsForVehicleCount(1)).toBe(60)
    expect(targetFpsForVehicleCount(100)).toBe(60)
    expect(targetFpsForVehicleCount(101)).toBe(30)
    expect(targetFpsForVehicleCount(200)).toBe(30)
    expect(targetFpsForVehicleCount(512)).toBe(30)
    expect(targetFpsForVehicleCount(Number.NaN)).toBe(60)
    expect(targetFpsForVehicleCount(-5)).toBe(60)
  })
})

describe('capabilitiesForLevel（四个降级动作按 SPEC §6.5 顺序叠加）', () => {
  const base = { shadowMapSize: 2048 }

  it('0 级完整画质：全部能力开启', () => {
    expect(capabilitiesForLevel(0, base)).toEqual({
      importantLabelsOnly: false,
      shadowMapSize: 2048,
      dynamicShadowsEnabled: true,
      trafficPulseEnabled: true,
      decorationsEnabled: true,
    })
  })

  it('1 级：仅保留重点标签和近景标签，阴影与装饰不变', () => {
    const caps = capabilitiesForLevel(1, base)
    expect(caps.importantLabelsOnly).toBe(true)
    expect(caps.shadowMapSize).toBe(2048)
    expect(caps.dynamicShadowsEnabled).toBe(true)
    expect(caps.trafficPulseEnabled).toBe(true)
    expect(caps.decorationsEnabled).toBe(true)
  })

  it('2 级：阴影 2048 降为 1024', () => {
    const caps = capabilitiesForLevel(2, base)
    expect(caps.importantLabelsOnly).toBe(true)
    expect(caps.shadowMapSize).toBe(1024)
    expect(caps.dynamicShadowsEnabled).toBe(true)
  })

  it('3 级：关闭动态阴影与交通锁脉冲', () => {
    const caps = capabilitiesForLevel(3, base)
    expect(caps.dynamicShadowsEnabled).toBe(false)
    expect(caps.trafficPulseEnabled).toBe(false)
    expect(caps.decorationsEnabled).toBe(true)
  })

  it('4 级：停用非关键装饰动画（DPR 由 effectiveDprFor 表达）', () => {
    const caps = capabilitiesForLevel(4, base)
    expect(caps.decorationsEnabled).toBe(false)
    expect(caps.importantLabelsOnly).toBe(true)
    expect(caps.shadowMapSize).toBe(1024)
    expect(caps.dynamicShadowsEnabled).toBe(false)
  })

  it('阴影分辨率取降级值与基准值较小者：基准低于 1024 不再下调', () => {
    expect(capabilitiesForLevel(2, { shadowMapSize: 512 }).shadowMapSize).toBe(512)
    expect(capabilitiesForLevel(4, { shadowMapSize: 4096, degradedShadowMapSize: 2048 }).shadowMapSize).toBe(2048)
    // 任何等级都没有隐藏核心语义的开关入口
    for (const level of [0, 1, 2, 3, 4] as const) {
      const caps = capabilitiesForLevel(level, base)
      expect('hideVehicles' in caps).toBe(false)
      expect('hidePaths' in caps).toBe(false)
    }
  })
})

describe('effectiveDprFor（DPR 上限，SPEC §6.5 行动 4）', () => {
  it('基准画质取 min(maxDpr, 设备像素比)；4 级上限降为 min(1, maxDpr)', () => {
    expect(effectiveDprFor(0, 1.5, 2)).toBe(1.5)
    expect(effectiveDprFor(0, 1.5, 1)).toBe(1)
    expect(effectiveDprFor(3, 2, 2)).toBe(2)
    expect(effectiveDprFor(4, 2, 2)).toBe(1)
    // 上限语义只降不抬：配置上限本身低于 1 时保持原值
    expect(effectiveDprFor(4, 0.5, 2)).toBe(0.5)
  })

  it('非法输入兜底：maxDpr 非法按 1；设备像素比非法视为无设备约束', () => {
    expect(effectiveDprFor(0, Number.NaN, 2)).toBe(1)
    expect(effectiveDprFor(0, 2, 0)).toBe(2)
    expect(effectiveDprFor(0, 2, Number.POSITIVE_INFINITY)).toBe(2)
  })
})

describe('createQualityPolicy 迟滞状态机（SPEC §6.5）', () => {
  it('初始 0 级；预算内的帧时间不触发变化', () => {
    const policy = createQualityPolicy({ targetFps: 60 })
    expect(policy.level()).toBe(0)
    const last = feed(policy, 14, 16, 60000, 16)
    const decision = policy.pushSample(14, last)
    expect(decision.changed).toBe(false)
    expect(decision.level).toBe(0)
    expect(policy.level()).toBe(0)
  })

  it('过载持续 3s 降级一级；再过 3s 但冷却未满 5s 不降，满 5s 才再降', () => {
    const policy = createQualityPolicy({ targetFps: 60 })
    // 20ms > 16.67×1.05=17.5：持续喂到 3s 边界
    let now = feed(policy, 20, 20, 3000, 20)
    // 首样本 t=20 起 2980ms < 3000：尚未降级
    expect(policy.level()).toBe(0)
    // t=3020：now-overloadSince=3000 ≥ 3000 → 降 1 级
    let decision = policy.pushSample(20, 3020)
    expect(decision.changed).toBe(true)
    expect(decision.direction).toBe('downgrade')
    expect(decision.level).toBe(1)
    expect(policy.level()).toBe(1)

    // 第二级：持续计时自 3020 重启，冷却 5000ms 自 3020 起算
    now = feed(policy, 20, 3040, 8000, 20)
    decision = policy.pushSample(20, now + 20) // t=8020：持续 5000 & 冷却 5000 均满足
    expect(decision.changed).toBe(true)
    expect(decision.level).toBe(2)

    // 第三级：冷却自 8020 起，t=13020 才允许
    now = feed(policy, 20, 8040, 13000, 20)
    decision = policy.pushSample(20, 13000 + 20)
    expect(decision.changed).toBe(true)
    expect(decision.level).toBe(3)
  })

  it('窗口平均跌回预算内后，过载持续重新累积 3s 才降级', () => {
    const policy = createQualityPolicy({ targetFps: 60 })
    // 过载 3s：t=3020 第一次降级（窗口平均自 t=20 起持续 >17.5）
    feed(policy, 20, 20, 3020, 20)
    expect(policy.level()).toBe(1)
    // 继续过载 180ms（冷却期），再以低负载冲刷窗口（>1s）：
    // 窗口平均跌至 10ms < 12.5 → 过载持续与空裕计时按各自条件重置
    feed(policy, 20, 3040, 3200, 20)
    feed(policy, 10, 3220, 4600, 20)
    expect(policy.level()).toBe(1)
    // 恢复过载：窗口平均需重新爬过 17.5 并持续 3s（约 t=5380 起算），
    // 且降级冷却自 3020 起满 5s → 第二次降级在 t=8380
    feed(policy, 20, 4620, 8360, 20)
    expect(policy.level()).toBe(1)
    const decision = policy.pushSample(20, 8380)
    expect(decision.changed).toBe(true)
    expect(decision.direction).toBe('downgrade')
    expect(decision.level).toBe(2)
  })

  it('空裕持续 30s 恢复一级，且恢复冷却 30s 自上次变化起算', () => {
    const policy = createQualityPolicy({ targetFps: 60 })
    // 先经一次降级建立 level 1（lastChangeAt=3020）
    feed(policy, 20, 20, 3020, 20)
    expect(policy.level()).toBe(1)
    // 低负载冲刷窗口后窗口平均 10ms < 12.5：空裕持续约 t=3980 起算；
    // 恢复需持续满 30s 且距上次变化满 30s → t=33800 才升级
    feed(policy, 10, 3040, 33780, 20)
    expect(policy.level()).toBe(1)
    const decision = policy.pushSample(10, 33800)
    expect(decision.changed).toBe(true)
    expect(decision.direction).toBe('upgrade')
    expect(decision.level).toBe(0)
  })

  it('0 级不升、4 级不降：等级钳制在 [0, 4]', () => {
    const policy = createQualityPolicy({ targetFps: 60 })
    // 长期空裕：保持 0 级
    feed(policy, 5, 10, UNDERSHOOT_SUSTAIN_MS + 10000, 20)
    expect(policy.level()).toBe(0)

    // 长期过载：降到 4 级后不再变化（4 次降级分别发生在 ~3.0/8.0/13.0/18.0s）
    const heavy = createQualityPolicy({ targetFps: 60 })
    feed(heavy, 20, 20, OVERSHOOT_SUSTAIN_MS + DOWNGRADE_COOLDOWN_MS * 3 + 30000, 20)
    expect(heavy.level()).toBe(4)
    const decision = heavy.pushSample(20, 80000)
    expect(decision.changed).toBe(false)
    expect(decision.level).toBe(4)
  })

  it('setTargetFps 切换预算并重置持续计时（车队规模跨越阈值）', () => {
    const policy = createQualityPolicy({ targetFps: 60 })
    // 20ms 对 60fps 预算过载 2.9s（未降级）
    feed(policy, 20, 20, 2920, 20)
    expect(policy.level()).toBe(0)
    // 切到 30fps：预算 33.3，20ms 落入 [25, 35) 正常区间，两侧计时均清零
    policy.setTargetFps(30)
    expect(policy.targetFps()).toBe(30)
    // 再喂 20s 也不降级（20 < 35 且 > 25，两侧条件都不成立）
    feed(policy, 20, 2940, 23000, 20)
    expect(policy.level()).toBe(0)
    // 非法目标帧率被忽略
    policy.setTargetFps(Number.NaN)
    expect(policy.targetFps()).toBe(30)
  })

  it('非有限/负数样本整体忽略：不进窗口、不动计时器', () => {
    const policy = createQualityPolicy({ targetFps: 60 })
    feed(policy, 20, 20, 2980, 20)
    const decision = policy.pushSample(Number.NaN, 2990)
    expect(decision.changed).toBe(false)
    expect(policy.level()).toBe(0)
    policy.pushSample(-1, 3000)
    policy.pushSample(Number.POSITIVE_INFINITY, 3010)
    // NaN 样本未重置计时：t=3220 时持续恰好 3000 → 降级照常发生
    const next = policy.pushSample(20, 3220)
    expect(next.changed).toBe(true)
    expect(next.level).toBe(1)
  })

  it('单样本钳制到 1000ms：异常大帧不污染窗口平均', () => {
    const policy = createQualityPolicy({ targetFps: 60 })
    const first = policy.pushSample(5000, 5000)
    expect(first.avgFrameMs).toBe(1000)
    // 窗口 (4600, 5600]：钳制后的 1000 与 600 同窗 → 平均 800
    const second = policy.pushSample(600, 5600)
    expect(second.avgFrameMs).toBeCloseTo(800, 5)
  })

  it('断流（>2s 无样本）清空窗口与持续计时，恢复后重新观察', () => {
    const policy = createQualityPolicy({ targetFps: 60 })
    feed(policy, 20, 20, 2980, 20)
    expect(policy.level()).toBe(0)
    // 3s 断流后恢复：持续计时清零（否则 t=6020 即降级）
    const decision = policy.pushSample(20, 6000)
    expect(decision.changed).toBe(false)
    feed(policy, 20, 6020, 8980, 20)
    expect(policy.level()).toBe(0)
    const resumed = policy.pushSample(20, 9000)
    expect(resumed.changed).toBe(true)
    expect(resumed.level).toBe(1)
  })

  it('reset 清空动态状态：冷却解除，等级保留', () => {
    const policy = createQualityPolicy({ targetFps: 60 })
    feed(policy, 20, 20, 3020, 20)
    expect(policy.level()).toBe(1)
    policy.reset()
    expect(policy.level()).toBe(1)
    // 冷却已清：重新持续 3s 即再次降级（无需等 5s 冷却）
    feed(policy, 20, 3030, 6010, 20)
    const decision = policy.pushSample(20, 6030)
    expect(decision.changed).toBe(true)
    expect(decision.level).toBe(2)
  })

  it('决策携带诊断上下文：平均帧时间与目标帧率', () => {
    const policy = createQualityPolicy({ targetFps: 30 })
    const decision = policy.pushSample(40, 40)
    expect(decision.targetFps).toBe(30)
    expect(decision.avgFrameMs).toBeCloseTo(40, 5)
    expect(decision.direction).toBeNull()
  })
})

describe('QualityLevel 类型完备性（编译期契约）', () => {
  it('0～4 全部等级可经能力映射产出合法开关集合', () => {
    const levels: QualityLevel[] = [0, 1, 2, 3, 4]
    for (const level of levels) {
      const caps = capabilitiesForLevel(level, { shadowMapSize: 2048 })
      expect(caps.decorationsEnabled).toBe(level < 4)
      expect(caps.dynamicShadowsEnabled).toBe(level < 3)
      expect(caps.importantLabelsOnly).toBe(level >= 1)
    }
    expect(UPGRADE_COOLDOWN_MS).toBe(30000)
    expect(UNDERSHOOT_SUSTAIN_MS).toBe(30000)
  })
})
