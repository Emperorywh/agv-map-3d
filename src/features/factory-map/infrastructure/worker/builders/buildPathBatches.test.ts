import { describe, expect, it } from 'vitest'

import type { GeometryBatchDto } from '../../../application/factorySceneModel'
import { MapGeometryError } from '../../../domain/errors'
import type { FactoryMapBezierEdge, FactoryMapEdge, FactoryMapLineEdge } from '../../../domain/factoryMap'
import {
  ARROW_BACKWARD_Y,
  ARROW_FORWARD_Y,
  PATH_BACKWARD_Y,
  PATH_FORWARD_Y,
  buildPathBatches,
  classifyStripJoin,
  createChevronGeometryXZ,
  sampleEdgePolyline,
} from './buildPathBatches'
import type { PathBuildOptions } from './buildPathBatches'

// §13.1 固定值（config/sceneMetrics.ts），测试内联注入（builders 不依赖 config 层）
const OPTIONS: PathBuildOptions = {
  pathWidth: 0.12,
  curveMaxError: 0.01,
  curveMaxSegment: 0.25,
  miterLimit: 2,
  chevronSpacing: 6,
  chevronMinPathLength: 1.0,
}

const SCRATCH_CAPACITY = 2 ** 16 + 1

function scratch(): Float64Array {
  return new Float64Array(SCRATCH_CAPACITY * 2)
}

function makeLine(
  id: string,
  sx: number, sy: number,
  ex: number, ey: number,
  isBackEdge = false,
): FactoryMapLineEdge {
  return {
    id, name: id, edgeType: 'LINE',
    sx, sy, ex, ey,
    cx: null, cy: null, dx: null, dy: null,
    isBackEdge, snodeId: 'a', enodeId: 'b',
  }
}

function makeBezier(
  id: string,
  sx: number, sy: number,
  cx: number, cy: number,
  dx: number, dy: number,
  ex: number, ey: number,
  isBackEdge = false,
): FactoryMapBezierEdge {
  return {
    id, name: id, edgeType: 'BEZIER',
    sx, sy, ex, ey, cx, cy, dx, dy,
    isBackEdge, snodeId: 'a', enodeId: 'b',
  }
}

// ---------------------------------------------------------------------------
// 几何批次断言工具
// ---------------------------------------------------------------------------

interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

function verticesOf(batch: GeometryBatchDto): Vec3[] {
  const out: Vec3[] = []
  for (let i = 0; i < batch.positions.length; i += 3) {
    out.push({ x: batch.positions[i], y: batch.positions[i + 1], z: batch.positions[i + 2] })
  }
  return out
}

function expectAllFinite(batch: GeometryBatchDto): void {
  for (const v of batch.positions) expect(Number.isFinite(v)).toBe(true)
  for (const v of batch.normals) expect(Number.isFinite(v)).toBe(true)
}

/** 全部三角形法线为 +Y（世界坐标叉积 y 分量 > 0），法线属性恒为 (0,1,0) */
function expectUpwardFacing(batch: GeometryBatchDto): void {
  const { positions, normals, indices } = batch
  for (let i = 0; i < normals.length; i += 3) {
    expect(normals[i]).toBe(0)
    expect(normals[i + 1]).toBe(1)
    expect(normals[i + 2]).toBe(0)
  }
  for (let i = 0; i < indices.length; i += 3) {
    const [ia, ib, ic] = [indices[i] * 3, indices[i + 1] * 3, indices[i + 2] * 3]
    const crossY =
      (positions[ib + 2] - positions[ia + 2]) * (positions[ic] - positions[ia])
      - (positions[ib] - positions[ia]) * (positions[ic + 2] - positions[ia + 2])
    expect(crossY).toBeGreaterThan(0)
  }
}

/** 断言顶点集合中存在接近 (x, y, z) 的顶点（无裂缝见证） */
function expectVertexNear(verts: readonly Vec3[], x: number, y: number, z: number, tol = 2e-5): void {
  const found = verts.some(
    (v) => Math.abs(v.x - x) <= tol && Math.abs(v.y - y) <= tol && Math.abs(v.z - z) <= tol,
  )
  expect(found, `应存在顶点 (${x.toFixed(5)}, ${y.toFixed(5)}, ${z.toFixed(5)})`).toBe(true)
}

/** 采样折线（sampleEdgePolyline 输出 → 点数组） */
function sampledPoints(edge: FactoryMapEdge, options: PathBuildOptions = OPTIONS): Array<{ x: number; y: number }> {
  const buf = scratch()
  const count = sampleEdgePolyline(edge, options, buf)
  const points: Array<{ x: number; y: number }> = []
  for (let i = 0; i < count; i += 1) {
    points.push({ x: buf[i * 2], y: buf[i * 2 + 1] })
  }
  return points
}

/** 三次贝塞尔在参数 t 处的真实曲线点 */
function cubicAt(edge: FactoryMapBezierEdge, t: number): { x: number; y: number } {
  const u = 1 - t
  return {
    x: u * u * u * edge.sx + 3 * u * u * t * edge.cx + 3 * u * t * t * edge.dx + t * t * t * edge.ex,
    y: u * u * u * edge.sy + 3 * u * u * t * edge.cy + 3 * u * t * t * edge.dy + t * t * t * edge.ey,
  }
}

function pointToSegmentDistance(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
}

// ---------------------------------------------------------------------------

describe('sampleEdgePolyline（SPEC §7.1 采样与去重）', () => {
  it('LINE：恰好起终点两个采样点', () => {
    expect(sampledPoints(makeLine('e1', 1, 2, 5, 8))).toEqual([{ x: 1, y: 2 }, { x: 5, y: 8 }])
  })

  it('直 BEZIER（控制点共线等距）：全部采样在弦上，段长上限迫使细分', () => {
    // 控制多边形长 3m，每级减半；≤0.25m 需细分 4 级 → 16 叶段、17 点
    const points = sampledPoints(makeBezier('e1', 0, 0, 1, 0, 2, 0, 3, 0))
    expect(points).toHaveLength(17)
    for (const p of points) expect(p.y).toBe(0)
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i].x - points[i - 1].x).toBeLessThanOrEqual(0.25 + 1e-12)
    }
  })

  it('弯 BEZIER：相邻采样点弦长 ≤ 0.25m（段长条件的直接推论）', () => {
    const edge = makeBezier('e1', 0, 0, 0, 1, 1, 1, 1, 2)
    const points = sampledPoints(edge)
    expect(points.length).toBeGreaterThan(2)
    for (let i = 1; i < points.length; i += 1) {
      const d = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
      expect(d).toBeLessThanOrEqual(0.25 + 1e-12)
    }
  })

  it('弯 BEZIER：真实曲线到折线的最大偏差 ≤ 0.01m（弦误差条件端到端验证）', () => {
    const edge = makeBezier('e1', 0, 0, 0, 1, 1, 1, 1, 2)
    const points = sampledPoints(edge)
    for (let k = 0; k <= 2000; k += 1) {
      const truePoint = cubicAt(edge, k / 2000)
      let minDistance = Infinity
      for (let i = 1; i < points.length; i += 1) {
        minDistance = Math.min(
          minDistance,
          pointToSegmentDistance(
            truePoint.x, truePoint.y,
            points[i - 1].x, points[i - 1].y,
            points[i].x, points[i].y,
          ),
        )
      }
      expect(minDistance).toBeLessThanOrEqual(0.01 + 1e-9)
    }
  })

  it('达到最大递归深度 16 仍不满足条件：抛 MapGeometryError，不得粗糙采样', () => {
    // 弦误差阈值 0 对真实曲线永不满足 → 必然触底
    const edge = makeBezier('sharp', 0, 0, 0, 1, 1, 1, 1, 2)
    const strict: PathBuildOptions = { ...OPTIONS, curveMaxError: 0 }
    let caught: unknown
    try {
      sampleEdgePolyline(edge, strict, scratch())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(MapGeometryError)
    expect((caught as MapGeometryError).code).toBe('MAP_GEOMETRY_CURVE_TOO_COMPLEX')
    expect((caught as MapGeometryError).message).toContain('sharp')
  })

  it('采样去重：停顿曲线（逼近重复采样）去重后无相邻点距离 < 1e-6', () => {
    // 极小段长阈值迫使深度细分，停顿区产生大量 < 1e-6 的相邻采样
    const edge = makeBezier('stall', 0, 0, 0, 0, 0, 0, 0.01, 0)
    const tight: PathBuildOptions = { ...OPTIONS, curveMaxError: 1, curveMaxSegment: 1e-6 }
    const points = sampledPoints(edge, tight)
    expect(points.length).toBeGreaterThanOrEqual(2)
    expect(points.length).toBeLessThan(2 ** 14) // 未去重时约 2^14 个点
    for (let i = 1; i < points.length; i += 1) {
      const d = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
      expect(d).toBeGreaterThanOrEqual(1e-6)
    }
  })

  it('去重后少于 2 个点：抛 MapGeometryError', () => {
    const edge = makeBezier('degenerate', 5, 5, 5, 5, 5, 5, 5, 5)
    let caught: unknown
    try {
      sampleEdgePolyline(edge, OPTIONS, scratch())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(MapGeometryError)
    expect((caught as MapGeometryError).code).toBe('MAP_GEOMETRY_POLYLINE_DEGENERATE')
    expect((caught as MapGeometryError).message).toContain('degenerate')
  })
})

describe('classifyStripJoin（SPEC §7.1 miter/bevel 判定）', () => {
  it('同向共线：不生成连接几何', () => {
    expect(classifyStripJoin(1, 0, 1, 0, 2).kind).toBe('collinear')
  })

  it('180° 精确折返：四边形端边重合无缺口，按共线处理', () => {
    expect(classifyStripJoin(1, 0, -1, 0, 2).kind).toBe('collinear')
  })

  it('90° 左转：miter（ratio √2 ≤ 2），外侧为右法线侧', () => {
    const join = classifyStripJoin(1, 0, 0, 1, 2)
    expect(join.kind).toBe('miter')
    expect(join.outerSign).toBe(-1)
    expect(join.miterRatio).toBeCloseTo(Math.SQRT2, 10)
    // miter 方向 = normalize(n1 + n2)，指向内侧（西北）
    expect(join.miterDirX).toBeCloseTo(-Math.SQRT1_2, 10)
    expect(join.miterDirY).toBeCloseTo(Math.SQRT1_2, 10)
  })

  it('90° 右转：miter，外侧为左法线侧', () => {
    const join = classifyStripJoin(1, 0, 0, -1, 2)
    expect(join.kind).toBe('miter')
    expect(join.outerSign).toBe(1)
  })

  it('120° 边界：ratio 恰好等于 MITER_LIMIT 仍为 miter（超限才 bevel）', () => {
    const join = classifyStripJoin(1, 0, Math.cos((Math.PI * 2) / 3), Math.sin((Math.PI * 2) / 3), 2)
    expect(join.kind).toBe('miter')
    expect(join.miterRatio).toBeLessThanOrEqual(2)
  })

  it('150° 急转：ratio > 2 超限 → bevel', () => {
    const join = classifyStripJoin(1, 0, Math.cos((Math.PI * 5) / 6), Math.sin((Math.PI * 5) / 6), 2)
    expect(join.kind).toBe('bevel')
  })

  it('接近 180° 折返（miter 向量退化）：直接 bevel，无无限尖角', () => {
    const join = classifyStripJoin(1, 0, -1, 1e-8, 2)
    expect(join.kind).toBe('bevel')
  })
})

describe('buildPathBatches LINE 条带（SPEC §7.1）', () => {
  it('正向 LINE：宽 0.12m、butt cap、y=+0.004、法线 +Y、全部有限', () => {
    const result = buildPathBatches([makeLine('e1', 0, 0, 4, 0)], OPTIONS)
    const batch = result.forward
    expect(result.backward.positions).toHaveLength(0)
    expect(batch.positions).toHaveLength(12) // 4 顶点
    expect(batch.indices).toHaveLength(6) // 2 三角形
    const verts = verticesOf(batch)
    // 条带两侧各扩 PATH_WIDTH/2 = 0.06m（数据 y ±0.06 → 世界 z ∓0.06）
    expectVertexNear(verts, 0, PATH_FORWARD_Y, -0.06)
    expectVertexNear(verts, 0, PATH_FORWARD_Y, 0.06)
    expectVertexNear(verts, 4, PATH_FORWARD_Y, -0.06)
    expectVertexNear(verts, 4, PATH_FORWARD_Y, 0.06)
    // butt cap：x 不超出 [0, 4]，无端帽外延（y 经 float32 存储，按精度断言）
    for (const v of verts) {
      expect(v.x).toBeGreaterThanOrEqual(0)
      expect(v.x).toBeLessThanOrEqual(4)
      expect(v.y).toBeCloseTo(PATH_FORWARD_Y, 6)
    }
    // 条带宽度跨 z 恰好 0.12m
    const zs = verts.map((v) => v.z)
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(0.12, 6)
    expectAllFinite(batch)
    expectUpwardFacing(batch)
  })

  it('反向 LINE：进入反向批次，y=+0.008，正向批次为空', () => {
    const result = buildPathBatches([makeLine('e1', 0, 0, 4, 3, true)], OPTIONS)
    expect(result.forward.positions).toHaveLength(0)
    expect(result.backward.positions).toHaveLength(12)
    for (const v of verticesOf(result.backward)) expect(v.y).toBeCloseTo(PATH_BACKWARD_Y, 6)
    expectUpwardFacing(result.backward)
  })

  it('正/反向混合：一次遍历分入两批', () => {
    const result = buildPathBatches(
      [makeLine('f', 0, 0, 1, 0), makeLine('b', 0, 0, 1, 0, true), makeLine('f2', 0, 0, 1, 0)],
      OPTIONS,
    )
    expect(result.forward.positions).toHaveLength(24) // 两条边 × 4 顶点
    expect(result.backward.positions).toHaveLength(12)
  })
})

describe('buildPathBatches BEZIER 连接（SPEC §7.1 miter/bevel）', () => {
  it('平缓 S 曲线：全部连接为 miter，顶点数精确匹配，连接处外侧顶点重合覆盖无裂缝', () => {
    const edge = makeBezier('s', 0, 0, 0, 1, 1, 1, 1, 2)
    const points = sampledPoints(edge)
    const result = buildPathBatches([edge], OPTIONS)
    const batch = result.forward
    const verts = verticesOf(batch)

    const segmentCount = points.length - 1
    let joinVertexCount = 0
    for (let i = 1; i < points.length - 1; i += 1) {
      const d1x = points[i].x - points[i - 1].x
      const d1y = points[i].y - points[i - 1].y
      const d2x = points[i + 1].x - points[i].x
      const d2y = points[i + 1].y - points[i].y
      const l1 = Math.hypot(d1x, d1y)
      const l2 = Math.hypot(d2x, d2y)
      const join = classifyStripJoin(d1x / l1, d1y / l1, d2x / l2, d2y / l2, 2)
      // 平缓曲线不允许出现 bevel；拐点处恰好共线时不生成连接几何（四边形端边重合无缺口）
      expect(join.kind).not.toBe('bevel')
      if (join.kind === 'collinear') continue
      joinVertexCount += 4
      // 无裂缝见证：外侧两片段端点与 miter 尖点都在顶点集合中
      const s = join.outerSign
      const oPrevX = points[i].x + s * (-d1y / l1) * 0.06
      const oPrevY = points[i].y + s * (d1x / l1) * 0.06
      const oNextX = points[i].x + s * (-d2y / l2) * 0.06
      const oNextY = points[i].y + s * (d2x / l2) * 0.06
      const miterX = points[i].x + s * join.miterDirX * join.miterRatio * 0.06
      const miterY = points[i].y + s * join.miterDirY * join.miterRatio * 0.06
      expectVertexNear(verts, oPrevX, PATH_FORWARD_Y, -oPrevY)
      expectVertexNear(verts, oNextX, PATH_FORWARD_Y, -oNextY)
      expectVertexNear(verts, miterX, PATH_FORWARD_Y, -miterY)
    }
    expect(batch.positions).toHaveLength((segmentCount * 4 + joinVertexCount) * 3)
    expectAllFinite(batch)
    expectUpwardFacing(batch)
  })

  it('尖折曲线：超限连接退化为 bevel，顶点数精确匹配，无无限尖角（全部有限）', () => {
    // 在 t=0.5 处速度为零的尖点曲线；强制单次分裂得到夹角约 139° 的两段折线
    const edge = makeBezier('cusp', 0, 0, 2, 0, 2, 2, 0, -2)
    const coarse: PathBuildOptions = { ...OPTIONS, curveMaxError: 100, curveMaxSegment: 4 }
    const points = sampledPoints(edge, coarse)
    expect(points).toHaveLength(3)
    const result = buildPathBatches([edge], coarse)
    const batch = result.forward
    // 2 段 quad（8 顶点）+ 1 个 bevel 连接（3 顶点）
    expect(batch.positions).toHaveLength(11 * 3)
    expect(batch.indices).toHaveLength(5 * 3)
    // bevel 见证：拐点与两个外侧端点都在顶点集合中（覆盖楔形缺口）
    const verts = verticesOf(batch)
    expectVertexNear(verts, 1.5, PATH_FORWARD_Y, -0.5)
    expectVertexNear(verts, 1.4810262, PATH_FORWARD_Y, -0.5569208)
    expectVertexNear(verts, 1.5514496, PATH_FORWARD_Y, -0.4691303)
    expectAllFinite(batch)
    expectUpwardFacing(batch)
  })

  it('共线连接不生成连接几何（顶点数 = 4 × 段数）', () => {
    // 共线等距控制点：采样折线全共线 → 无连接顶点
    const edge = makeBezier('straight', 0, 0, 1, 0, 2, 0, 3, 0)
    const points = sampledPoints(edge)
    const result = buildPathBatches([edge], OPTIONS)
    expect(result.forward.positions).toHaveLength((points.length - 1) * 4 * 3)
    expectUpwardFacing(result.forward)
  })
})

describe('buildPathBatches 方向箭头（SPEC §7.2）', () => {
  function arrowInstances(matrices: Float32Array): number[][] {
    const out: number[][] = []
    for (let i = 0; i < matrices.length; i += 16) {
      out.push(Array.from(matrices.slice(i, i + 16)))
    }
    return out
  }

  it('L < 1.0m：不放箭头', () => {
    const result = buildPathBatches([makeLine('short', 0, 0, 0.99, 0)], OPTIONS)
    expect(result.forwardArrows.matrices).toHaveLength(0)
  })

  it('L = 1.0m 边界：放 1 个箭头，位于弧长中点', () => {
    const result = buildPathBatches([makeLine('edge', 0, 0, 1, 0)], OPTIONS)
    const [m] = arrowInstances(result.forwardArrows.matrices)
    expect(m[12]).toBeCloseTo(0.5, 6)
    expect(m[13]).toBeCloseTo(ARROW_FORWARD_Y, 6)
    expect(m[14]).toBeCloseTo(0, 6)
  })

  it('L = 13m：n = floor(13/6) = 2，严格 6m 间隔、整组居中（首位置 3.5m）', () => {
    const result = buildPathBatches([makeLine('e', 0, 0, 13, 0)], OPTIONS)
    const instances = arrowInstances(result.forwardArrows.matrices)
    expect(instances).toHaveLength(2)
    expect(instances[0][12]).toBeCloseTo(3.5, 6)
    expect(instances[1][12]).toBeCloseTo(9.5, 6)
    expect(instances[1][12] - instances[0][12]).toBeCloseTo(6, 6)
  })

  it('L = 6m：n = 1，唯一箭头居中于 3m', () => {
    const result = buildPathBatches([makeLine('e', 0, 0, 6, 0)], OPTIONS)
    const instances = arrowInstances(result.forwardArrows.matrices)
    expect(instances).toHaveLength(1)
    expect(instances[0][12]).toBeCloseTo(3, 6)
  })

  it('yaw = atan2(Δy, Δx)（数据系）：北向路径 rotation.y = π/2，+X 前向映射为 (0,0,-1)', () => {
    const result = buildPathBatches([makeLine('e', 0, 0, 0, 7)], OPTIONS)
    const [m] = arrowInstances(result.forwardArrows.matrices)
    // 列主序 rotation.y：m[0]=cosθ, m[2]=-sinθ, m[8]=sinθ, m[10]=cosθ
    expect(m[0]).toBeCloseTo(0, 10)
    expect(m[2]).toBeCloseTo(-1, 10)
    expect(m[8]).toBeCloseTo(1, 10)
    expect(m[10]).toBeCloseTo(0, 10)
    // 平移：弧长 3.5m 处 = (0, 3.5) → 世界 (0, +0.006, -3.5)
    expect(m[12]).toBeCloseTo(0, 6)
    expect(m[13]).toBeCloseTo(ARROW_FORWARD_Y, 6)
    expect(m[14]).toBeCloseTo(-3.5, 6)
  })

  it('isBackEdge=true：进反向批次、y=+0.010，方向仍恒为 s→e', () => {
    const result = buildPathBatches([makeLine('e', 0, 0, 7, 0, true)], OPTIONS)
    expect(result.forwardArrows.matrices).toHaveLength(0)
    const [m] = arrowInstances(result.backwardArrows.matrices)
    expect(m[0]).toBeCloseTo(1, 10) // yaw = 0：朝 +x（s→e），不因反向翻转
    expect(m[12]).toBeCloseTo(3.5, 6)
    expect(m[13]).toBeCloseTo(ARROW_BACKWARD_Y, 6)
  })

  it('BEZIER 箭头：实例位于采样折线上、数量为 max(1, floor(L/6))', () => {
    const edge = makeBezier('e', 0, 0, 0, 2, 2, 2, 2, 4)
    const points = sampledPoints(edge)
    let length = 0
    for (let i = 1; i < points.length; i += 1) {
      length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    }
    const result = buildPathBatches([edge], OPTIONS)
    const instances = arrowInstances(result.forwardArrows.matrices)
    expect(instances).toHaveLength(Math.max(1, Math.floor(length / 6)))
    for (const m of instances) {
      // 世界 (x, z) → 数据 (x, -y) 应落在折线上
      let minDistance = Infinity
      for (let i = 1; i < points.length; i += 1) {
        minDistance = Math.min(
          minDistance,
          pointToSegmentDistance(m[12], -m[14], points[i - 1].x, points[i - 1].y, points[i].x, points[i].y),
        )
      }
      expect(minDistance).toBeLessThan(1e-5)
      for (const v of m) expect(Number.isFinite(v)).toBe(true)
    }
  })
})

describe('buildPathBatches 标签锚点基座（SPEC §8.2）', () => {
  it('东向 LINE：锚点位于 s=0.4L 处，左法线 (0, 1)', () => {
    const result = buildPathBatches([makeLine('e1', 0, 0, 10, 0)], OPTIONS)
    expect(result.labelAnchors).toHaveLength(1)
    const anchor = result.labelAnchors[0]
    expect(anchor.edgeId).toBe('e1')
    expect(anchor.x).toBeCloseTo(4, 10)
    expect(anchor.y).toBeCloseTo(0, 10)
    expect(anchor.leftNormalX).toBeCloseTo(0, 10)
    expect(anchor.leftNormalY).toBeCloseTo(1, 10)
  })

  it('北向 LINE：左法线 (-1, 0)（数据系逆时针 90°）', () => {
    const result = buildPathBatches([makeLine('e1', 0, 0, 0, 10)], OPTIONS)
    const anchor = result.labelAnchors[0]
    expect(anchor.x).toBeCloseTo(0, 10)
    expect(anchor.y).toBeCloseTo(4, 10)
    expect(anchor.leftNormalX).toBeCloseTo(-1, 10)
    expect(anchor.leftNormalY).toBeCloseTo(0, 10)
  })
})

describe('createChevronGeometryXZ（SPEC §7.2 实例局部几何）', () => {
  it('两片 quad：8 顶点 4 三角形，顶点 (+0.18,0)、翼端 (-0.10,±0.14)、条宽 0.06m', () => {
    const geometry = createChevronGeometryXZ()
    expect(geometry.positions).toHaveLength(8 * 3)
    expect(geometry.indices).toHaveLength(4 * 3)
    const verts = verticesOf(geometry)
    // 叶片顶点集合（数据坐标 (x, y) → 本地世界 (x, 0, -y)）
    const expected: Array<[number, number]> = [
      [0.1665836, 0.0268328], [0.1934164, -0.0268328], [-0.1134164, -0.1131672], [-0.0865836, -0.1668328],
      [0.1934164, 0.0268328], [0.1665836, -0.0268328], [-0.0865836, 0.1668328], [-0.1134164, 0.1131672],
    ]
    for (const [x, z] of expected) {
      expectVertexNear(verts, x, 0, z, 1e-6)
    }
    // +X 前向：最前点 x > 0.18（顶点附近），最后点 x < -0.08
    const xs = verts.map((v) => v.x)
    expect(Math.max(...xs)).toBeCloseTo(0.1934164, 5)
    expect(Math.min(...xs)).toBeCloseTo(-0.1134164, 5)
    expectAllFinite(geometry)
    expectUpwardFacing(geometry)
  })
})
