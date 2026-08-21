/**
 * map.json → NormalizedMap 规范化（SPEC §4.2 / §4.4）。
 *
 * 纯函数、无 IO：Worker 与主线程回退共用同一套实现（SPEC §10）。
 * 顶层结构缺失（data.currentMapInfoVersion.mapJson.{nodes,edges} / data.floor）
 * 抛出 MapDataError（带原因，进全屏错误页）；个别坏数据跳过并 console 警告 + 计数，
 * 保证主场景尽量可打开（SPEC §10 分级降级原则）。
 */

import { DEFAULT_BEZIER_TOLERANCE, subdivideCubicBezier } from './bezier'
import { buildPolyline } from './polyline'
import type {
  Calibration,
  MapPoint,
  NodeKind,
  NormalizedEdge,
  NormalizedMap,
  NormalizedNode,
  Polyline,
  RawMapEdge,
  RawMapNode,
} from './types'

/** map.json 数据本身的问题（顶层结构缺失等）。Worker 与主线程行为一致，属于确定性错误 */
export class MapDataError extends Error {
  override readonly name = 'MapDataError'
}

export interface NormalizeOptions {
  /** BEZIER 细分弦高差容差（米），缺省 DEFAULT_BEZIER_TOLERANCE */
  bezierTolerance?: number
}

/** 规范化统计（SPEC §10：所有跳过都有计数，便于发现数据问题；面板见 TASK-014） */
export interface NormalizeStats {
  inputNodes: number
  inputEdges: number
  /** 规范化后保留的节点 / 边数 */
  nodes: number
  edges: number
  /** 缺坐标（或缺 id）被跳过的节点数；其关联边计入 skippedEdges */
  skippedNodes: number
  /** 被跳过的边数：引用不存在 / 被跳过的节点、s=e 自环、零长度退化 */
  skippedEdges: number
  /** 未知 type 降级为 node 的节点数 */
  unknownNodeKinds: number
  /** 被降级处理的边数：未知 edgeType / BEZIER 缺控制点降级为 LINE，facing 等字段缺失按缺省处理 */
  degradedEdges: number
}

export interface NormalizeResult {
  map: NormalizedMap
  stats: NormalizeStats
}

/** 源 type → kind 映射（SPEC §4.2）；elevator 为预留类型 */
const NODE_KIND_BY_TYPE: Readonly<Record<string, NodeKind>> = {
  node: 'node',
  work: 'work',
  charge: 'charge',
  park: 'park',
  elevator: 'elevator',
}

/** 零长度退化边判定阈值（米） */
const DEGENERATE_LENGTH_EPSILON = 1e-9

/**
 * JSON 文本 → NormalizedMap：JSON.parse + 规范化的组合纯函数，
 * 即 Worker 与主线程回退共用的"同一套"入口（SPEC §4.4）。
 * JSON 损坏时抛 MapDataError（带原因）。
 */
export function normalizeMapFromJson(jsonText: string, options?: NormalizeOptions): NormalizeResult {
  let raw: unknown
  try {
    raw = JSON.parse(jsonText)
  } catch (error) {
    throw new MapDataError(
      `map.json JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return normalizeMap(raw, options)
}

/**
 * 规范化入口。Worker 与主线程回退执行同一套纯函数（SPEC §4.4）。
 * @param raw JSON.parse 后的 map.json 顶层对象（不可信 IO，运行时校验）
 */
export function normalizeMap(raw: unknown, options?: NormalizeOptions): NormalizeResult {  const bezierTolerance = options?.bezierTolerance ?? DEFAULT_BEZIER_TOLERANCE
  const { rawNodes, rawEdges, floor } = extractStructure(raw)

  const stats: NormalizeStats = {
    inputNodes: rawNodes.length,
    inputEdges: rawEdges.length,
    nodes: 0,
    edges: 0,
    skippedNodes: 0,
    skippedEdges: 0,
    unknownNodeKinds: 0,
    degradedEdges: 0,
  }

  // ---- 节点：type→kind 映射，缺坐标跳过（SPEC §10）----
  const nodeById = new Map<string, NormalizedNode>()
  const nodes: NormalizedNode[] = []
  for (const rawNode of rawNodes) {
    const node = normalizeNode(rawNode, stats)
    if (node === null) {
      stats.skippedNodes++
      continue
    }
    nodeById.set(node.id, node)
    nodes.push(node)
  }

  // ---- 边：解析端点引用，LINE / BEZIER 统一为带弧长表的折线 ----
  // 包围盒须涵盖节点 + 边折线 + 贝塞尔控制点（SPEC §4.3 offset 口径）
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const node of nodes) {
    expandBounds(bounds, node)
  }

  const edges: NormalizedEdge[] = []
  for (const rawEdge of rawEdges) {
    const edge = normalizeEdge(rawEdge, nodeById, bezierTolerance, stats)
    if (edge === null) {
      stats.skippedEdges++
      continue
    }
    edges.push(edge)
    for (const point of edge.geometry.points) {
      expandBounds(bounds, point)
    }
    // 贝塞尔控制点可能超出细分折线（曲线含于控制多边形内），须纳入包围盒
    const controlPoints = bezierControlPoints(rawEdge)
    if (controlPoints !== null) {
      expandBounds(bounds, controlPoints[0])
      expandBounds(bounds, controlPoints[1])
    }
  }

  stats.nodes = nodes.length
  stats.edges = edges.length

  const calibration: Calibration = {
    scale: 1,
    rotationRad: 0,
    offsetX: bounds.minX === Infinity ? 0 : (bounds.minX + bounds.maxX) / 2,
    offsetY: bounds.minY === Infinity ? 0 : (bounds.minY + bounds.maxY) / 2,
  }

  if (stats.skippedNodes > 0 || stats.skippedEdges > 0 || stats.unknownNodeKinds > 0) {
    console.warn(
      `[normalize] 数据质量计数：跳过节点 ${stats.skippedNodes}/${stats.inputNodes}，` +
        `跳过边 ${stats.skippedEdges}/${stats.inputEdges}，` +
        `未知节点类型降级 ${stats.unknownNodeKinds}，降级边 ${stats.degradedEdges}`,
    )
  }

  return {
    // corridors 由 TASK-003 按无序节点对配对构建（SPEC §6.1），本阶段为空
    map: { calibration, floor, nodes, edges, corridors: [] },
    stats,
  }
}

// ---------------------------------------------------------------------------
// 结构提取与校验
// ---------------------------------------------------------------------------

interface RawStructure {
  rawNodes: RawMapNode[]
  rawEdges: RawMapEdge[]
  floor: number
}

/** 提取并校验顶层结构（SPEC §4.1）；缺失时抛 MapDataError（带原因） */
function extractStructure(raw: unknown): RawStructure {
  const root = asRecord(raw)
  const data = asRecord(root?.data)
  const version = asRecord(data?.currentMapInfoVersion)
  const mapJson = asRecord(version?.mapJson)
  if (mapJson === null || !Array.isArray(mapJson.nodes) || !Array.isArray(mapJson.edges)) {
    throw new MapDataError(
      'map.json 顶层结构缺失：需要 data.currentMapInfoVersion.mapJson 内含 nodes / edges 数组',
    )
  }
  const floor = asFiniteNumber(data?.floor)
  if (floor === null) {
    throw new MapDataError('map.json 顶层结构缺失：data.floor 不是数值')
  }
  return {
    rawNodes: mapJson.nodes as RawMapNode[],
    rawEdges: mapJson.edges as RawMapEdge[],
    floor,
  }
}

// ---------------------------------------------------------------------------
// 节点 / 边规范化
// ---------------------------------------------------------------------------

/** 规范化单个节点；坏数据返回 null（跳过）并 console 警告 */
function normalizeNode(rawNode: RawMapNode, stats: NormalizeStats): NormalizedNode | null {
  const raw = asRecord(rawNode) ?? {}
  const id = asNonEmptyString(raw.id)
  const x = asFiniteNumber(raw.x)
  const y = asFiniteNumber(raw.y)
  if (id === null || x === null || y === null) {
    console.warn(`[normalize] 跳过缺 id / 坐标的节点：id=${String(raw.id)}`)
    return null
  }
  const type = typeof raw.type === 'string' ? raw.type : ''
  let kind = NODE_KIND_BY_TYPE[type]
  if (kind === undefined) {
    console.warn(`[normalize] 节点 ${id} 未知类型 "${type}"，降级为 node`)
    kind = 'node'
    stats.unknownNodeKinds++
  }
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : id,
    kind,
    x,
    y,
    angle: asFiniteNumber(raw.angle),
  }
}

/**
 * 规范化单条边；坏数据返回 null（跳过）并 console 警告。
 * LINE → 两点折线；BEZIER → 自适应细分折线；未知类型 / 缺控制点降级为 LINE。
 */
function normalizeEdge(
  rawEdge: RawMapEdge,
  nodeById: ReadonlyMap<string, NormalizedNode>,
  bezierTolerance: number,
  stats: NormalizeStats,
): NormalizedEdge | null {
  const raw = asRecord(rawEdge) ?? {}
  const id = asNonEmptyString(raw.id)
  const from = asNonEmptyString(raw.snodeId)
  const to = asNonEmptyString(raw.enodeId)
  if (id === null || from === null || to === null) {
    console.warn(`[normalize] 跳过缺 id / 端点引用的边：id=${String(raw.id)}`)
    return null
  }
  if (from === to) {
    console.warn(`[normalize] 跳过 s=e 自环退化边：${id}`)
    return null
  }
  if (!nodeById.has(from) || !nodeById.has(to)) {
    console.warn(`[normalize] 跳过引用不存在 / 被跳过节点的边：${id}（${from} → ${to}）`)
    return null
  }
  const sx = asFiniteNumber(raw.sx)
  const sy = asFiniteNumber(raw.sy)
  const ex = asFiniteNumber(raw.ex)
  const ey = asFiniteNumber(raw.ey)
  if (sx === null || sy === null || ex === null || ey === null) {
    console.warn(`[normalize] 跳过端点坐标缺失的边：${id}`)
    return null
  }

  const start: MapPoint = { x: sx, y: sy }
  const end: MapPoint = { x: ex, y: ey }
  const edgeType = typeof raw.edgeType === 'string' ? raw.edgeType : ''
  const controls = bezierControlPoints(rawEdge)

  let points: MapPoint[]
  if (edgeType === 'BEZIER' && controls !== null) {
    points = subdivideCubicBezier(start, controls[0], controls[1], end, bezierTolerance)
  } else {
    if (edgeType !== 'LINE') {
      // 未知 edgeType，或 BEZIER 缺控制点：降级为 LINE（保持连通，SPEC §10 尽量可打开）
      console.warn(`[normalize] 边 ${id} 类型 "${edgeType}" 无法按曲线处理，降级为 LINE`)
      stats.degradedEdges++
    }
    points = [start, end]
  }
  const geometry: Polyline = buildPolyline(points)
  if (geometry.length <= DEGENERATE_LENGTH_EPSILON) {
    console.warn(`[normalize] 跳过零长度退化边：${id}`)
    return null
  }

  const sFacing = asFiniteNumber(raw.sfacing)
  const eFacing = asFiniteNumber(raw.efacing)
  const cost = asFiniteNumber(raw.cost)
  if (sFacing === null || eFacing === null || cost === null) {
    console.warn(`[normalize] 边 ${id} 的 sfacing / efacing / cost 缺失，按缺省值处理`)
    stats.degradedEdges++
  }

  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : id,
    from,
    to,
    geometry,
    sFacing: sFacing ?? 0,
    eFacing: eFacing ?? 0,
    isBackEdge: raw.isBackEdge === true,
    cost: cost ?? geometry.length,
    maxSpeedLoad: asFiniteNumber(raw.maxLoadSpeed),
    maxSpeedFree: asFiniteNumber(raw.maxFreeSpeed),
    maxRotationSpeedLoad: asFiniteNumber(raw.maxLoadRotationSpeed),
    maxRotationSpeedFree: asFiniteNumber(raw.maxFreeRotationSpeed),
    maxAccelerationLoad: asFiniteNumber(raw.maxLoadAcceleration),
    maxAccelerationFree: asFiniteNumber(raw.maxFreeAcceleration),
    maxDecelerationLoad: asFiniteNumber(raw.maxLoadDeceleration),
    maxDecelerationFree: asFiniteNumber(raw.maxFreeDeceleration),
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** BEZIER 边的两个控制点（c / d）；非 BEZIER 或控制点缺失返回 null */
function bezierControlPoints(raw: RawMapEdge): [MapPoint, MapPoint] | null {
  if (raw.edgeType !== 'BEZIER') {
    return null
  }
  const cx = asFiniteNumber(raw.cx)
  const cy = asFiniteNumber(raw.cy)
  const dx = asFiniteNumber(raw.dx)
  const dy = asFiniteNumber(raw.dy)
  if (cx === null || cy === null || dx === null || dy === null) {
    return null
  }
  return [
    { x: cx, y: cy },
    { x: dx, y: dy },
  ]
}

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function expandBounds(bounds: Bounds, point: MapPoint): void {
  if (point.x < bounds.minX) bounds.minX = point.x
  if (point.x > bounds.maxX) bounds.maxX = point.x
  if (point.y < bounds.minY) bounds.minY = point.y
  if (point.y > bounds.maxY) bounds.maxY = point.y
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
