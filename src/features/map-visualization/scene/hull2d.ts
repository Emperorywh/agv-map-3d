/**
 * 二维凸包与多边形填充几何工具（视觉对齐 P0-5.5 自独占区实现中提取共享）。
 *
 * 职责：提供点集凸包（Andrew 单调链）、凸多边形沿边外扩与「凸包 + 外扩 +
 *       扇形三角化」的贴地填充几何累积——独占区面填充与仓储区域色块共用
 *       同一套数学，保证两种语义区域的地表覆盖语言一致。
 * 边界：纯几何累积函数，无材质/Mesh、无 React；调用方拥有输出数组与烘焙
 *       高度（y 由参数给出，顶点直接烘焙）。
 * 关键不变量：
 * 1. 凸包返回逆时针环；输入点数 < 3 或全部共线时由调用方降级（本模块提供
 *       退化包围矩形兜底）；
 * 2. 外扩沿「背离形心」的法线方向，绕序无关；近平行边退化为两偏移端点的
 *       中点（数值安全）。
 */

/** 计算点集的二维凸包（Andrew 单调链，返回逆时针环；共线时返回退化结果） */
export function convexHull2D(
  points: readonly { x: number; z: number }[],
): { x: number; z: number }[] {
  if (points.length < 3) {
    return [...points]
  }
  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.z - b.z : a.x - b.x))
  const cross = (
    o: { x: number; z: number },
    a: { x: number; z: number },
    b: { x: number; z: number },
  ): number => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x)
  const lower: { x: number; z: number }[] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop()
    }
    lower.push(p)
  }
  const upper: { x: number; z: number }[] = []
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop()
    }
    upper.push(p)
  }
  // 首末点重复，去掉后拼接（lower 与 upper 各含一次端点）
  lower.pop()
  upper.pop()
  return [...lower, ...upper]
}

/** 多边形有向面积（xz 平面）；退化/共线时接近 0 */
export function polygonArea(hull: readonly { x: number; z: number }[]): number {
  let area = 0
  for (let i = 0; i < hull.length; i += 1) {
    const p = hull[i]
    const q = hull[(i + 1) % hull.length]
    area += p.x * q.z - q.x * p.z
  }
  return Math.abs(area) / 2
}

/**
 * 凸包沿边外扩 padding：每条边沿「背离形心」的法线平移 padding，相邻偏移边
 * 求交得新顶点（凸多边形外扩的正确做法；近平行边退化为取两偏移边中点）。
 */
export function offsetConvexPolygon(
  hull: readonly { x: number; z: number }[],
  padding: number,
): { x: number; z: number }[] {
  const centroid = polygonCentroid(hull)

  // 每条边的单位法线取「背离形心」方向（绕序无关，鲁棒）
  const normals = hull.map((p, i) => {
    const q = hull[(i + 1) % hull.length]
    const mx = (p.x + q.x) / 2 - centroid.x
    const mz = (p.z + q.z) / 2 - centroid.z
    let nx = q.z - p.z
    let nz = -(q.x - p.x)
    const len = Math.hypot(nx, nz)
    if (len < 1e-9) {
      return { x: 0, z: 0 }
    }
    nx /= len
    nz /= len
    if (nx * mx + nz * mz < 0) {
      nx = -nx
      nz = -nz
    }
    return { x: nx, z: nz }
  })

  const vertices: { x: number; z: number }[] = []
  for (let i = 0; i < hull.length; i += 1) {
    // 顶点 i = 偏移边(i−1) 与 偏移边(i) 的交点；边方程 n·x = n·p + padding
    const prev = (i + hull.length - 1) % hull.length
    const a0 = normals[prev].x
    const b0 = normals[prev].z
    const a1 = normals[i].x
    const b1 = normals[i].z
    const c0 = a0 * hull[prev].x + b0 * hull[prev].z + padding
    const c1 = a1 * hull[i].x + b1 * hull[i].z + padding
    const det = a0 * b1 - b0 * a1
    if (Math.abs(det) < 1e-9) {
      // 近平行边：退化为两偏移端点的中点（数值安全）
      vertices.push({
        x: (hull[prev].x + a0 * padding + hull[i].x + a1 * padding) / 2,
        z: (hull[prev].z + b0 * padding + hull[i].z + b1 * padding) / 2,
      })
    } else {
      vertices.push({
        x: (c0 * b1 - b0 * c1) / det,
        z: (a0 * c1 - c0 * a1) / det,
      })
    }
  }
  return vertices
}

function polygonCentroid(hull: readonly { x: number; z: number }[]): {
  x: number
  z: number
} {
  let sx = 0
  let sz = 0
  for (const p of hull) {
    sx += p.x
    sz += p.z
  }
  return { x: sx / hull.length, z: sz / hull.length }
}

/** 共线点集的包围矩形（沿端点包络的长条，半宽 = padding）：面填充的降级形状 */
export function degenerateRectangle(
  points: readonly { x: number; z: number }[],
  padding: number,
): { x: number; z: number }[] {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.z)
    maxZ = Math.max(maxZ, p.z)
  }
  return [
    { x: minX - padding, z: minZ - padding },
    { x: maxX + padding, z: minZ - padding },
    { x: maxX + padding, z: maxZ + padding },
    { x: minX - padding, z: maxZ + padding },
  ]
}

/**
 * 「点集凸包 + 沿边外扩 + 扇形三角化」的贴地填充累积（P1-7 独占区面填充
 * 与 P0-5.5 仓储区域色块共用）。退化（共线/面积过小）时降级为端点包络的
 * 外扩包围矩形。顶点烘焙同一高度 y。
 */
export function appendConvexHullFill(
  positions: number[],
  indices: number[],
  points: readonly { x: number; z: number }[],
  padding: number,
  y: number,
): void {
  if (points.length === 0) {
    return
  }
  let hull = convexHull2D(points)
  if (hull.length < 3 || polygonArea(hull) < 1e-6) {
    hull = degenerateRectangle(hull.length > 0 ? hull : points, padding)
  }
  const expanded = offsetConvexPolygon(hull, padding)

  const base = positions.length / 3
  for (const v of expanded) {
    positions.push(v.x, y, v.z)
  }
  // 凸多边形扇形三角化
  for (let i = 1; i < expanded.length - 1; i += 1) {
    indices.push(base, base + i, base + i + 1)
  }
}
