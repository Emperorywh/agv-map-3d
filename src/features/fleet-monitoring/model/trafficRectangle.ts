/**
 * 交通矩形规范化与哈希（SPEC §5.3、§7.3、§11.8；TASK-012）。
 *
 * 职责：把任意 unknown 的单个交通矩形负载裁决为「无自交凸四边形」的规范化
 *       形态——8 个有限数值 → 四点、去重、质心极角排序、凸性与面积校验；
 *       并提供与几何身份一一对应的规范化哈希，供交通资源层以「哈希变化」
 *       作为唯一重建判据。无效矩形返回 null，由调用方跳过渲染并给所属车
 *       传播 INVALID_DATA（SPEC §5.3 第 5 步）。
 * 边界：纯几何函数，无时钟、无 IO、无 React/Three 依赖；点保持在地图平面
 *       坐标系（统一坐标转换由消费方经 WorldTransform 完成，本模块不感知
 *       世界坐标）；三角化属于几何构建（凸四边形固定索引方案），不在本模块。
 * 关键不变量：
 * 1. 输出点序稳定：恰 4 个唯一点、按质心极角升序（逆时针环）——同一几何的
 *    任意输入点序（含乱序、起点不同、绕向相反）规范化后点序与哈希完全一致；
 * 2. 判定只拒绝、不改写：非数组、数量不为 8、任一数值非有限、去重后不足
 *    4 点、非严格凸、面积低于阈值一律返回 null——绝不「修复」可疑输入；
 * 3. 哈希仅由规范化几何决定：坐标按 0.1mm 精度取整编码，微小抖动（低于
 *    精度）不改变哈希，2Hz 高频消息中几何未变的矩形不会触发下游重建。
 */

import type { PlanePoint } from '@/shared/spatial'
import type { RawTrafficResources } from './types'

/** 重复点合并阈值（米）：低于该距离的两点视为同一点 */
export const TRAFFIC_POINT_EPSILON_M = 1e-6

/** 有效凸四边形的最小面积阈值（平方米，SPEC §5.3「面积大于最小阈值」） */
export const MIN_TRAFFIC_AREA_M2 = 0.01

/** 凸性判定的叉积下限（平方米）：共线/近共线三元组按非严格凸拒绝 */
const CONVEX_CROSS_EPSILON_M2 = 1e-9

/** 哈希坐标取整精度（米）：0.1mm */
const HASH_QUANTUM_M = 1e-4

/** 规范化后的交通矩形：地图平面坐标下的逆时针凸四边形 */
export interface NormalizedTrafficRectangle {
  /** 恰 4 个唯一顶点，按质心极角升序（无自交环） */
  readonly points: readonly PlanePoint[]
  /** 有向面积（平方米，恒为正） */
  readonly area: number
  /** 规范化几何哈希：只由顶点几何决定，与输入点序无关 */
  readonly hash: string
}

/**
 * 规范化单个交通矩形负载。
 * 期望形态为 8 个有限数值的扁平数组（与当前夹具和 Mock 输出同构：
 * [x1,y1,x2,y2,x3,y3,x4,y4]）；任何形态或几何判定失败都返回 null。
 */
export function normalizeTrafficRectangle(raw: unknown): NormalizedTrafficRectangle | null {
  const values = readEightFiniteNumbers(raw)
  if (values === null) {
    return null
  }
  const points: PlanePoint[] = []
  for (let i = 0; i < 8; i += 2) {
    const candidate = { x: values[i], y: values[i + 1] }
    // 去重：与已保留点距离低于阈值视为同一点（SPEC §5.3 第 1 步）
    if (!points.some((p) => dist2(p, candidate) < square(TRAFFIC_POINT_EPSILON_M))) {
      points.push(candidate)
    }
  }
  // 少于 4 个唯一点无法构成凸四边形（多于 4 只可能因去重阈值异常，同样拒绝）
  if (points.length !== 4) {
    return null
  }

  sortPointsByCentroidAngle(points)
  if (!isStrictlyConvexQuad(points)) {
    return null
  }
  const area = polygonArea(points)
  if (!(area > MIN_TRAFFIC_AREA_M2)) {
    return null
  }
  return { points: Object.freeze(points), area, hash: hashPoints(points) }
}

/** 判定一组交通资源中是否存在无法形成有效凸四边形的矩形（INVALID_DATA 依据） */
export function trafficHasInvalidRectangle(resources: RawTrafficResources | null): boolean {
  if (resources === null) {
    return false
  }
  for (const rect of resources.lockedRectangles) {
    if (normalizeTrafficRectangle(rect) === null) {
      return true
    }
  }
  for (const rect of resources.applyingRectangles) {
    if (normalizeTrafficRectangle(rect) === null) {
      return true
    }
  }
  return false
}

/** 读取 8 个有限数值；非数组、长度不为 8 或任一数值非有限都返回 null */
function readEightFiniteNumbers(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length !== 8) {
    return null
  }
  const values: number[] = []
  for (const item of raw) {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      return null
    }
    values.push(item)
  }
  return values
}

/** 按质心极角升序原地排序；同角按离质心距离升序（决胜稳定且确定） */
function sortPointsByCentroidAngle(points: PlanePoint[]): void {
  const cx = (points[0].x + points[1].x + points[2].x + points[3].x) / 4
  const cy = (points[0].y + points[1].y + points[2].y + points[3].y) / 4
  points.sort((a, b) => {
    const angleA = Math.atan2(a.y - cy, a.x - cx)
    const angleB = Math.atan2(b.y - cy, b.x - cx)
    if (angleA !== angleB) {
      return angleA - angleB
    }
    return dist2(a, { x: cx, y: cy }) - dist2(b, { x: cx, y: cy })
  })
}

/** 严格凸判定：极角序下相邻边叉积必须全部为正（逆时针且无共线三元组） */
function isStrictlyConvexQuad(points: readonly PlanePoint[]): boolean {
  for (let i = 0; i < 4; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % 4]
    const c = points[(i + 2) % 4]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (!(cross > CONVEX_CROSS_EPSILON_M2)) {
      return false
    }
  }
  return true
}

/** 鞋带公式面积（顶点为逆时针环时恒为正） */
function polygonArea(points: readonly PlanePoint[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum) / 2
}

/** 规范化哈希：按 0.1mm 精度取整后顺序编码（-0 归一为 0） */
function hashPoints(points: readonly PlanePoint[]): string {
  const parts: string[] = []
  for (const p of points) {
    parts.push(
      `${Math.round(p.x / HASH_QUANTUM_M)},${Math.round(p.y / HASH_QUANTUM_M)}`,
    )
  }
  return parts.join(';')
}

function dist2(a: PlanePoint, b: PlanePoint): number {
  return square(a.x - b.x) + square(a.y - b.y)
}

function square(v: number): number {
  return v * v
}
