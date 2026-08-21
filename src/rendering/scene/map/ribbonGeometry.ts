/**
 * 走廊 ribbon 与标识几何（SPEC §6.1 / §6.2）。
 *
 * - 全部走廊的实心 ribbon 与虚线标识合并为**单个** BufferGeometry（一次 draw call）：
 *   折线三角带、拐角 miter join 并限制 miter 长度防脱节；顶点色编码
 *   普通 / 单向 / 倒车底色；corridorIndex 顶点属性支持由 faceIndex 反查走廊（SPEC §8.2）；
 * - ribbon 贴地坪上方 lift（2cm），虚线与箭头再附加 overlayLift，
 *   材质由场景层启用 polygonOffset 防 z-fighting；
 * - 单向走廊方向箭头输出为 placements，由场景层以单个 InstancedMesh 渲染
 *   （不产生 per-走廊 draw call）。
 *
 * 几何计算在地图平面进行（2D 偏移 / miter），顶点经 coordinates.ts 统一转世界坐标
 * （z 取反唯一收口于 domain/coordinates.ts，SPEC §4.3）。
 * rendering 层可 import three 与 config，禁止 import infrastructure（SPEC §12）。
 */

import { BufferAttribute, BufferGeometry, Color, Float32BufferAttribute } from 'three'
import type { ColorRepresentation } from 'three'

import { headingToWorldYaw, mapToWorld } from '../../../domain/coordinates'
import { samplePolylineAt } from '../../../domain/polyline'
import type { Calibration, Corridor, MapPoint, Polyline } from '../../../domain/types'

/** 走廊反查属性名：每个顶点写入所属走廊索引（同一三角形的三个顶点同值） */
export const CORRIDOR_INDEX_ATTRIBUTE = 'corridorIndex'

/** 顶点色（SPEC §6.2：普通 / 倒车 / 单向底色），色值集中在 config/theme.ts 由场景层传入 */
export interface RibbonColors {
  /** 普通（双向）ribbon 底色 */
  normal: ColorRepresentation
  /** 单向 ribbon 底色 */
  oneWay: ColorRepresentation
  /** 倒车标识（双向 back 方向虚线边缘 / 单向 back 整条虚线） */
  back: ColorRepresentation
}

export interface RibbonGeometryParams {
  /** ribbon 宽度（米，config RIBBON_WIDTH） */
  width: number
  /** ribbon 抬升高度（config RIBBON_LIFT） */
  lift: number
  /** miter 长度上限，相对半宽的倍数（config RIBBON_MITER_LIMIT） */
  miterLimit: number
  /** 虚线实段长 / 间隔 / 线宽（config RIBBON_DASH_*） */
  dashLength: number
  dashGap: number
  dashWidth: number
  /** 虚线与箭头相对 ribbon 表面的附加抬升（config RIBBON_OVERLAY_LIFT） */
  overlayLift: number
  /** 单向箭头沿弧长的布置间距（config CORRIDOR_ARROW_SPACING） */
  arrowSpacing: number
  colors: RibbonColors
}

/** 单向箭头实例放置（世界坐标 + 朝向），由场景层写入 InstancedMesh 实例矩阵 */
export interface ArrowPlacement {
  x: number
  y: number
  z: number
  /** three rotation.y：箭头几何 +Z 前向，经 headingToWorldYaw 换算（SPEC §4.3） */
  yaw: number
  /** 所属走廊在 corridorIds 中的索引 */
  corridorIndex: number
  /** true = 单向 back 走廊（箭头用倒车标识色） */
  isBack: boolean
}

export interface RibbonBuildResult {
  /** 合并几何：全部实心 ribbon + 虚线标识（顶点色 + corridorIndex 属性） */
  geometry: BufferGeometry
  /** corridorIndex 属性值 → 走廊 id（拾取反查表） */
  corridorIds: string[]
  /** 单向走廊箭头实例放置 */
  arrowPlacements: ArrowPlacement[]
}

/**
 * 分帧构建器（SPEC §4.4：静态几何分帧构建，避免长任务）。
 * buildNext 按走廊增量推进（结果与一次性构建完全一致），done 后 finalize 组装 BufferGeometry。
 */
export interface RibbonGeometryBuilder {
  /** 走廊总数 */
  readonly total: number
  /** 已处理走廊数 */
  readonly processed: number
  readonly done: boolean
  /** 处理接下来 count 条走廊 */
  buildNext(count: number): void
  /** 全部处理完后调用：组装并返回合并几何（重复调用返回同一结果） */
  finalize(): RibbonBuildResult
}

/** 一次性构建（等价于创建 builder 后一次性推完全部走廊；测试与离线场景用） */
export function buildRibbonGeometry(
  corridors: Corridor[],
  calibration: Calibration,
  params: RibbonGeometryParams,
): RibbonBuildResult {
  const builder = createRibbonGeometryBuilder(corridors, calibration, params)
  while (!builder.done) {
    builder.buildNext(corridors.length)
  }
  return builder.finalize()
}

/** 由 raycast faceIndex 反查走廊 id（SPEC §8.2；几何为索引化三角带，faceIndex*3 取任一顶点） */
export function getCorridorIdAtFace(result: RibbonBuildResult, faceIndex: number): string | null {
  const index = result.geometry.index
  const attribute = result.geometry.getAttribute(CORRIDOR_INDEX_ATTRIBUTE)
  if (index === null || attribute === undefined) {
    return null
  }
  if (faceIndex < 0 || faceIndex * 3 >= index.count) {
    return null
  }
  const corridorIndex = attribute.getX(index.getX(faceIndex * 3))
  return result.corridorIds[corridorIndex] ?? null
}

/**
 * 单向箭头单位几何：平贴地面（y=0，实例平移抬升）、+Z 前向（SPEC §5.4 资产约定），
 * 燕尾形 4 顶点 2 三角形；实例朝向经 headingToWorldYaw 换算后直接可用。
 */
export function buildArrowGeometry(length: number, width: number): BufferGeometry {
  const halfLength = length / 2
  const halfWidth = width / 2
  const notchDepth = length * 0.28
  const vertices = new Float32Array([
    0, 0, halfLength, // 0 尖端
    halfWidth, 0, -halfLength, // 1 右翼
    0, 0, -halfLength + notchDepth, // 2 尾凹
    -halfWidth, 0, -halfLength, // 3 左翼
  ])
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(vertices, 3))
  geometry.setIndex([0, 1, 2, 0, 2, 3])
  return geometry
}

// ---------------------------------------------------------------------------
// 分帧构建器实现
// ---------------------------------------------------------------------------

/** 构建过程的增量累积状态（plain 数组，finalize 时一次性转 typed array） */
interface EmitContext {
  positions: number[]
  colors: number[]
  corridorIndices: number[]
  indices: number[]
  corridorIds: string[]
  arrowPlacements: ArrowPlacement[]
  calibration: Calibration
  params: RibbonGeometryParams
  colorNormal: Color
  colorOneWay: Color
  colorBack: Color
}

export function createRibbonGeometryBuilder(
  corridors: Corridor[],
  calibration: Calibration,
  params: RibbonGeometryParams,
): RibbonGeometryBuilder {
  const context: EmitContext = {
    positions: [],
    colors: [],
    corridorIndices: [],
    indices: [],
    corridorIds: [],
    arrowPlacements: [],
    calibration,
    params,
    colorNormal: new Color(params.colors.normal),
    colorOneWay: new Color(params.colors.oneWay),
    colorBack: new Color(params.colors.back),
  }
  let cursor = 0
  let finalized: RibbonBuildResult | null = null

  return {
    get total() {
      return corridors.length
    },
    get processed() {
      return cursor
    },
    get done() {
      return cursor >= corridors.length
    },
    buildNext(count: number) {
      if (finalized !== null) {
        return
      }
      const end = Math.min(corridors.length, cursor + Math.max(1, Math.floor(count)))
      for (; cursor < end; cursor++) {
        emitCorridor(context, corridors[cursor], cursor)
      }
    },
    finalize() {
      if (finalized === null) {
        const geometry = new BufferGeometry()
        geometry.setAttribute('position', new Float32BufferAttribute(context.positions, 3))
        geometry.setAttribute('color', new Float32BufferAttribute(context.colors, 3))
        geometry.setAttribute(
          CORRIDOR_INDEX_ATTRIBUTE,
          new Float32BufferAttribute(context.corridorIndices, 1),
        )
        geometry.setIndex(context.indices)
        finalized = {
          geometry,
          corridorIds: context.corridorIds,
          arrowPlacements: context.arrowPlacements,
        }
      }
      return finalized
    },
  }
}

// ---------------------------------------------------------------------------
// 单条走廊的发射：实心 ribbon + back 虚线标识 + 单向箭头 placements
// ---------------------------------------------------------------------------

function emitCorridor(context: EmitContext, corridor: Corridor, corridorIndex: number): void {
  const { params } = context
  const halfWidth = params.width / 2
  context.corridorIds.push(corridor.id)

  // ---- 实心 ribbon（SPEC §6.1：双向正常纯色；单向非 back 用单向底色；单向 back 无实心条） ----
  if (corridor.bidirectional) {
    emitStrip(context, corridor.geometry.points, halfWidth, params.lift, context.colorNormal, corridorIndex)
  } else if (!corridor.directions[0].isBack) {
    emitStrip(context, corridor.geometry.points, halfWidth, params.lift, context.colorOneWay, corridorIndex)
  }

  // ---- 倒车标识（SPEC §6.1 规则 4）----
  const overlayY = params.lift + params.overlayLift
  for (const direction of corridor.directions) {
    if (!direction.isBack) {
      continue
    }
    if (corridor.bidirectional) {
      // 双向走廊：在该方向行驶左侧画虚线边缘
      emitDashes(
        context,
        corridor.geometry,
        direction.alongGeometry,
        [halfWidth - params.dashWidth, halfWidth],
        overlayY,
        context.colorBack,
        corridorIndex,
      )
    } else {
      // 无配对单向 back 边：整条虚线 + 异色
      emitDashes(
        context,
        corridor.geometry,
        true,
        [-halfWidth, halfWidth],
        overlayY,
        context.colorBack,
        corridorIndex,
      )
    }
  }

  // ---- 单向走廊方向箭头（snode→enode，SPEC §6.1 规则 3）----
  if (!corridor.bidirectional) {
    emitArrowPlacements(context, corridor, corridorIndex)
  }
}

// ---------------------------------------------------------------------------
// 三角带（miter join，限制 miter 长度）
// ---------------------------------------------------------------------------

/** 中心线相邻点最小间距（米）：小于则合并，防零长度段导致法向退化 */
const MIN_POINT_SPACING = 1e-6
/** 向量退化判定阈值 */
const DEGENERATE_EPSILON = 1e-12

/**
 * 沿中心线发射对称宽度三角带：每点 2 个顶点（左 / 右），每段 2 个三角形。
 * 拐角 miter join；miter 长度超过 miterLimit × 半宽时截断防脱节；
 * 近 180° 折返时法向相互抵消，退化为单侧法向（有限值，不产生 NaN）。
 */
function emitStrip(
  context: EmitContext,
  centerline: MapPoint[],
  halfWidth: number,
  y: number,
  color: Color,
  corridorIndex: number,
): void {
  const points = filterCenterline(centerline)
  if (points.length < 2) {
    return
  }
  const { miterLimit } = context.params
  const base = context.positions.length / 3
  for (let i = 0; i < points.length; i++) {
    let offset: MapPoint
    if (i === 0) {
      offset = leftNormal(points[0], points[1], halfWidth)
    } else if (i === points.length - 1) {
      offset = leftNormal(points[points.length - 2], points[points.length - 1], halfWidth)
    } else {
      offset = miterOffset(points[i - 1], points[i], points[i + 1], halfWidth, miterLimit)
    }
    pushVertex(
      context,
      { x: points[i].x + offset.x, y: points[i].y + offset.y },
      y,
      color,
      corridorIndex,
    )
    pushVertex(
      context,
      { x: points[i].x - offset.x, y: points[i].y - offset.y },
      y,
      color,
      corridorIndex,
    )
  }
  for (let i = 0; i < points.length - 1; i++) {
    const a = base + 2 * i
    context.indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
}

/** 合并间距小于阈值的相邻点（保留首尾），返回新数组；点数 ≤2 时原样返回 */
function filterCenterline(points: MapPoint[]): MapPoint[] {
  if (points.length <= 2) {
    return points
  }
  const filtered: MapPoint[] = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const last = filtered[filtered.length - 1]
    const distance = Math.hypot(points[i].x - last.x, points[i].y - last.y)
    if (distance > MIN_POINT_SPACING || i === points.length - 1) {
      filtered.push(points[i])
    }
  }
  return filtered
}

/** 段左侧单位法向 × 长度（俯视地图、沿 a→b 行驶方向的左侧，SPEC §6.1） */
function leftNormal(a: MapPoint, b: MapPoint, length: number): MapPoint {
  const direction = unitDirection(a, b)
  return { x: -direction.y * length, y: direction.x * length }
}

/** 拐角 miter 偏移向量（含限长与折返退化处理） */
function miterOffset(
  prev: MapPoint,
  curr: MapPoint,
  next: MapPoint,
  halfWidth: number,
  miterLimit: number,
): MapPoint {
  const dIn = unitDirection(prev, curr)
  const dOut = unitDirection(curr, next)
  const nIn = { x: -dIn.y, y: dIn.x }
  const nOut = { x: -dOut.y, y: dOut.x }
  let mx = nIn.x + nOut.x
  let my = nIn.y + nOut.y
  const miterDirectionLength = Math.hypot(mx, my)
  if (miterDirectionLength < DEGENERATE_EPSILON) {
    // 近 180° 折返：左右法向相互抵消，退化为单侧法向
    mx = nIn.x
    my = nIn.y
  } else {
    mx /= miterDirectionLength
    my /= miterDirectionLength
  }
  // miter 长度 = halfWidth / cos(半角)，超过 miterLimit × halfWidth 时截断
  const cosHalf = mx * nIn.x + my * nIn.y
  const scale = cosHalf > 0 ? Math.min(1 / cosHalf, miterLimit) : miterLimit
  return { x: mx * halfWidth * scale, y: my * halfWidth * scale }
}

function unitDirection(a: MapPoint, b: MapPoint): MapPoint {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  if (length < DEGENERATE_EPSILON) {
    return { x: 1, y: 0 }
  }
  return { x: dx / length, y: dy / length }
}

// ---------------------------------------------------------------------------
// 虚线标识（back 方向边缘 / 单向 back 整条）
// ---------------------------------------------------------------------------

/**
 * 沿走廊几何按弧长发射虚线实段（每段一个四边形 = 2 三角形）。
 * @param band 偏移区间 [内, 外]，以**行驶方向**左侧为正；
 *   行驶方向与几何相反（alongGeometry=false）时自动翻转到几何右侧。
 * 短于一个实段的走廊整条画一段，保证标识不缺失。
 */
function emitDashes(
  context: EmitContext,
  geometry: Polyline,
  alongGeometry: boolean,
  band: [number, number],
  y: number,
  color: Color,
  corridorIndex: number,
): void {
  const { dashLength, dashGap } = context.params
  const inner = alongGeometry ? band[0] : -band[1]
  const outer = alongGeometry ? band[1] : -band[0]
  const total = geometry.length

  let emitted = false
  let s = 0
  while (s + dashLength <= total + DEGENERATE_EPSILON) {
    emitDashQuad(context, geometry, s, s + dashLength, inner, outer, y, color, corridorIndex)
    emitted = true
    s += dashLength + dashGap
  }
  if (!emitted && total > 0) {
    emitDashQuad(context, geometry, 0, total, inner, outer, y, color, corridorIndex)
  }
}

function emitDashQuad(
  context: EmitContext,
  geometry: Polyline,
  s0: number,
  s1: number,
  inner: number,
  outer: number,
  y: number,
  color: Color,
  corridorIndex: number,
): void {
  const start = samplePolylineAt(geometry, s0)
  const end = samplePolylineAt(geometry, s1)
  const startNormal = { x: -start.tangent.y, y: start.tangent.x }
  const endNormal = { x: -end.tangent.y, y: end.tangent.x }
  const base = context.positions.length / 3
  const corners: MapPoint[] = [
    { x: start.point.x + startNormal.x * inner, y: start.point.y + startNormal.y * inner },
    { x: start.point.x + startNormal.x * outer, y: start.point.y + startNormal.y * outer },
    { x: end.point.x + endNormal.x * outer, y: end.point.y + endNormal.y * outer },
    { x: end.point.x + endNormal.x * inner, y: end.point.y + endNormal.y * inner },
  ]
  for (const corner of corners) {
    pushVertex(context, corner, y, color, corridorIndex)
  }
  context.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
}

// ---------------------------------------------------------------------------
// 单向箭头 placements
// ---------------------------------------------------------------------------

/** 单向走廊沿弧长均匀布置方向箭头（snode→enode；至少 1 个），朝向为行驶方向 */
function emitArrowPlacements(context: EmitContext, corridor: Corridor, corridorIndex: number): void {
  const { params, calibration } = context
  const direction = corridor.directions[0]
  const { geometry } = corridor
  const count = Math.max(1, Math.floor(geometry.length / params.arrowSpacing))
  const y = params.lift + params.overlayLift
  for (let i = 0; i < count; i++) {
    const s = (geometry.length * (i + 0.5)) / count
    const sample = samplePolylineAt(geometry, s)
    const tangent = direction.alongGeometry
      ? sample.tangent
      : { x: -sample.tangent.x, y: -sample.tangent.y }
    const heading = Math.atan2(tangent.y, tangent.x)
    const world = mapToWorld(sample.point, calibration)
    context.arrowPlacements.push({
      x: world.x,
      y,
      z: world.z,
      yaw: headingToWorldYaw(heading, calibration),
      corridorIndex,
      isBack: direction.isBack,
    })
  }
}

// ---------------------------------------------------------------------------
// 顶点写入（地图平面点经 coordinates.ts 统一转世界坐标）
// ---------------------------------------------------------------------------

function pushVertex(
  context: EmitContext,
  mapPoint: MapPoint,
  y: number,
  color: Color,
  corridorIndex: number,
): void {
  const world = mapToWorld(mapPoint, context.calibration)
  context.positions.push(world.x, y, world.z)
  context.colors.push(color.r, color.g, color.b)
  context.corridorIndices.push(corridorIndex)
}
