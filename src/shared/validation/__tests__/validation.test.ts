/*
 * shared/validation 校验原语测试（与实现共置）。
 *
 * 职责：锁定业务无关校验原语的判定边界。
 * 关键不变量：
 * 1. isFiniteNumber 对 NaN / ±Infinity / 非数值一律 false；
 * 2. isPlainObject 对数组 / null / 类实例一律 false，只接受普通 JSON 对象。
 */
import { describe, expect, it } from 'vitest'
import { isFiniteNumber, isPlainObject } from '@/shared/validation'

describe('isFiniteNumber', () => {
  it('接受有限数值（含 0 与负数）', () => {
    expect(isFiniteNumber(0)).toBe(true)
    expect(isFiniteNumber(-1.5)).toBe(true)
    expect(isFiniteNumber(Number.MAX_VALUE)).toBe(true)
  })

  it('拒绝 NaN、Infinity 与非数值类型', () => {
    expect(isFiniteNumber(Number.NaN)).toBe(false)
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isFiniteNumber(Number.NEGATIVE_INFINITY)).toBe(false)
    expect(isFiniteNumber('1')).toBe(false)
    expect(isFiniteNumber(null)).toBe(false)
    expect(isFiniteNumber(undefined)).toBe(false)
    expect(isFiniteNumber(true)).toBe(false)
  })
})

describe('isPlainObject', () => {
  it('接受普通 JSON 对象', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject({ a: 1 })).toBe(true)
    expect(isPlainObject(Object.create(null))).toBe(true)
  })

  it('拒绝数组、null 与宿主/类实例', () => {
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject('obj')).toBe(false)
    expect(isPlainObject(new Date())).toBe(false)
    expect(isPlainObject(new Map())).toBe(false)
  })
})
