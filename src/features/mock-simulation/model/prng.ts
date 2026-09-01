/**
 * Mock 仿真确定性伪随机数生成器（SPEC §9.3；TASK-008）。
 *
 * 职责：提供固定种子、可复现、调用顺序稳定的伪随机原语（均匀 [0,1) 随机数、
 *       区间随机数、整型随机数），作为 Mock 内核全部随机决策（车辆放置、
 *       目标速度采样、出边选择等）的唯一随机来源。
 * 边界：纯函数模块——不持有全局状态、不访问系统随机源、不依赖时间；随机性
 *       完全由种子决定。上层内核必须保证「同一份状态按同一顺序消费同一
 *       PRNG 流」，随机决策才可复现。
 * 关键不变量：
 * 1. 同一种子产生的序列逐位相同；不同种子在正常使用长度内产生不同序列；
 * 2. 输出恒为 [0,1) 区间内的有限数值，绝不返回 1 或负数；
 * 3. randomInt 在 bound ≥ 1 时恒返回 [0, bound) 内整数，bound < 1 时返回 0
 *    （调用方以防御式回退代替异常，保证仿真永不因随机原语中断）。
 */

/**
 * Mock 仿真的默认随机种子（SPEC §9.3：默认 20260901，相同配置必须产生
 * 可复现事件序列）。内核将其作为缺省种子，数据源层（TASK-009）不得另定默认。
 */
export const DEFAULT_MOCK_SEED = 20260901

/** 均匀 [0,1) 随机数发生器：连续调用产生确定性序列 */
export type MockPrng = () => number

/**
 * 创建 mulberry32 伪随机数发生器。
 * 选用理由：32 位种子、实现极简、周期与分布在 Mock 场景足够，且纯算术
 * （不依赖 Math.random），同种子跨平台结果一致。
 */
export function createMockPrng(seed: number): MockPrng {
  // 种子归一为 uint32：非有限值回退 0，保证任意输入都得到可用发生器
  let state = Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    // mulberry32 扩散：位移混合后归一到 [0,1)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** [min,max) 均匀随机数；非法区间（min ≥ max 或非有限）时回退 min */
export function randomInRange(prng: MockPrng, min: number, max: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return min
  }
  return min + prng() * (max - min)
}

/** [0,bound) 均匀整型；bound < 1 或非有限时回退 0（防御式，不抛异常） */
export function randomInt(prng: MockPrng, bound: number): number {
  if (!Number.isFinite(bound) || bound < 1) {
    return 0
  }
  return Math.floor(prng() * bound)
}
