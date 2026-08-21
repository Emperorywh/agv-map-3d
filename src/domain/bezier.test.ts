import { describe, expect, it } from 'vitest'

import { DEFAULT_BEZIER_TOLERANCE, subdivideCubicBezier } from './bezier'
import { buildPolyline } from './polyline'
import type { MapPoint } from './types'

/** de Casteljau 求三次贝塞尔解析点（t ∈ [0,1]），用于对照细分精度 */
function cubicAt(
  p0: MapPoint,
  p1: MapPoint,
  p2: MapPoint,
  p3: MapPoint,
  t: number,
): MapPoint {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  }
}

/** 点到折线的最短距离 */
function distanceToPolyline(point: MapPoint, polyline: MapPoint[]): number {
  let min = Infinity
  for (let i = 0; i + 1 < polyline.length; i++) {
    const a = polyline[i]
    const b = polyline[i + 1]
    const abx = b.x - a.x
    const aby = b.y - a.y
    const lengthSq = abx * abx + aby * aby
    const t =
      lengthSq === 0
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * abx + (point.y - a.y) * aby) / lengthSq))
    const px = a.x + t * abx
    const py = a.y + t * aby
    min = Math.min(min, Math.hypot(point.x - px, point.y - py))
  }
  return min
}

// 近似四分之一圆弧的三次贝塞尔（曲率明显，足以触发多段细分）
const P0: MapPoint = { x: 0, y: 0 }
const P1: MapPoint = { x: 0, y: 5.5 }
const P2: MapPoint = { x: 4.5, y: 10 }
const P3: MapPoint = { x: 10, y: 10 }

describe('bezier：三次贝塞尔自适应细分（SPEC §6.2）', () => {
  it('输出包含且精确保持起点与终点', () => {
    const points = subdivideCubicBezier(P0, P1, P2, P3)
    expect(points[0]).toEqual(P0)
    expect(points[points.length - 1]).toEqual(P3)
    expect(points.length).toBeGreaterThan(2)
  })

  it('细分精度：解析曲线到折线的最大偏差不超过弦高差容差', () => {
    const tolerance = DEFAULT_BEZIER_TOLERANCE
    const points = subdivideCubicBezier(P0, P1, P2, P3, tolerance)
    let maxDeviation = 0
    for (let i = 0; i <= 2000; i++) {
      const sample = cubicAt(P0, P1, P2, P3, i / 2000)
      maxDeviation = Math.max(maxDeviation, distanceToPolyline(sample, points))
    }
    expect(maxDeviation).toBeLessThanOrEqual(tolerance)
  })

  it('容差可配：容差越小细分点越多', () => {
    const coarse = subdivideCubicBezier(P0, P1, P2, P3, 0.5)
    const fine = subdivideCubicBezier(P0, P1, P2, P3, 0.01)
    expect(fine.length).toBeGreaterThan(coarse.length)
  })

  it('控制点共线的直线型曲线自适应为两点折线', () => {
    const points = subdivideCubicBezier(
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    )
    expect(points).toHaveLength(2)
  })

  it('弦退化的闭合曲线（起点=终点）不死循环且偏差有界', () => {
    const points = subdivideCubicBezier(
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      { x: -3, y: 4 },
      { x: 0, y: 0 },
      0.05,
    )
    expect(points.length).toBeGreaterThan(2)
    expect(points[points.length - 1]).toEqual({ x: 0, y: 0 })
  })
})

describe('polyline：累积弧长表（SPEC §4.2）', () => {
  it('弧长表单调不减、首项为 0、末项为总弧长', () => {
    const points = subdivideCubicBezier(P0, P1, P2, P3)
    const polyline = buildPolyline(points)
    expect(polyline.cumulativeLengths).toHaveLength(points.length)
    expect(polyline.cumulativeLengths[0]).toBe(0)
    for (let i = 1; i < polyline.cumulativeLengths.length; i++) {
      expect(polyline.cumulativeLengths[i]).toBeGreaterThanOrEqual(
        polyline.cumulativeLengths[i - 1],
      )
    }
    expect(polyline.length).toBe(
      polyline.cumulativeLengths[polyline.cumulativeLengths.length - 1],
    )
    // 折线弧长不小于弦长（曲线弦 = |P3−P0| = √(10²+10²)）
    expect(polyline.length).toBeGreaterThanOrEqual(Math.hypot(P3.x - P0.x, P3.y - P0.y))
  })

  it('两点折线（LINE 规范化形态）弧长 = 端点距离', () => {
    const polyline = buildPolyline([
      { x: 1, y: 2 },
      { x: 4, y: 6 },
    ])
    expect(polyline.points).toHaveLength(2)
    expect(polyline.cumulativeLengths).toEqual([0, 5])
    expect(polyline.length).toBe(5)
  })
})
