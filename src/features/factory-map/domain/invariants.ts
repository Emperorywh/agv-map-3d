/**
 * 数据不变量（SPEC §3.3 规则表逐行实现）。
 *
 * 规则总览（每行至少一个失败用例，见 invariants.test.ts）：
 * - 集合字段：数组项必须是非 null object（集合本身必须是数组由 decodeMapEnvelope 检查）
 * - id / name：非空字符串；节点 id、边 id 各自唯一
 * - 数值字段：JSON number 且 Number.isFinite；坐标绝对值 ≤ 1000m
 * - 地图范围：bbox 宽度和深度均 ≤ 220m（MapCapacityError）
 * - node.type：只接受 node/work/park/charge
 * - angle：node 类型必须为 null；站点只接受 null 或有限弧度值，进入领域模型时规范化到 [-π, π)
 * - edgeType：只接受 LINE/BEZIER
 * - isBackEdge：必须是 boolean，不接受 0/1 或字符串转换
 * - 控制点：LINE 必须全部为 null；BEZIER 必须全部为有限数值，不做类型降级
 * - 节点引用：snodeId / enodeId 必须引用存在的节点
 * - 路径长度：按几何弧长计算，L < 0.01m 返回 MapValidationError，不静默跳过
 * - 容量：nodes.length + edges.length ≤ 20000（MapCapacityError）
 *
 * 不忽略坏记录继续，不把未知值转换成其他合法类型。
 */

import type { MapBounds } from './bounds'
import { normalizeMapAngle } from './coordinates'
import { MapCapacityError, MapValidationError } from './errors'
import type { FactoryMapEdge, FactoryMapNode, NodeType } from './factoryMap'
import { EDGE_TYPES, NODE_TYPES, isStationNodeType } from './factoryMap'
import {
  MAX_MAP_COORDINATE_ABS,
  MAX_MAP_ELEMENTS,
  MAX_MAP_EXTENT,
  MIN_PATH_ARC_LENGTH,
} from './limits'

// ---------------------------------------------------------------------------
// 原始值形状判断（供 decodeMapEnvelope 复用，避免形状逻辑散落两处）
// ---------------------------------------------------------------------------

/** 非 null、非数组的 plain object */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 原始值的中文形态描述，用于错误摘要 */
export function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return '数组'
  switch (typeof value) {
    case 'string':
      return `字符串 ${JSON.stringify(value)}`
    case 'object':
      return '对象'
    case 'undefined':
      return 'undefined（字段缺失）'
    default:
      return `${typeof value} ${String(value)}`
  }
}

// ---------------------------------------------------------------------------
// 字段级校验
// ---------------------------------------------------------------------------

function readId(raw: unknown, path: string, owner: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new MapValidationError(
      'MAP_ID_INVALID',
      `${owner} id 必须是非空字符串，实际为 ${describeValue(raw)}`,
      { fieldPath: path },
    )
  }
  return raw
}

function readName(raw: unknown, path: string, owner: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new MapValidationError(
      'MAP_NAME_INVALID',
      `${owner} name 必须是非空字符串，实际为 ${describeValue(raw)}`,
      { fieldPath: path },
    )
  }
  return raw
}

function readFiniteNumber(raw: unknown, path: string, label: string, code: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new MapValidationError(
      code,
      `${label} 必须是有限数值，实际为 ${describeValue(raw)}`,
      { fieldPath: path },
    )
  }
  return raw
}

/** 坐标：有限数值且绝对值 ≤ 1000m（§3.3 数值字段行） */
function readCoordinate(raw: unknown, path: string, label: string, code: string): number {
  const value = readFiniteNumber(raw, path, label, code)
  if (Math.abs(value) > MAX_MAP_COORDINATE_ABS) {
    throw new MapValidationError(
      'MAP_COORDINATE_OUT_OF_RANGE',
      `${label} 绝对值 ${Math.abs(value)} 超过上限 ${MAX_MAP_COORDINATE_ABS}m`,
      { fieldPath: path },
    )
  }
  return value
}

function readNodeType(raw: unknown, path: string): NodeType {
  if (typeof raw !== 'string' || !(NODE_TYPES as readonly string[]).includes(raw)) {
    throw new MapValidationError(
      'MAP_NODE_TYPE_INVALID',
      `节点类型必须是 ${NODE_TYPES.join('/')} 之一，实际为 ${describeValue(raw)}`,
      { fieldPath: path },
    )
  }
  return raw as NodeType
}

/**
 * angle 规则（§3.3）：node 类型必须为 null；
 * 站点只接受 null 或有限弧度值，有限值规范化到 [-π, π)。
 */
function readNodeAngle(raw: unknown, path: string, type: NodeType): number | null {
  if (!isStationNodeType(type)) {
    if (raw !== null) {
      throw new MapValidationError(
        'MAP_NODE_ANGLE_INVALID',
        `普通节点（node）不允许携带朝向 angle，实际为 ${describeValue(raw)}`,
        { fieldPath: path },
      )
    }
    return null
  }
  if (raw === null) return null
  const value = readFiniteNumber(raw, path, '站点朝向 angle', 'MAP_NODE_ANGLE_INVALID')
  return normalizeMapAngle(value)
}

function readEdgeType(raw: unknown, path: string): FactoryMapEdge['edgeType'] {
  if (typeof raw !== 'string' || !(EDGE_TYPES as readonly string[]).includes(raw)) {
    throw new MapValidationError(
      'MAP_EDGE_TYPE_INVALID',
      `路径类型必须是 ${EDGE_TYPES.join('/')} 之一，实际为 ${describeValue(raw)}`,
      { fieldPath: path },
    )
  }
  return raw as FactoryMapEdge['edgeType']
}

function readIsBackEdge(raw: unknown, path: string): boolean {
  if (typeof raw !== 'boolean') {
    throw new MapValidationError(
      'MAP_IS_BACK_EDGE_INVALID',
      `isBackEdge 必须是 boolean（不接受 0/1 或字符串转换），实际为 ${describeValue(raw)}`,
      { fieldPath: path },
    )
  }
  return raw
}

const CONTROL_POINT_KEYS = ['cx', 'cy', 'dx', 'dy'] as const

interface LineControlPoints {
  readonly cx: null
  readonly cy: null
  readonly dx: null
  readonly dy: null
}

interface BezierControlPoints {
  readonly cx: number
  readonly cy: number
  readonly dx: number
  readonly dy: number
}

/** LINE 控制点组合（§3.3）：四项必须全部为 null */
function readLineControlPoints(raw: Record<string, unknown>, path: string): LineControlPoints {
  for (const key of CONTROL_POINT_KEYS) {
    if (raw[key] !== null) {
      throw new MapValidationError(
        'MAP_CONTROL_POINTS_INVALID',
        `LINE 路径控制点 ${key} 必须为 null，实际为 ${describeValue(raw[key])}`,
        { fieldPath: `${path}.${key}` },
      )
    }
  }
  return { cx: null, cy: null, dx: null, dy: null }
}

/** BEZIER 控制点组合（§3.3）：四项必须全部为有限数值且绝对值 ≤ 1000m，不做类型降级 */
function readBezierControlPoints(raw: Record<string, unknown>, path: string): BezierControlPoints {
  const points: Partial<Record<(typeof CONTROL_POINT_KEYS)[number], number>> = {}
  for (const key of CONTROL_POINT_KEYS) {
    points[key] = readCoordinate(raw[key], `${path}.${key}`, `BEZIER 路径控制点 ${key}`, 'MAP_CONTROL_POINTS_INVALID')
  }
  return {
    cx: points.cx as number,
    cy: points.cy as number,
    dx: points.dx as number,
    dy: points.dy as number,
  }
}

// ---------------------------------------------------------------------------
// 数组项解析（字段级错误逐条抛出，由下方集合函数收集）
// ---------------------------------------------------------------------------

/** 校验并规范化单个节点数组项；失败抛出 MapValidationError */
export function parseMapNode(raw: unknown, path: string): FactoryMapNode {
  if (!isPlainObject(raw)) {
    throw new MapValidationError(
      'MAP_ITEM_NOT_OBJECT',
      `节点数组项必须是非 null 对象，实际为 ${describeValue(raw)}`,
      { fieldPath: path },
    )
  }
  const id = readId(raw.id, `${path}.id`, '节点')
  const name = readName(raw.name, `${path}.name`, '节点')
  const type = readNodeType(raw.type, `${path}.type`)
  const x = readCoordinate(raw.x, `${path}.x`, '节点坐标 x', 'MAP_NUMBER_INVALID')
  const y = readCoordinate(raw.y, `${path}.y`, '节点坐标 y', 'MAP_NUMBER_INVALID')
  const angle = readNodeAngle(raw.angle, `${path}.angle`, type)
  return { id, name, type, x, y, angle }
}

/** 校验并规范化单个路径数组项；失败抛出 MapValidationError */
export function parseMapEdge(raw: unknown, path: string): FactoryMapEdge {
  if (!isPlainObject(raw)) {
    throw new MapValidationError(
      'MAP_ITEM_NOT_OBJECT',
      `路径数组项必须是非 null 对象，实际为 ${describeValue(raw)}`,
      { fieldPath: path },
    )
  }
  const id = readId(raw.id, `${path}.id`, '路径')
  const name = readName(raw.name, `${path}.name`, '路径')
  const edgeType = readEdgeType(raw.edgeType, `${path}.edgeType`)
  const sx = readCoordinate(raw.sx, `${path}.sx`, '路径起点 sx', 'MAP_NUMBER_INVALID')
  const sy = readCoordinate(raw.sy, `${path}.sy`, '路径起点 sy', 'MAP_NUMBER_INVALID')
  const ex = readCoordinate(raw.ex, `${path}.ex`, '路径终点 ex', 'MAP_NUMBER_INVALID')
  const ey = readCoordinate(raw.ey, `${path}.ey`, '路径终点 ey', 'MAP_NUMBER_INVALID')
  const isBackEdge = readIsBackEdge(raw.isBackEdge, `${path}.isBackEdge`)
  const snodeId = readId(raw.snodeId, `${path}.snodeId`, '路径起点引用')
  const enodeId = readId(raw.enodeId, `${path}.enodeId`, '路径终点引用')
  const base = { id, name, sx, sy, ex, ey, isBackEdge, snodeId, enodeId }
  if (edgeType === 'LINE') {
    return { ...base, edgeType, ...readLineControlPoints(raw, path) }
  }
  return { ...base, edgeType, ...readBezierControlPoints(raw, path) }
}

// ---------------------------------------------------------------------------
// 集合解析：逐条收集字段级错误（§11 错误总数），坏记录不进入返回集合
// ---------------------------------------------------------------------------

export interface ParseNodesResult {
  readonly nodes: FactoryMapNode[]
  readonly errors: MapValidationError[]
}

/** 解析全部节点；字段级错误（含重复 id）逐条收集，不中断后续记录的校验 */
export function parseMapNodes(rawNodes: readonly unknown[]): ParseNodesResult {
  const nodes: FactoryMapNode[] = []
  const errors: MapValidationError[] = []
  const firstIndexById = new Map<string, number>()
  for (let index = 0; index < rawNodes.length; index += 1) {
    const path = `nodes[${index}]`
    let node: FactoryMapNode
    try {
      node = parseMapNode(rawNodes[index], path)
    } catch (error) {
      if (error instanceof MapValidationError) {
        errors.push(error)
        continue
      }
      throw error
    }
    const firstIndex = firstIndexById.get(node.id)
    if (firstIndex !== undefined) {
      errors.push(
        new MapValidationError(
          'MAP_ID_DUPLICATED',
          `节点 id 重复：${JSON.stringify(node.id)}（首次出现于 nodes[${firstIndex}]）`,
          { fieldPath: `${path}.id` },
        ),
      )
      continue
    }
    firstIndexById.set(node.id, index)
    nodes.push(node)
  }
  return { nodes, errors }
}

export interface ParseEdgesResult {
  readonly edges: FactoryMapEdge[]
  readonly errors: MapValidationError[]
}

/** 解析全部路径；字段级错误（含重复 id）逐条收集，不中断后续记录的校验 */
export function parseMapEdges(rawEdges: readonly unknown[]): ParseEdgesResult {
  const edges: FactoryMapEdge[] = []
  const errors: MapValidationError[] = []
  const firstIndexById = new Map<string, number>()
  for (let index = 0; index < rawEdges.length; index += 1) {
    const path = `edges[${index}]`
    let edge: FactoryMapEdge
    try {
      edge = parseMapEdge(rawEdges[index], path)
    } catch (error) {
      if (error instanceof MapValidationError) {
        errors.push(error)
        continue
      }
      throw error
    }
    const firstIndex = firstIndexById.get(edge.id)
    if (firstIndex !== undefined) {
      errors.push(
        new MapValidationError(
          'MAP_ID_DUPLICATED',
          `路径 id 重复：${JSON.stringify(edge.id)}（首次出现于 edges[${firstIndex}]）`,
          { fieldPath: `${path}.id` },
        ),
      )
      continue
    }
    firstIndexById.set(edge.id, index)
    edges.push(edge)
  }
  return { edges, errors }
}

// ---------------------------------------------------------------------------
// 跨记录与几何不变量
// ---------------------------------------------------------------------------

/** 容量：nodes + edges ≤ 20000，超出返回 MapCapacityError（§3.3 容量行） */
export function assertMapElementCapacity(nodeCount: number, edgeCount: number): void {
  const total = nodeCount + edgeCount
  if (total > MAX_MAP_ELEMENTS) {
    throw new MapCapacityError(
      'MAP_ELEMENTS_EXCEEDED',
      `地图元素总数 ${total}（节点 ${nodeCount} + 路径 ${edgeCount}）超过上限 ${MAX_MAP_ELEMENTS}`,
      { actual: total, limit: MAX_MAP_ELEMENTS },
    )
  }
}

/** 地图范围：bbox 宽度和深度均 ≤ 220m，超出返回 MapCapacityError（§3.3 地图范围行） */
export function assertMapExtentWithinLimits(mapBounds: MapBounds | null): void {
  if (mapBounds === null) return
  const width = mapBounds.maxX - mapBounds.minX
  const depth = mapBounds.maxY - mapBounds.minY
  if (width > MAX_MAP_EXTENT || depth > MAX_MAP_EXTENT) {
    throw new MapCapacityError(
      'MAP_EXTENT_EXCEEDED',
      `地图范围 ${width.toFixed(2)}m × ${depth.toFixed(2)}m 超过上限 ${MAX_MAP_EXTENT}m × ${MAX_MAP_EXTENT}m`,
      { actual: Math.max(width, depth), limit: MAX_MAP_EXTENT },
    )
  }
}

/** 节点引用：snodeId / enodeId 必须引用当前地图中存在的节点（§3.3 节点引用行） */
export function assertNodeReferencesExist(
  edges: readonly FactoryMapEdge[],
  nodeIds: ReadonlySet<string>,
): void {
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index]
    if (!nodeIds.has(edge.snodeId)) {
      throw new MapValidationError(
        'MAP_NODE_REFERENCE_INVALID',
        `路径 ${JSON.stringify(edge.id)} 的起点引用了不存在的节点 ${JSON.stringify(edge.snodeId)}`,
        { fieldPath: `edges[${index}].snodeId` },
      )
    }
    if (!nodeIds.has(edge.enodeId)) {
      throw new MapValidationError(
        'MAP_NODE_REFERENCE_INVALID',
        `路径 ${JSON.stringify(edge.id)} 的终点引用了不存在的节点 ${JSON.stringify(edge.enodeId)}`,
        { fieldPath: `edges[${index}].enodeId` },
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 几何弧长（§3.3 路径长度行：按几何弧长计算，L < 0.01m 报错）
// ---------------------------------------------------------------------------

/** 弧长估计收敛容差（米）：仅用于不变量判定，远小于 0.01m 下限 */
const ARC_LENGTH_TOLERANCE = 1e-6

/** 自适应细分最大递归深度 */
const ARC_LENGTH_MAX_DEPTH = 16

/**
 * 三次贝塞尔弧长：De Casteljau 自适应细分。
 * 控制多边形长度与弦长之差收敛（或达到深度上限）时以两者均值作为该段弧长。
 */
function cubicBezierArcLength(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
  dx: number, dy: number,
  depth: number,
): number {
  const chord = Math.hypot(dx - ax, dy - ay)
  const polygon =
    Math.hypot(bx - ax, by - ay) + Math.hypot(cx - bx, cy - by) + Math.hypot(dx - cx, dy - cy)
  if (polygon - chord <= ARC_LENGTH_TOLERANCE || depth >= ARC_LENGTH_MAX_DEPTH) {
    return (polygon + chord) / 2
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
  return (
    cubicBezierArcLength(ax, ay, abx, aby, abbcx, abbcy, midx, midy, depth + 1)
    + cubicBezierArcLength(midx, midy, bccdx, bccdy, cdx, cdy, dx, dy, depth + 1)
  )
}

/** 路径几何弧长：LINE 为弦长；BEZIER 为自适应细分弧长 */
export function computeEdgeArcLength(edge: FactoryMapEdge): number {
  if (edge.edgeType === 'LINE') {
    return Math.hypot(edge.ex - edge.sx, edge.ey - edge.sy)
  }
  return cubicBezierArcLength(
    edge.sx, edge.sy, edge.cx, edge.cy, edge.dx, edge.dy, edge.ex, edge.ey, 0,
  )
}

/** 路径长度：几何弧长 L < 0.01m 返回 MapValidationError，不静默跳过（§3.3 路径长度行） */
export function assertEdgeArcLengths(edges: readonly FactoryMapEdge[]): void {
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index]
    const length = computeEdgeArcLength(edge)
    if (length < MIN_PATH_ARC_LENGTH) {
      throw new MapValidationError(
        'MAP_PATH_TOO_SHORT',
        `路径 ${JSON.stringify(edge.id)} 几何弧长 ${length.toFixed(4)}m 小于下限 ${MIN_PATH_ARC_LENGTH}m`,
        { fieldPath: `edges[${index}]` },
      )
    }
  }
}
