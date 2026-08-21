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

/** 折线弧长采样结果 */
export interface PolylineSample {
  /** 采样点（地图平面坐标） */
  point: MapPoint
  /** 单位切向（沿 points 顺序方向）；折线全程退化时为 (1, 0) 兜底 */
  tangent: MapPoint
}

/** 零长度段判定阈值（米） */
const SEGMENT_EPSILON = 1e-12

/**
 * 按弧长采样折线（SPEC §7.2 弧长参数化；走廊配对偏差采样与箭头布置也复用）。
 * @param arcLength 目标弧长，自动夹取到 [0, length]
 */
export function samplePolylineAt(polyline: Polyline, arcLength: number): PolylineSample {
  const { points, cumulativeLengths, length } = polyline
  const s = Math.min(Math.max(arcLength, 0), length)

  // 二分查找：最大的段索引 i（0..n-2）使 cumulativeLengths[i] <= s
  let lo = 0
  let hi = points.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (cumulativeLengths[mid] <= s) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }

  const a = points[lo]
  const b = points[lo + 1]
  const segmentLength = cumulativeLengths[lo + 1] - cumulativeLengths[lo]
  const t = segmentLength > SEGMENT_EPSILON ? (s - cumulativeLengths[lo]) / segmentLength : 0
  return {
    point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
    tangent: segmentTangent(points, lo),
  }
}

/** 段切向：零长度段时向后、再向前找最近非零段；全程退化兜底 (1, 0) */
function segmentTangent(points: MapPoint[], segmentIndex: number): MapPoint {
  for (let i = segmentIndex; i < points.length - 1; i++) {
    const tangent = unitTangent(points[i], points[i + 1])
    if (tangent !== null) {
      return tangent
    }
  }
  for (let i = segmentIndex - 1; i >= 0; i--) {
    const tangent = unitTangent(points[i], points[i + 1])
    if (tangent !== null) {
      return tangent
    }
  }
  return { x: 1, y: 0 }
}

function unitTangent(a: MapPoint, b: MapPoint): MapPoint | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  if (length <= SEGMENT_EPSILON) {
    return null
  }
  return { x: dx / length, y: dy / length }
}
