/**
 * 折线构建（domain 纯函数）。
 * LINE 与 BEZIER 细分结果统一经 buildPolyline 生成带累积弧长表的 Polyline（SPEC §4.2）。
 */

import type { MapPoint, Polyline } from './types'

/**
 * 由点列构建折线：计算单调不减的累积弧长表与总弧长。
 * 调用方需保证 points 至少 2 个点（normalize / bezier 均已保证）。
 */
export function buildPolyline(points: MapPoint[]): Polyline {
  const cumulativeLengths: number[] = new Array<number>(points.length)
  cumulativeLengths[0] = 0
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x
    const dy = points[i].y - points[i - 1].y
    cumulativeLengths[i] = cumulativeLengths[i - 1] + Math.hypot(dx, dy)
  }
  return {
    points,
    cumulativeLengths,
    length: cumulativeLengths[points.length - 1],
  }
}
