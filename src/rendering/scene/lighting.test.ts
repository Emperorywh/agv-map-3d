import { describe, expect, it } from 'vitest'

import { computeDirectionalShadowFrustum } from './lighting'

// ---------------------------------------------------------------------------
// 测试夹具：真实地图口径（SPEC §4.1：x ∈ [-165.74, 2.10]，y ∈ [-25.12, 50.20]）
// ---------------------------------------------------------------------------

const REAL_BOUNDS = { minX: -165.74, minY: -25.12, maxX: 2.1, maxY: 50.2 }
const MARGIN = 8
const WALL_HEIGHT = 6

describe('computeDirectionalShadowFrustum', () => {
  it('extent 取 footprint（包围盒 + margin）外接圆半径', () => {
    const frustum = computeDirectionalShadowFrustum({
      bounds: { minX: -10, minY: -5, maxX: 10, maxY: 5 },
      margin: 2,
      direction: [0, 1, 0],
      wallHeight: 6,
    })
    // 半宽 10 + 2 = 12，半深 5 + 2 = 7 → 外接圆半径 hypot(12, 7)
    expect(frustum.extent).toBeCloseTo(Math.hypot(12, 7), 6)
  })

  it('光源位置 = 归一化方向 × 距离，且距离 = 2 ×（extent + 墙高）', () => {
    const frustum = computeDirectionalShadowFrustum({
      bounds: REAL_BOUNDS,
      margin: MARGIN,
      direction: [2, 3, 1],
      wallHeight: WALL_HEIGHT,
    })
    const range = frustum.extent + WALL_HEIGHT
    const distance = 2 * range
    const dirLength = Math.hypot(2, 3, 1)
    expect(frustum.position[0]).toBeCloseTo((2 / dirLength) * distance, 6)
    expect(frustum.position[1]).toBeCloseTo((3 / dirLength) * distance, 6)
    expect(frustum.position[2]).toBeCloseTo((1 / dirLength) * distance, 6)
  })

  it('near / far 夹住整个建筑包络（distance ∓ range）', () => {
    const frustum = computeDirectionalShadowFrustum({
      bounds: REAL_BOUNDS,
      margin: MARGIN,
      direction: [2, 3, 1],
      wallHeight: WALL_HEIGHT,
    })
    const range = frustum.extent + WALL_HEIGHT
    expect(frustum.near).toBeCloseTo(2 * range - range, 6)
    expect(frustum.far).toBeCloseTo(2 * range + range, 6)
    expect(frustum.near).toBeGreaterThan(0)
    expect(frustum.far).toBeGreaterThan(frustum.near)
  })

  it('真实地图口径下 extent 覆盖 footprint 任一角点（任意光方位保守成立）', () => {
    const frustum = computeDirectionalShadowFrustum({
      bounds: REAL_BOUNDS,
      margin: MARGIN,
      direction: [2, 3, 1],
      wallHeight: WALL_HEIGHT,
    })
    // 世界 footprint 中心在原点：角点距原点 = hypot(半宽 + margin, 半深 + margin)
    const halfWidth = (REAL_BOUNDS.maxX - REAL_BOUNDS.minX) / 2 + MARGIN
    const halfDepth = (REAL_BOUNDS.maxY - REAL_BOUNDS.minY) / 2 + MARGIN
    expect(frustum.extent).toBeCloseTo(Math.hypot(halfWidth, halfDepth), 6)
    expect(frustum.extent).toBeGreaterThanOrEqual(Math.max(halfWidth, halfDepth))
  })

  it('非对称方向向量先归一化（方向模长不影响结果）', () => {
    const short = computeDirectionalShadowFrustum({
      bounds: REAL_BOUNDS,
      margin: MARGIN,
      direction: [2, 3, 1],
      wallHeight: WALL_HEIGHT,
    })
    const long = computeDirectionalShadowFrustum({
      bounds: REAL_BOUNDS,
      margin: MARGIN,
      direction: [20, 30, 10],
      wallHeight: WALL_HEIGHT,
    })
    expect(long.position).toEqual(short.position)
    expect(long.extent).toBe(short.extent)
    expect(long.near).toBe(short.near)
    expect(long.far).toBe(short.far)
  })
})
