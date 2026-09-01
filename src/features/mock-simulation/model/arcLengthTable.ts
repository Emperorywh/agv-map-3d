/**
 * Mock 边弧长表（SPEC §9.2；TASK-008）。
 *
 * 职责：为单条逻辑边建立「弧长 → 位置/朝向」的确定性遍历表：LINE 线性推进；
 *       BEZIER 以全应用统一的 24 段采样（BEZIER_SAMPLE_SEGMENTS）建立累计
 *       弧长表，按弧长线性插值推进，theta 取曲线切线方向。是 Mock 内核
 *       「按距离推进」的唯一几何口径。
 * 边界：纯几何函数——只消费 MapEdge 的只读几何字段；贝塞尔采样复用
 *       map-visualization 公开入口的 sampleCubicBezier，保证与物理长度、
 *       渲染几何三方离散化口径一致；不创建 Three.js 对象。
 * 关键不变量：
 * 1. 表总长与 MapEdge.length 一致（同一采样、同一折线求长，误差仅为浮点
 *   舍入级别），共置测试以真实地图边锁定；
 * 2. 弧长参数化：推进 d 米的落点只取决于「从起点出发的累计弧长 d」，与
 *   到达方式（一次推进/分段累进）无关——大时间差与小步长推进不产生几何漂移；
 * 3. 端点守恒：d=0 恒为起点坐标，d=length 恒为终点坐标（三次贝塞尔端点
 *   插值无漂移）；越界弧长被钳制到 [0, length]，不外溢；
 * 4. 朝向：LINE 为恒定的边方向角；BEZIER 为解析切线方向
 *   B'(t)=3(1-t)²(P1-P0)+6(1-t)t(P2-P1)+3t²(P3-P2)，切线退化时按
 *   「段弦向 → 端点弦向 → 0」逐级回退，永不产生 NaN 朝向。
 */
import { BEZIER_SAMPLE_SEGMENTS, sampleCubicBezier, type MapEdge } from '@/features/map-visualization'

/** 弧长采样结果：地图坐标位置（米）与朝向（弧度，0 指向 +x） */
export interface ArcLengthSample {
  readonly x: number
  readonly y: number
  readonly theta: number
}

/**
 * 边遍历表：以弧长（米）查询边上的位置与朝向。
 * totalLength 是本表的离散化总长（BEZIER 为 24 段折线长），查询时以此钳制。
 */
export interface EdgeTraverseTable {
  readonly edgeId: string
  readonly totalLength: number
  sample(distanceM: number): ArcLengthSample
}

/** atan2 的退化安全包装：dx/dy 均不可用（模长过小）时返回 fallback */
function safeAtan2(dy: number, dx: number, fallback: number): number {
  if (!Number.isFinite(dy) || !Number.isFinite(dx) || Math.hypot(dx, dy) < 1e-12) {
    return fallback
  }
  return Math.atan2(dy, dx)
}

/** 三次贝塞尔解析切线方向：参数 t 处的 dB/dt 方向角；切向量退化时返回 null */
function bezierTangentTheta(
  sx: number, sy: number,
  cx: number, cy: number,
  dx: number, dy: number,
  ex: number, ey: number,
  t: number,
): number | null {
  const u = 1 - t
  const tx = 3 * u * u * (cx - sx) + 6 * u * t * (dx - cx) + 3 * t * t * (ex - dx)
  const ty = 3 * u * u * (cy - sy) + 6 * u * t * (dy - cy) + 3 * t * t * (ey - dy)
  if (!Number.isFinite(tx) || !Number.isFinite(ty) || Math.hypot(tx, ty) < 1e-12) {
    return null
  }
  return Math.atan2(ty, tx)
}

/** LINE 遍历表：位置按弧长线性插值，朝向恒为边方向角 */
function createLineTable(edge: MapEdge): EdgeTraverseTable {
  const length = edge.length
  const theta = Math.atan2(edge.ey - edge.sy, edge.ex - edge.sx)
  return {
    edgeId: edge.id,
    totalLength: length,
    sample(distanceM: number) {
      const d = Number.isFinite(distanceM) ? Math.min(Math.max(distanceM, 0), length) : 0
      const ratio = length > 0 ? d / length : 0
      return {
        x: edge.sx + (edge.ex - edge.sx) * ratio,
        y: edge.sy + (edge.ey - edge.sy) * ratio,
        theta,
      }
    },
  }
}

/** BEZIER 遍历表：24 段累计弧长 + 段内线性插值 + 解析切线朝向 */
function createBezierTable(edge: MapEdge): EdgeTraverseTable {
  const points = sampleCubicBezier(
    edge.sx, edge.sy,
    // 控制点已由 validateMap 保证为非空有限数值
    edge.cx as number, edge.cy as number,
    edge.dx as number, edge.dy as number,
    edge.ex, edge.ey,
    BEZIER_SAMPLE_SEGMENTS,
  )
  // 累计弧长表：cum[i] 为第 i 个采样点距起点的弧长
  const cumulative = new Array<number>(points.length)
  cumulative[0] = 0
  for (let i = 1; i < points.length; i += 1) {
    cumulative[i] = cumulative[i - 1] + Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y,
    )
  }
  const total = cumulative[cumulative.length - 1]
  const segments = points.length - 1
  return {
    edgeId: edge.id,
    totalLength: total,
    sample(distanceM: number) {
      const d = Number.isFinite(distanceM) ? Math.min(Math.max(distanceM, 0), total) : 0
      // 二分定位包含 d 的折线段
      let low = 0
      let high = segments
      while (high - low > 1) {
        const mid = (low + high) >> 1
        if (cumulative[mid] <= d) {
          low = mid
        } else {
          high = mid
        }
      }
      const segStart = cumulative[low]
      const segEnd = cumulative[low + 1]
      const fraction = segEnd > segStart ? (d - segStart) / (segEnd - segStart) : 0
      const a = points[low]
      const b = points[low + 1]
      const x = a.x + (b.x - a.x) * fraction
      const y = a.y + (b.y - a.y) * fraction
      // 段内参数 t 与位置插值同源：theta 优先取该 t 的解析切线（SPEC §9.2
      // 「theta 使用曲线切线方向」），切线退化时按段弦向 → 整曲线弦向回退
      const t = (low + fraction) / segments
      const tangent = bezierTangentTheta(
        edge.sx, edge.sy,
        edge.cx as number, edge.cy as number,
        edge.dx as number, edge.dy as number,
        edge.ex, edge.ey,
        t,
      )
      const theta = tangent ?? safeAtan2(
        b.y - a.y,
        b.x - a.x,
        safeAtan2(edge.ey - edge.sy, edge.ex - edge.sx, 0),
      )
      return { x, y, theta }
    },
  }
}

/**
 * 建立单条逻辑边的遍历表。零长边（当前地图不存在，纵深防御）返回恒在
 * 起点、朝向 0 的退化表，保证内核推进循环永不在几何上死循环。
 */
export function createEdgeTraverseTable(edge: MapEdge): EdgeTraverseTable {
  if (edge.edgeType === 'BEZIER') {
    return createBezierTable(edge)
  }
  if (edge.length > 0) {
    return createLineTable(edge)
  }
  return {
    edgeId: edge.id,
    totalLength: 0,
    sample() {
      return { x: edge.sx, y: edge.sy, theta: 0 }
    },
  }
}
