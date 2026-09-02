/*
 * contextRecovery 状态机测试（TASK-016；SPEC §11.9）。
 *
 * 职责：以表驱动时间线验证恢复状态机的全部转移合同——丢失进入恢复期、
 *       恢复递增资源代、结算成功清零失败计数、连续失败重试与放弃、stopped
 *       吸收态、无丢失的 restored 噪声忽略。纯函数无副作用，直接断言返回值。
 */
import { describe, expect, it } from 'vitest'
import {
  applyContextLost,
  applyContextRestored,
  applyRecoverySettled,
  applyRetryAttempt,
  CONTEXT_RECOVERY_RETRY_DELAY_MS,
  INITIAL_CONTEXT_RECOVERY_STATE,
  MAX_CONTEXT_RECOVERY_FAILURES,
} from '../contextRecovery'

describe('contextRecovery 状态机', () => {
  it('running 收到 lost 进入 recovering；重复 lost 不改变状态', () => {
    const lost = applyContextLost(INITIAL_CONTEXT_RECOVERY_STATE)
    expect(lost.changed).toBe(true)
    expect(lost.state.phase).toBe('recovering')
    expect(lost.state.generation).toBe(0)

    const lostAgain = applyContextLost(lost.state)
    expect(lostAgain.changed).toBe(false)
    expect(lostAgain.state).toBe(lost.state)
  })

  it('recovering 收到 restored 递增资源代；running 下的 restored 视为噪声忽略', () => {
    const noise = applyContextRestored(INITIAL_CONTEXT_RECOVERY_STATE)
    expect(noise.changed).toBe(false)
    expect(noise.state).toBe(INITIAL_CONTEXT_RECOVERY_STATE)

    const lost = applyContextLost(INITIAL_CONTEXT_RECOVERY_STATE).state
    const restored = applyContextRestored(lost)
    expect(restored.changed).toBe(true)
    expect(restored.state.phase).toBe('recovering')
    expect(restored.state.generation).toBe(1)
  })

  it('结算成功回到 running 并清零失败计数；下一轮丢失从零计数', () => {
    let state = applyContextLost(INITIAL_CONTEXT_RECOVERY_STATE).state
    state = applyContextRestored(state).state
    // 先制造一次失败累计，验证成功清零
    state = applyRecoverySettled(state, false).state
    expect(state.consecutiveFailures).toBe(1)

    state = applyContextRestored(state).state
    const settled = applyRecoverySettled(state, true)
    expect(settled.changed).toBe(true)
    expect(settled.state.phase).toBe('running')
    expect(settled.state.consecutiveFailures).toBe(0)
    expect(settled.shouldRetry).toBe(false)
    expect(settled.gaveUp).toBe(false)
  })

  it('恢复中车辆更新不改变状态机：recovering 期结算前持续暂停（文档性行为锁定）', () => {
    // 恢复期内反复 restored（驱动重建）始终停留在 recovering，直至结算
    let state = applyContextLost(INITIAL_CONTEXT_RECOVERY_STATE).state
    state = applyContextRestored(state).state
    state = applyContextRestored(state).state
    expect(state.phase).toBe('recovering')
    expect(state.generation).toBe(2)
  })

  it(`连续 ${MAX_CONTEXT_RECOVERY_FAILURES - 1} 次失败安排重试（重试=资源代再递增）；第 ${MAX_CONTEXT_RECOVERY_FAILURES} 次失败放弃并进入 stopped`, () => {
    let state = applyContextLost(INITIAL_CONTEXT_RECOVERY_STATE).state
    state = applyContextRestored(state).state

    for (let attempt = 1; attempt < MAX_CONTEXT_RECOVERY_FAILURES; attempt += 1) {
      const settled = applyRecoverySettled(state, false)
      expect(settled.changed).toBe(true)
      expect(settled.shouldRetry).toBe(true)
      expect(settled.gaveUp).toBe(false)
      expect(settled.state.consecutiveFailures).toBe(attempt)
      expect(settled.state.phase).toBe('recovering')
      // 重试在 CONTEXT_RECOVERY_RETRY_DELAY_MS 后再次递增资源代
      const retried = applyRetryAttempt(settled.state)
      expect(retried.changed).toBe(true)
      expect(retried.state.generation).toBe(settled.state.generation + 1)
      state = retried.state
    }

    const gaveUp = applyRecoverySettled(state, false)
    expect(gaveUp.gaveUp).toBe(true)
    expect(gaveUp.shouldRetry).toBe(false)
    expect(gaveUp.state.phase).toBe('stopped')
    expect(gaveUp.state.consecutiveFailures).toBe(MAX_CONTEXT_RECOVERY_FAILURES)
  })

  it('stopped 是吸收态：lost/restored/settled/retry 全部忽略', () => {
    let state = applyContextLost(INITIAL_CONTEXT_RECOVERY_STATE).state
    state = applyContextRestored(state).state
    for (let i = 0; i < MAX_CONTEXT_RECOVERY_FAILURES; i += 1) {
      state = applyRecoverySettled(state, false).state
      if (i < MAX_CONTEXT_RECOVERY_FAILURES - 1) {
        state = applyRetryAttempt(state).state
      }
    }
    expect(state.phase).toBe('stopped')

    expect(applyContextLost(state).changed).toBe(false)
    expect(applyContextRestored(state).changed).toBe(false)
    expect(applyRecoverySettled(state, true).changed).toBe(false)
    expect(applyRetryAttempt(state).changed).toBe(false)
  })

  it('成功恢复后失败计数清零：新的一轮丢失需要重新连续失败三次', () => {
    // 第一轮：两次失败后成功
    let state = applyContextLost(INITIAL_CONTEXT_RECOVERY_STATE).state
    state = applyContextRestored(state).state
    state = applyRecoverySettled(state, false).state
    state = applyRetryAttempt(state).state
    state = applyRecoverySettled(state, true).state
    expect(state.phase).toBe('running')
    expect(state.consecutiveFailures).toBe(0)

    // 第二轮：再次连续失败三次才放弃（不跨成功恢复累计）
    state = applyContextLost(state).state
    state = applyContextRestored(state).state
    state = applyRecoverySettled(state, false).state
    state = applyRetryAttempt(state).state
    state = applyRecoverySettled(state, false).state
    state = applyRetryAttempt(state).state
    const final = applyRecoverySettled(state, false)
    expect(final.gaveUp).toBe(true)
  })

  it('常量合同：重试延迟为 1s，连续失败上限为 3', () => {
    expect(CONTEXT_RECOVERY_RETRY_DELAY_MS).toBe(1000)
    expect(MAX_CONTEXT_RECOVERY_FAILURES).toBe(3)
    expect(INITIAL_CONTEXT_RECOVERY_STATE).toEqual({
      phase: 'running',
      generation: 0,
      consecutiveFailures: 0,
    })
  })
})
