/**
 * 逻辑边几何计算（TASK-003：物理长度；TASK-004 渲染几何将复用同一采样）。
 *
 * 职责：为 LINE/BEZIER 逻辑边给出统一的物理长度；BEZIER 以固定段数采样为
 *       全应用唯一的离散化基准，并提供采样点序列供后续几何构建复用。
 * 边界：纯几何函数；入参假定已经 validateMap 保证为有限数值，本模块不做
 *       校验，也不创建任何 Three.js 对象。
 * 关键不变量：
 * 1. BEZIER_SAMPLE_SEGMENTS = 24 是贝塞尔离散化的唯一段数（SPEC §2.2），
 *   长度计算、后续静态几何与 Mock 弧长表必须复用同一采样，保证口径一致；
 * 2. 物理长度只取决于边自身几何坐标（sx..dy），与节点坐标、边方向无关；
 * 3. 采样恒为 segments+1 个点，且 t=0/1 处与原始端点完全重合（三次贝塞尔
 *    端点插值无漂移）。
 */
import type { EdgeType } from './types'

/** BEZIER 采样段数（SPEC §2.2：每条固定 24 段） */
export const BEZIER_SAMPLE_SEGMENTS = 24

/** 计算物理长度所需的最小边几何字段 */
export interface EdgeGeometryInput {
  edgeType: EdgeType
  sx: number
  sy: number
  ex: number
  ey: number
  cx: number | null
  cy: number | null
  dx: number | null
  dy: number | null
}

/** 平面点序列（地图坐标单位：米） */
export interface PlanePoint2 {
  x: number
  y: number
}

/** 三次贝塞尔按均匀参数 t 采样 segments 段，返回 segments+1 个点 */
export function sampleCubicBezier(
  sx: number,
  sy: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  ex: number,
  ey: number,
  segments: number,
): PlanePoint2[] {
  const points: PlanePoint2[] = []
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments
    const u = 1 - t
    // 三次贝塞尔 Bernstein 基：(1-t)³·P0 + 3(1-t)²t·P1 + 3(1-t)t²·P2 + t³·P3
    const b0 = u * u * u
    const b1 = 3 * u * u * t
    const b2 = 3 * u * t * t
    const b3 = t * t * t
    points.push({
      x: b0 * sx + b1 * cx + b2 * dx + b3 * ex,
      y: b0 * sy + b1 * cy + b2 * dy + b3 * ey,
    })
  }
  return points
}

/** 折线长度：相邻采样点弦长之和 */
export function polylineLength(points: readonly PlanePoint2[]): number {
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  }
  return total
}

/**
 * 逻辑边物理长度：LINE 为端点直线距离；BEZIER 为固定 24 段采样折线长度。
 * 结果恒为非负有限数（入坐标已由 validateMap 保证有限）。
 */
export function computeEdgeGeometryLength(edge: EdgeGeometryInput): number {
  if (edge.edgeType === 'LINE') {
    return Math.hypot(edge.ex - edge.sx, edge.ey - edge.sy)
  }
  const points = sampleCubicBezier(
    edge.sx,
    edge.sy,
    // BEZIER 控制点已由 validateMap 保证为非空有限数值
    edge.cx as number,
    edge.cy as number,
    edge.dx as number,
    edge.dy as number,
    edge.ex,
    edge.ey,
    BEZIER_SAMPLE_SEGMENTS,
  )
  return polylineLength(points)
}
