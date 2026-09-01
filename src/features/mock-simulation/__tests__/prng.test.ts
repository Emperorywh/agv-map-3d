/**
 * Mock PRNG 单元测试（TASK-008：固定种子复现与随机原语边界）。
 */
import { describe, expect, it } from 'vitest'
import {
  createMockPrng,
  randomInRange,
  randomInt,
} from '@/features/mock-simulation/model/prng'

describe('createMockPrng', () => {
  it('同一种子产生逐位相同的序列（固定种子复现）', () => {
    const a = createMockPrng(20260901)
    const b = createMockPrng(20260901)
    for (let i = 0; i < 1000; i += 1) {
      expect(a()).toBe(b())
    }
  })

  it('不同种子在正常使用长度内产生不同序列', () => {
    const a = createMockPrng(1)
    const b = createMockPrng(2)
    const seqA = Array.from({ length: 64 }, () => a())
    const seqB = Array.from({ length: 64 }, () => b())
    expect(seqA).not.toEqual(seqB)
  })

  it('输出恒为 [0,1) 内的有限数值', () => {
    const prng = createMockPrng(42)
    for (let i = 0; i < 10000; i += 1) {
      const value = prng()
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('非有限种子回退为 0 号状态而不是产生 NaN', () => {
    const prng = createMockPrng(Number.NaN)
    const value = prng()
    expect(Number.isFinite(value)).toBe(true)
    expect(value).toBeGreaterThanOrEqual(0)
  })
})

describe('randomInRange / randomInt', () => {
  it('randomInRange 落在 [min,max) 内', () => {
    const prng = createMockPrng(7)
    for (let i = 0; i < 1000; i += 1) {
      const value = randomInRange(prng, 2.5, 7.5)
      expect(value).toBeGreaterThanOrEqual(2.5)
      expect(value).toBeLessThan(7.5)
    }
  })

  it('randomInt 落在 [0,bound) 内且为整数', () => {
    const prng = createMockPrng(9)
    for (let i = 0; i < 1000; i += 1) {
      const value = randomInt(prng, 5)
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(5)
    }
  })

  it('非法参数按防御式回退而不是抛异常', () => {
    const prng = createMockPrng(1)
    expect(randomInRange(prng, 5, 5)).toBe(5)
    expect(randomInRange(prng, Number.NaN, 10)).toBe(Number.NaN)
    expect(randomInt(prng, 0)).toBe(0)
    expect(randomInt(prng, -3)).toBe(0)
    expect(randomInt(prng, Number.POSITIVE_INFINITY)).toBeGreaterThanOrEqual(0)
  })
})
