/**
 * 交通矩形生成测试（TASK-009 / SPEC §9.3「交通矩形按占用路径生成有效点序」）。
 *
 * 覆盖：8 数值形态与有限性、绕向一致的无自交凸四边形（叉积同号）、朝向
 *       对齐（theta 决定矩形方向）、locked 最紧 / applying 逐级外扩的形态
 *       与真实夹具一致、退化朝向（0/±π）不产生自交。
 */
import { describe, expect, it } from 'vitest'
import {
  buildPathAlignedQuad,
  buildTrafficRectangles,
  TRAFFIC_APPLYING_STEP_ONE_M,
  TRAFFIC_APPLYING_STEP_TWO_M,
  TRAFFIC_LOCKED_MARGIN_M,
} from '../model/trafficRectangle'

/** 全部叉积同号（允许 0）⇔ 简单凸多边形（无自交） */
function expectConvex(quad: readonly number[]): void {
  expect(quad).toHaveLength(8)
  for (const value of quad) {
    expect(Number.isFinite(value)).toBe(true)
  }
  const signs: number[] = []
  for (let i = 0; i < 4; i += 1) {
    const x1 = quad[i * 4]
    const y1 = quad[i * 4 + 1]
    const x2 = quad[((i + 1) % 4) * 4]
    const y2 = quad[((i + 1) % 4) * 4 + 1]
    const x3 = quad[((i + 2) % 4) * 4]
    const y3 = quad[((i + 2) % 4) * 4 + 1]
    signs.push(Math.sign((x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1)))
  }
  const nonZero = signs.filter((s) => s !== 0)
  expect(new Set(nonZero).size).toBeLessThanOrEqual(1)
}

describe('buildPathAlignedQuad', () => {
  it('朝向 0 时生成轴对齐矩形，四角绕向一致', () => {
    const quad = buildPathAlignedQuad({ x: 10, y: 5, theta: 0 }, 1, 0.4)
    expectConvex(quad)
    // 车头 +x：x 范围 [9, 11]，y 范围 [4.6, 5.4]
    const xs = quad.filter((_, i) => i % 2 === 0)
    const ys = quad.filter((_, i) => i % 2 === 1)
    expect(Math.min(...xs)).toBeCloseTo(9, 10)
    expect(Math.max(...xs)).toBeCloseTo(11, 10)
    expect(Math.min(...ys)).toBeCloseTo(4.6, 10)
    expect(Math.max(...ys)).toBeCloseTo(5.4, 10)
  })

  it('朝向 π/2 时矩形沿 +y 展开（随占用路径切线旋转）', () => {
    const quad = buildPathAlignedQuad({ x: 0, y: 0, theta: Math.PI / 2 }, 2, 0.5)
    expectConvex(quad)
    const xs = quad.filter((_, i) => i % 2 === 0)
    const ys = quad.filter((_, i) => i % 2 === 1)
    expect(Math.min(...xs)).toBeCloseTo(-0.5, 10)
    expect(Math.max(...xs)).toBeCloseTo(0.5, 10)
    expect(Math.min(...ys)).toBeCloseTo(-2, 10)
    expect(Math.max(...ys)).toBeCloseTo(2, 10)
  })

  it('退化朝向 0/±π 与任意角度都不产生自交', () => {
    for (const theta of [0, Math.PI, -Math.PI, 0.7, -2.3]) {
      expectConvex(buildPathAlignedQuad({ x: 3, y: -4, theta }, 1.2, 0.35))
    }
  })
})

describe('buildTrafficRectangles', () => {
  it('locked 最紧、applying 逐级外扩（与真实夹具形态一致）', () => {
    const { locked, applying } = buildTrafficRectangles(
      { x: 0, y: 0, theta: 0 },
      { halfLength: 0.9, halfWidth: 0.35 },
    )
    expect(locked).toHaveLength(1)
    expect(applying).toHaveLength(2)
    expectConvex(locked[0])
    expectConvex(applying[0])
    expectConvex(applying[1])

    const spanX = (quad: readonly number[]): number =>
      Math.max(...quad.filter((_, i) => i % 2 === 0)) -
      Math.min(...quad.filter((_, i) => i % 2 === 0))
    // locked = footprint + 最小裕量；applying = locked + 逐级步长
    expect(spanX(locked[0])).toBeCloseTo(1.8 + 2 * TRAFFIC_LOCKED_MARGIN_M, 10)
    expect(spanX(applying[0])).toBeCloseTo(
      spanX(locked[0]) + 2 * TRAFFIC_APPLYING_STEP_ONE_M,
      10,
    )
    expect(spanX(applying[1])).toBeCloseTo(
      spanX(locked[0]) + 2 * TRAFFIC_APPLYING_STEP_TWO_M,
      10,
    )
  })

  it('矩形随车辆位置平移（占用路径的动态包络）', () => {
    const atOrigin = buildPathAlignedQuad({ x: 0, y: 0, theta: 0 }, 1, 0.4)
    const moved = buildPathAlignedQuad({ x: 203.24, y: 4.56, theta: 0 }, 1, 0.4)
    expect(moved[0]).toBeCloseTo(atOrigin[0] + 203.24, 10)
    expect(moved[1]).toBeCloseTo(atOrigin[1] + 4.56, 10)
  })
})
