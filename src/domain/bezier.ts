/**
 * 三次贝塞尔自适应细分（SPEC §4.2 / §6.2）。
 *
 * 以弦高差（控制点到弦的最大距离）为平坦度判据递归二分（de Casteljau），
 * 输出折线点列；弧长表由 polyline.ts 的 buildPolyline 统一生成。
 * domain 层不 import config，容差由调用方传入（缺省 DEFAULT_BEZIER_TOLERANCE）。
 */

import type { MapPoint } from './types'

/** 细分弦高差容差缺省值（米，SPEC §6.2 默认 0.05，可配） */
export const DEFAULT_BEZIER_TOLERANCE = 0.05

/** 递归深度上限：2^20 段已远超任何实际需求，仅防病态输入死循环 */
const MAX_SUBDIVISION_DEPTH = 20

/** 点到弦（起点-终点连线）的垂直距离；弦退化时退化为到起点的距离 */
function chordHeight(point: MapPoint, start: MapPoint, end: MapPoint): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const chordLength = Math.hypot(dx, dy)
  if (chordLength < 1e-12) {
    return Math.hypot(point.x - start.x, point.y - start.y)
  }
  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / chordLength
}

/**
 * 三次贝塞尔自适应细分。
 * @param p0 起点 / p1 控制点1 / p2 控制点2 / p3 终点
 * @param tolerance 弦高差容差（米）
 * @returns 折线点列（含起点与终点，至少 2 个点），供 buildPolyline 生成弧长表
 */
export function subdivideCubicBezier(
  p0: MapPoint,
  p1: MapPoint,
  p2: MapPoint,
  p3: MapPoint,
  tolerance: number = DEFAULT_BEZIER_TOLERANCE,
): MapPoint[] {
  const points: MapPoint[] = [p0]
  subdivideInto(p0, p1, p2, p3, tolerance, 0, points)
  return points
}

/** 递归细分：平坦则只记录终点，否则按 t=0.5 二分后分别递归（保证输出顺序沿曲线单调） */
function subdivideInto(
  p0: MapPoint,
  p1: MapPoint,
  p2: MapPoint,
  p3: MapPoint,
  tolerance: number,
  depth: number,
  out: MapPoint[],
): void {
  const flatEnough =
    Math.max(chordHeight(p1, p0, p3), chordHeight(p2, p0, p3)) <= tolerance
  if (flatEnough || depth >= MAX_SUBDIVISION_DEPTH) {
    out.push(p3)
    return
  }
  // de Casteljau 二分
  const m01 = midpoint(p0, p1)
  const m12 = midpoint(p1, p2)
  const m23 = midpoint(p2, p3)
  const m012 = midpoint(m01, m12)
  const m123 = midpoint(m12, m23)
  const m0123 = midpoint(m012, m123)
  subdivideInto(p0, m01, m012, m0123, tolerance, depth + 1, out)
  subdivideInto(m0123, m123, m23, p3, tolerance, depth + 1, out)
}

function midpoint(a: MapPoint, b: MapPoint): MapPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}
