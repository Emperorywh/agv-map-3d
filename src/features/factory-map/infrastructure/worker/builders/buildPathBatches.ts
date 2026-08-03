/**
 * 路径条带与方向箭头构建器（SPEC §7.1、§7.2、§8.2 路径锚点部分）。
 *
 * Worker 内纯函数：不依赖 DOM/Three，可在 vitest node 环境直接测试。
 * 单次遍历 edges：每条边采样为折线后直接写入正向/反向两批次的暂存数组，
 * 不为每条边创建临时几何对象（§7.1 禁止逐边 BufferGeometry / mergeGeometries）；
 * 遍历结束后一次性分配定长 TypedArray 作为 DTO 输出。
 *
 * 层依赖说明：§13.1 的度量常量（PATH_WIDTH / CURVE_MAX_ERROR / CURVE_MAX_SEGMENT /
 * MITER_LIMIT / CHEVRON_SPACING / CHEVRON_MIN_PATH_LEN）由组合根经 options 注入
 * （infrastructure 不反向依赖 config 层，§12）；§4.3 高度层 y 偏移与 §7.2
 * chevron 几何尺寸未列入 §13 配置表，作为构建期固定常量定义在本文件并烘焙进
 * 顶点/矩阵。z 取反唯一定义在 domain/coordinates.ts（mapToWorld）。
 */

import { mapToWorld } from '../../../domain/coordinates'
import { MapGeometryError } from '../../../domain/errors'
import type { FactoryMapBezierEdge, FactoryMapEdge } from '../../../domain/factoryMap'
import type { GeometryBatchDto, InstanceBatchDto } from '../../../application/factorySceneModel'

// ---------------------------------------------------------------------------
// §4.3 高度层 y 偏移（构建期烘焙；polygonOffset 第二道保险由渲染层材质负责）
// ---------------------------------------------------------------------------

/** 正向路径带 y 偏移（§4.3） */
export const PATH_FORWARD_Y = 0.004
/** 正向路径箭头 y 偏移（§4.3） */
export const ARROW_FORWARD_Y = 0.006
/** 反向路径带 y 偏移（§4.3） */
export const PATH_BACKWARD_Y = 0.008
/** 反向路径箭头 y 偏移（§4.3） */
export const ARROW_BACKWARD_Y = 0.010

// ---------------------------------------------------------------------------
// §7.1 / §7.2 / §8.2 构建期固定常量（未列入 §13 配置表，唯一定义于此）
// ---------------------------------------------------------------------------

/** 贝塞尔自适应细分最大递归深度；达到深度仍不满足条件返回 MapGeometryError（§7.1） */
export const CURVE_MAX_DEPTH = 16

/** 相邻采样点距离小于该值时去重（§7.1） */
export const SAMPLE_DEDUP_EPSILON = 1e-6

/** 路径标签锚点弧长比例 s = 0.4L（§8.2） */
export const PATH_LABEL_ARC_FRACTION = 0.4

/** chevron 箭头几何（§7.2）：顶点 (+0.18, 0)，两翼端点 (-0.10, ±0.14)，条宽 0.06m */
export const CHEVRON_TIP_X = 0.18
export const CHEVRON_WING_X = -0.1
export const CHEVRON_WING_SPREAD = 0.14
export const CHEVRON_STRIP_WIDTH = 0.06

/** miter 向量长度平方下限：低于该值视为 180° 折返，直接 bevel（防止无限尖角/NaN） */
const MITER_MIN_LEN2 = 1e-12

/** 细分暂存容量：深度 ≤ 16 → 叶子段 ≤ 2^16 → 采样点 ≤ 2^16 + 1，每点 x/y 两个分量 */
const SCRATCH_POINT_CAPACITY = 2 ** CURVE_MAX_DEPTH + 1

// ---------------------------------------------------------------------------
// 注入选项（§13.1，由组合根从 config/sceneMetrics.ts 传入）
// ---------------------------------------------------------------------------

export interface PathBuildOptions {
  /** 路径漆带宽度 PATH_WIDTH（§7.1：0.12m，两侧各扩一半） */
  readonly pathWidth: number
  /** 贝塞尔细分：控制多边形到弦的最大距离 CURVE_MAX_ERROR（0.01m） */
  readonly curveMaxError: number
  /** 贝塞尔细分：单段控制多边形最大长度 CURVE_MAX_SEGMENT（0.25m） */
  readonly curveMaxSegment: number
  /** 折线 miter join 限制 MITER_LIMIT（2）；超过生成 bevel */
  readonly miterLimit: number
  /** 方向箭头沿弧长的间隔 CHEVRON_SPACING（6m） */
  readonly chevronSpacing: number
  /** 路径弧长短于该值不放箭头 CHEVRON_MIN_PATH_LEN（1.0m） */
  readonly chevronMinPathLength: number
}

// ---------------------------------------------------------------------------
// 输出契约
// ---------------------------------------------------------------------------

/** 路径标签锚点基座（§8.2）：弧长 s=0.4L 处的数据坐标点与单位左法线 */
export interface EdgeLabelAnchor {
  readonly edgeId: string
  readonly edgeName: string
  /** s=0.4L 处位置（数据坐标） */
  readonly x: number
  readonly y: number
  /** 单位左法线（数据坐标，左 = 沿切线方向逆时针 90°） */
  readonly leftNormalX: number
  readonly leftNormalY: number
}

export interface PathBatchesResult {
  /** 正向路径条带合并几何（y=+0.004 已烘焙） */
  readonly forward: GeometryBatchDto
  /** 反向路径条带合并几何（y=+0.008 已烘焙） */
  readonly backward: GeometryBatchDto
  /** 正向箭头实例矩阵（y=+0.006 已烘焙） */
  readonly forwardArrows: InstanceBatchDto
  /** 反向箭头实例矩阵（y=+0.010 已烘焙） */
  readonly backwardArrows: InstanceBatchDto
  /** 每条边的标签锚点基座（顺序与输入 edges 一致） */
  readonly labelAnchors: readonly EdgeLabelAnchor[]
}

// ---------------------------------------------------------------------------
// 几何暂存与三角形发射（自动保证 +Y 法线朝向）
// ---------------------------------------------------------------------------

interface GeometryStaging {
  readonly positions: number[]
  readonly normals: number[]
  readonly indices: number[]
  vertexCount: number
}

function createGeometryStaging(): GeometryStaging {
  return { positions: [], normals: [], indices: [], vertexCount: 0 }
}

/**
 * 发射一个三角形顶点（数据坐标点 → 世界坐标，y 取层偏移）。
 * 返回顶点下标。z 取反由 mapToWorld 完成。
 */
function pushVertex(
  staging: GeometryStaging,
  dataX: number,
  dataY: number,
  layerY: number,
): number {
  const world = mapToWorld(dataX, dataY)
  staging.positions.push(world.x, layerY, world.z)
  staging.normals.push(0, 1, 0)
  const index = staging.vertexCount
  staging.vertexCount += 1
  return index
}

/**
 * 发射一个索引三角形，按世界坐标叉积 y 分量自动排布绕序，保证法线为 +Y。
 * 退化（面积≈0）三角形保持原顺序，对渲染无害。
 */
function pushTriangleIndices(
  staging: GeometryStaging,
  ia: number,
  ib: number,
  ic: number,
): void {
  const p = staging.positions
  const ax = p[ia * 3]
  const az = p[ia * 3 + 2]
  const bx = p[ib * 3]
  const bz = p[ib * 3 + 2]
  const cx = p[ic * 3]
  const cz = p[ic * 3 + 2]
  const crossY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
  if (crossY < 0) {
    staging.indices.push(ia, ic, ib)
  } else {
    staging.indices.push(ia, ib, ic)
  }
}

// ---------------------------------------------------------------------------
// 贝塞尔自适应细分（§7.1：De Casteljau；弦误差与段长双条件，深度 16 上限）
// ---------------------------------------------------------------------------

/**
 * 递归细分三次贝塞尔。满足双条件时把段终点写入 scratch 并返回；
 * 达到 CURVE_MAX_DEPTH 仍不满足时抛 MapGeometryError，不得改用粗糙采样。
 */
function subdivideBezier(
  edge: FactoryMapBezierEdge,
  options: PathBuildOptions,
  scratch: Float64Array,
  cursor: { value: number },
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
  dx: number, dy: number,
  depth: number,
): void {
  const chordX = dx - ax
  const chordY = dy - ay
  const chordLength = Math.hypot(chordX, chordY)
  const polygonLength =
    Math.hypot(bx - ax, by - ay) + Math.hypot(cx - bx, cy - by) + Math.hypot(dx - cx, dy - cy)

  // 控制多边形到弦的最大距离 = 两个内部控制点到弦所在直线的最大距离
  // （弦退化（a≈d）时退化为到起点 a 的距离）
  let maxControlDistance: number
  if (chordLength < 1e-12) {
    maxControlDistance = Math.max(Math.hypot(bx - ax, by - ay), Math.hypot(cx - ax, cy - ay))
  } else {
    const distB = Math.abs(chordX * (by - ay) - chordY * (bx - ax)) / chordLength
    const distC = Math.abs(chordX * (cy - ay) - chordY * (cx - ax)) / chordLength
    maxControlDistance = Math.max(distB, distC)
  }

  if (maxControlDistance <= options.curveMaxError && polygonLength <= options.curveMaxSegment) {
    scratch[cursor.value * 2] = dx
    scratch[cursor.value * 2 + 1] = dy
    cursor.value += 1
    return
  }
  if (depth >= CURVE_MAX_DEPTH) {
    throw new MapGeometryError(
      'MAP_GEOMETRY_CURVE_TOO_COMPLEX',
      `路径 ${JSON.stringify(edge.id)} 贝塞尔细分达到最大递归深度 ${CURVE_MAX_DEPTH} 仍不满足`
      + `弦误差 ≤ ${options.curveMaxError}m 且段长 ≤ ${options.curveMaxSegment}m（当前弦误差 `
      + `${maxControlDistance}m、控制多边形长 ${polygonLength}m），拒绝改用粗糙采样`,
      { fieldPath: `edges[].id=${edge.id}` },
    )
  }

  // t = 0.5 处 de Casteljau 分裂
  const abx = (ax + bx) / 2
  const aby = (ay + by) / 2
  const bcx = (bx + cx) / 2
  const bcy = (by + cy) / 2
  const cdx = (cx + dx) / 2
  const cdy = (cy + dy) / 2
  const abbcx = (abx + bcx) / 2
  const abbcy = (aby + bcy) / 2
  const bccdx = (bcx + cdx) / 2
  const bccdy = (bcy + cdy) / 2
  const midx = (abbcx + bccdx) / 2
  const midy = (abbcy + bccdy) / 2
  subdivideBezier(edge, options, scratch, cursor, ax, ay, abx, aby, abbcx, abbcy, midx, midy, depth + 1)
  subdivideBezier(edge, options, scratch, cursor, midx, midy, bccdx, bccdy, cdx, cdy, dx, dy, depth + 1)
}

/**
 * 把一条边采样为折线（数据坐标），写入 scratch（x/y 交错），返回去重后的点数。
 * - LINE：起点 + 终点两个采样点
 * - BEZIER：De Casteljau 自适应细分，双条件同时满足（§7.1）
 * - 相邻采样点距离 < SAMPLE_DEDUP_EPSILON 去重；去重后少于 2 点抛 MapGeometryError
 *
 * scratch 容量必须 ≥ 2 × (2^CURVE_MAX_DEPTH + 1)。
 */
export function sampleEdgePolyline(
  edge: FactoryMapEdge,
  options: PathBuildOptions,
  scratch: Float64Array,
): number {
  const cursor = { value: 0 }
  scratch[0] = edge.sx
  scratch[1] = edge.sy
  cursor.value = 1
  if (edge.edgeType === 'LINE') {
    scratch[2] = edge.ex
    scratch[3] = edge.ey
    cursor.value = 2
  } else {
    subdivideBezier(
      edge, options, scratch, cursor,
      edge.sx, edge.sy, edge.cx, edge.cy, edge.dx, edge.dy, edge.ex, edge.ey,
      0,
    )
  }

  // 相邻采样点距离 < 1e-6 去重（原地压缩，保持顺序）
  let write = 1
  for (let read = 1; read < cursor.value; read += 1) {
    const dx = scratch[read * 2] - scratch[(write - 1) * 2]
    const dy = scratch[read * 2 + 1] - scratch[(write - 1) * 2 + 1]
    if (dx * dx + dy * dy < SAMPLE_DEDUP_EPSILON * SAMPLE_DEDUP_EPSILON) continue
    scratch[write * 2] = scratch[read * 2]
    scratch[write * 2 + 1] = scratch[read * 2 + 1]
    write += 1
  }
  if (write < 2) {
    throw new MapGeometryError(
      'MAP_GEOMETRY_POLYLINE_DEGENERATE',
      `路径 ${JSON.stringify(edge.id)} 采样去重后不足 2 个点，无法构建条带`,
      { fieldPath: `edges[].id=${edge.id}` },
    )
  }
  return write
}

// ---------------------------------------------------------------------------
// 折线连接（§7.1：miter join，MITER_LIMIT=2 超限生成 bevel）
// ---------------------------------------------------------------------------

export type StripJoinKind = 'collinear' | 'miter' | 'bevel'

export interface StripJoinClassification {
  readonly kind: StripJoinKind
  /** 外侧重符号：+1 = 左法线侧为外侧，-1 = 右法线侧为外侧；collinear 时为 0 */
  readonly outerSign: number
  /** miter 单位方向与长度比（kind 为 miter 时有效，否则为 0） */
  readonly miterDirX: number
  readonly miterDirY: number
  readonly miterRatio: number
}

const COLLINEAR_JOIN: StripJoinClassification = {
  kind: 'collinear', outerSign: 0, miterDirX: 0, miterDirY: 0, miterRatio: 0,
}

/**
 * 连接类型判定（单位方向向量 d1 → d2，数据坐标）。
 * - 共线（含 180° 精确折返：两侧四边形端边重合，无缺口）不生成连接几何
 * - miter 长度比 = 1 / cos(转角/2)；超过 miterLimit 生成 bevel
 * - miter 向量退化（接近 180° 折返）直接 bevel，保证无无限尖角
 */
export function classifyStripJoin(
  d1x: number, d1y: number,
  d2x: number, d2y: number,
  miterLimit: number,
): StripJoinClassification {
  const cross = d1x * d2y - d1y * d2x
  if (cross === 0) return COLLINEAR_JOIN
  const n1x = -d1y
  const n1y = d1x
  const n2x = -d2y
  const n2y = d2x
  const mx = n1x + n2x
  const my = n1y + n2y
  const len2 = mx * mx + my * my
  const outerSign = cross > 0 ? -1 : 1
  if (len2 < MITER_MIN_LEN2) {
    return { kind: 'bevel', outerSign, miterDirX: 0, miterDirY: 0, miterRatio: 0 }
  }
  const len = Math.sqrt(len2)
  // miter 长度比 = |m| / (m·n1) = 1 / cos(θ/2)
  const ratio = len / (mx * n1x + my * n1y)
  if (ratio > miterLimit) {
    return { kind: 'bevel', outerSign, miterDirX: 0, miterDirY: 0, miterRatio: 0 }
  }
  return { kind: 'miter', outerSign, miterDirX: mx / len, miterDirY: my / len, miterRatio: ratio }
}

// ---------------------------------------------------------------------------
// 条带写入
// ---------------------------------------------------------------------------

/**
 * 把折线写入目标批次：每段一个 quad（butt cap），每个非共线内部点一个
 * miter/bevel 连接，保证连接处无裂缝（外侧重叠覆盖）、无无限尖角。
 */
function appendStrip(
  staging: GeometryStaging,
  scratch: Float64Array,
  pointCount: number,
  halfWidth: number,
  miterLimit: number,
  layerY: number,
): void {
  const px = (i: number): number => scratch[i * 2]
  const py = (i: number): number => scratch[i * 2 + 1]

  // 去重保证相邻采样点 ≥ 1e-6m，段长与方向恒为有限非零值
  for (let i = 0; i < pointCount - 1; i += 1) {
    const dx = px(i + 1) - px(i)
    const dy = py(i + 1) - py(i)
    const len = Math.hypot(dx, dy)
    const ux = dx / len
    const uy = dy / len
    const nx = -uy * halfWidth
    const ny = ux * halfWidth
    const ax = px(i)
    const ay = py(i)
    const bx = px(i + 1)
    const by = py(i + 1)
    // 段 quad：aL aR bL bR（butt cap：端边垂直于段方向，不做任何外延）
    const aL = pushVertex(staging, ax + nx, ay + ny, layerY)
    const aR = pushVertex(staging, ax - nx, ay - ny, layerY)
    const bL = pushVertex(staging, bx + nx, by + ny, layerY)
    const bR = pushVertex(staging, bx - nx, by - ny, layerY)
    pushTriangleIndices(staging, aL, bL, aR)
    pushTriangleIndices(staging, aR, bL, bR)

    if (i + 2 > pointCount - 1) continue
    // 内部点连接（b 即下一段起点）
    const dx2 = px(i + 2) - bx
    const dy2 = py(i + 2) - by
    const len2 = Math.hypot(dx2, dy2)
    const join = classifyStripJoin(ux, uy, dx2 / len2, dy2 / len2, miterLimit)
    if (join.kind === 'collinear') continue
    const s = join.outerSign
    const oPrevX = bx + s * nx
    const oPrevY = by + s * ny
    const oNextX = bx + s * (-(dy2 / len2) * halfWidth)
    const oNextY = by + s * ((dx2 / len2) * halfWidth)
    const apex = pushVertex(staging, bx, by, layerY)
    const oPrev = pushVertex(staging, oPrevX, oPrevY, layerY)
    const oNext = pushVertex(staging, oNextX, oNextY, layerY)
    if (join.kind === 'miter') {
      const miter = pushVertex(
        staging,
        bx + s * join.miterDirX * join.miterRatio * halfWidth,
        by + s * join.miterDirY * join.miterRatio * halfWidth,
        layerY,
      )
      pushTriangleIndices(staging, apex, oPrev, miter)
      pushTriangleIndices(staging, apex, miter, oNext)
    } else {
      pushTriangleIndices(staging, apex, oPrev, oNext)
    }
  }
}

// ---------------------------------------------------------------------------
// 弧长定位（箭头实例与标签锚点共用）
// ---------------------------------------------------------------------------

/** 折线上的弧长定位结果（数据坐标） */
interface ArcLocation {
  readonly x: number
  readonly y: number
  /** 单位切线（数据坐标） */
  readonly tangentX: number
  readonly tangentY: number
}

/**
 * 沿折线定位弧长 s 处的点与切线。targets 必须递增（单次行走）。
 * s 恰好落在末点时取最后一段切线。
 */
function locateAtArcLengths(
  scratch: Float64Array,
  pointCount: number,
  cumulative: Float64Array,
  targets: readonly number[],
): ArcLocation[] {
  const results: ArcLocation[] = []
  let segment = 0
  for (const target of targets) {
    while (segment < pointCount - 2 && cumulative[segment + 1] < target) {
      segment += 1
    }
    const segStart = cumulative[segment]
    const segLength = cumulative[segment + 1] - segStart
    const t = (target - segStart) / segLength
    const ax = scratch[segment * 2]
    const ay = scratch[segment * 2 + 1]
    const dx = scratch[(segment + 1) * 2] - ax
    const dy = scratch[(segment + 1) * 2 + 1] - ay
    results.push({
      x: ax + dx * t,
      y: ay + dy * t,
      tangentX: dx / segLength,
      tangentY: dy / segLength,
    })
  }
  return results
}

// ---------------------------------------------------------------------------
// 实例矩阵（列主序 16 floats：rotation.y = yaw + 平移，与 three 实例矩阵布局一致）
// ---------------------------------------------------------------------------

/**
 * 写入一个实例矩阵：rotation.y = yaw（§4.2：+X 前向几何体直接取数据系 yaw），
 * 平移为世界坐标（y 取层偏移）。列主序 16 个数。
 */
function pushInstanceMatrix(
  staging: number[],
  yaw: number,
  worldX: number,
  layerY: number,
  worldZ: number,
): void {
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  // 列主序：makeRotationY → [c,0,-s,0, 0,1,0,0, s,0,c,0]，末列为平移
  staging.push(cos, 0, -sin, 0, 0, 1, 0, 0, sin, 0, cos, 0, worldX, layerY, worldZ, 1)
}

// ---------------------------------------------------------------------------
// chevron 箭头实例局部几何（§7.2：两片 quad，本地 XZ 平面、法线 +Y、+X 前向）
// ---------------------------------------------------------------------------

/**
 * 方向箭头 chevron 几何：顶点 (+0.18, 0)，两翼端点 (-0.10, ±0.14)，条宽 0.06m。
 * 两片 quad = 8 顶点 4 三角形；直接在本地 XZ 平面构建（法线 +Y、+X 前向），
 * 不使用 CircleGeometry 一类默认 XY 平面再叠加旋转的做法（§4.2）。
 * 翼形关于 +X 对称，条带 quad 以「顶点 → 翼端」为中线、两侧各扩条宽一半。
 */
export function createChevronGeometryXZ(): GeometryBatchDto {
  const staging = createGeometryStaging()
  const halfStrip = CHEVRON_STRIP_WIDTH / 2
  for (const side of [1, -1] as const) {
    // 叶片中线：顶点 → 翼端（数据坐标；关于 x 轴对称，z 取反后形状不变）
    const tipX = CHEVRON_TIP_X
    const tipY = 0
    const wingX = CHEVRON_WING_X
    const wingY = side * CHEVRON_WING_SPREAD
    const dx = wingX - tipX
    const dy = wingY - tipY
    const len = Math.hypot(dx, dy)
    const nx = (-dy / len) * halfStrip
    const ny = (dx / len) * halfStrip
    const v0 = pushVertex(staging, tipX + nx, tipY + ny, 0)
    const v1 = pushVertex(staging, tipX - nx, tipY - ny, 0)
    const v2 = pushVertex(staging, wingX + nx, wingY + ny, 0)
    const v3 = pushVertex(staging, wingX - nx, wingY - ny, 0)
    pushTriangleIndices(staging, v0, v2, v1)
    pushTriangleIndices(staging, v1, v2, v3)
  }
  return {
    positions: Float32Array.from(staging.positions),
    normals: Float32Array.from(staging.normals),
    indices: Uint32Array.from(staging.indices),
  }
}

// ---------------------------------------------------------------------------
// 主入口：单次遍历直写正/反向两批次
// ---------------------------------------------------------------------------

/**
 * buildPathBatches（§7.1、§7.2）：
 * - 每条边采样为折线（LINE 两点 / BEZIER 自适应细分），直写正/反向条带批次
 * - 箭头：L < chevronMinPathLength 不放；n = max(1, floor(L/间距))，
 *   严格 6m 间隔，整组沿弧长居中（首位置 (L-(n-1)×6)/2）；
 *   朝向 = 所在点切线 yaw = atan2(Δy, Δx)（数据系），isBackEdge 只决定批次/高度层
 * - 同步产出每条边的标签锚点基座（s=0.4L 点 + 左法线）
 */
export function buildPathBatches(
  edges: readonly FactoryMapEdge[],
  options: PathBuildOptions,
): PathBatchesResult {
  const forward = createGeometryStaging()
  const backward = createGeometryStaging()
  const forwardArrows: number[] = []
  const backwardArrows: number[] = []
  const labelAnchors: EdgeLabelAnchor[] = []

  const halfWidth = options.pathWidth / 2
  const scratch = new Float64Array(SCRATCH_POINT_CAPACITY * 2)
  const cumulative = new Float64Array(SCRATCH_POINT_CAPACITY)

  for (const edge of edges) {
    const pointCount = sampleEdgePolyline(edge, options, scratch)
    const staging = edge.isBackEdge ? backward : forward
    const stripY = edge.isBackEdge ? PATH_BACKWARD_Y : PATH_FORWARD_Y
    const arrowY = edge.isBackEdge ? ARROW_BACKWARD_Y : ARROW_FORWARD_Y
    const arrowStaging = edge.isBackEdge ? backwardArrows : forwardArrows

    appendStrip(staging, scratch, pointCount, halfWidth, options.miterLimit, stripY)

    // 累计弧长
    cumulative[0] = 0
    for (let i = 1; i < pointCount; i += 1) {
      cumulative[i] = cumulative[i - 1] + Math.hypot(
        scratch[i * 2] - scratch[(i - 1) * 2],
        scratch[i * 2 + 1] - scratch[(i - 1) * 2 + 1],
      )
    }
    const totalLength = cumulative[pointCount - 1]

    // 箭头实例（§7.2）：方向恒 (sx,sy)→(ex,ey)，isBackEdge 只决定批次与高度层
    if (totalLength >= options.chevronMinPathLength) {
      const count = Math.max(1, Math.floor(totalLength / options.chevronSpacing))
      const first = (totalLength - (count - 1) * options.chevronSpacing) / 2
      const targets: number[] = []
      for (let k = 0; k < count; k += 1) {
        targets.push(first + k * options.chevronSpacing)
      }
      for (const location of locateAtArcLengths(scratch, pointCount, cumulative, targets)) {
        const yaw = Math.atan2(location.tangentY, location.tangentX)
        const world = mapToWorld(location.x, location.y)
        pushInstanceMatrix(arrowStaging, yaw, world.x, arrowY, world.z)
      }
    }

    // 标签锚点基座（§8.2：s = 0.4L 处位置与左法线；偏移与高度由标签组装环节叠加）
    const [anchor] = locateAtArcLengths(scratch, pointCount, cumulative, [totalLength * PATH_LABEL_ARC_FRACTION])
    labelAnchors.push({
      edgeId: edge.id,
      edgeName: edge.name,
      x: anchor.x,
      y: anchor.y,
      leftNormalX: -anchor.tangentY,
      leftNormalY: anchor.tangentX,
    })
  }

  const toGeometryBatch = (staging: GeometryStaging): GeometryBatchDto => ({
    positions: Float32Array.from(staging.positions),
    normals: Float32Array.from(staging.normals),
    indices: Uint32Array.from(staging.indices),
  })

  return {
    forward: toGeometryBatch(forward),
    backward: toGeometryBatch(backward),
    forwardArrows: { matrices: Float32Array.from(forwardArrows) },
    backwardArrows: { matrices: Float32Array.from(backwardArrows) },
    labelAnchors,
  }
}
