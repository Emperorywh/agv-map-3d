/**
 * Mock 速度裁决单元测试（TASK-008：目标速度 0.5～1.5 采样与边上限速钳制）。
 */
import { describe, expect, it } from 'vitest'
import {
  MOCK_SPEED_MAX_MPS,
  MOCK_SPEED_MIN_MPS,
  resolveCruiseSpeed,
  resolveEdgeSpeedLimit,
  sampleTargetSpeed,
} from '@/features/mock-simulation/model/motion'
import { createMockPrng } from '@/features/mock-simulation/model/prng'
import type { MapEdge } from '@/features/map-visualization'
import { makeLineEdge } from './fixtures'

/** 只取几何与限速字段的最小边（speed 裁决不关心拓扑引用） */
function edgeWith(overrides: Partial<MapEdge>): MapEdge {
  return makeLineEdge(overrides) as unknown as MapEdge
}

describe('sampleTargetSpeed', () => {
  it('采样值恒落在 [0.5, 1.5] 目标速度区间', () => {
    const prng = createMockPrng(20260901)
    for (let i = 0; i < 1000; i += 1) {
      const speed = sampleTargetSpeed(prng)
      expect(speed).toBeGreaterThanOrEqual(MOCK_SPEED_MIN_MPS)
      expect(speed).toBeLessThanOrEqual(MOCK_SPEED_MAX_MPS)
    }
  })

  it('固定种子下采样序列可复现', () => {
    const a = Array.from({ length: 10 }, () => sampleTargetSpeed(createMockPrng(5)))
    const b = Array.from({ length: 10 }, () => sampleTargetSpeed(createMockPrng(5)))
    expect(a).toEqual(b)
  })
})

describe('resolveEdgeSpeedLimit', () => {
  it('载荷车用 maxLoadSpeed，空载车用 maxFreeSpeed', () => {
    const edge = edgeWith({ maxLoadSpeed: 0.3, maxFreeSpeed: 0.8 })
    expect(resolveEdgeSpeedLimit(edge, true)).toBe(0.3)
    expect(resolveEdgeSpeedLimit(edge, false)).toBe(0.8)
  })

  it('限速缺失（null）或非法（非有限/非正）视为不限速', () => {
    expect(resolveEdgeSpeedLimit(edgeWith({ maxFreeSpeed: null }), false)).toBeNull()
    expect(resolveEdgeSpeedLimit(edgeWith({ maxLoadSpeed: null }), true)).toBeNull()
    expect(resolveEdgeSpeedLimit(edgeWith({ maxFreeSpeed: Number.NaN }), false)).toBeNull()
    expect(resolveEdgeSpeedLimit(edgeWith({ maxLoadSpeed: -1 }), true)).toBeNull()
    expect(resolveEdgeSpeedLimit(edgeWith({ maxLoadSpeed: 0 }), true)).toBeNull()
  })
})

describe('resolveCruiseSpeed', () => {
  it('目标速度被限速钳制（取更小者）', () => {
    expect(resolveCruiseSpeed(1.5, 0.8)).toBe(0.8)
    expect(resolveCruiseSpeed(0.6, 2)).toBe(0.6)
  })

  it('不限速时直接使用目标速度', () => {
    expect(resolveCruiseSpeed(1.23, null)).toBe(1.23)
  })

  it('结果永不为负或超区间（防御非法输入）', () => {
    expect(resolveCruiseSpeed(Number.NaN, null)).toBe(MOCK_SPEED_MIN_MPS)
    expect(resolveCruiseSpeed(-5, null)).toBe(MOCK_SPEED_MIN_MPS)
    expect(resolveCruiseSpeed(99, null)).toBe(MOCK_SPEED_MAX_MPS)
  })
})
