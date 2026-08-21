/**
 * 走廊配对与去重（SPEC §6.1）：按无序节点对聚合有向边为 Corridor。
 *
 * 规则：
 * - 一条走廊只保留一条统一几何（渲染与模拟共用，SPEC §4.2 / §7.2）：
 *   几何一致（配对边按弧长对向采样最大偏差 ≤ 阈值）时取 nodeA→nodeB 方向边；
 *   偏差超阈值（默认 0.3m）时取较短者，console 警告并计数；
 * - 走廊通行属性全部落在 directions 上：双向（存在反向配对）不画箭头、
 *   单向画 snode→enode 箭头、back 方向归属等渲染标识由 rendering 层据此派生；
 * - 同方向重复边（数据异常，当前实测 0）取较短者并警告计数（SPEC §10 分级降级原则）。
 *
 * domain 层不 import config（SPEC §12），偏差阈值由调用方传入，缺省用本模块默认值。
 */

import { samplePolylineAt } from './polyline'
import type { Corridor, CorridorDirection, NormalizedEdge, Polyline } from './types'

/** 配对边几何偏差阈值缺省值（米，SPEC §6.1 / §15.3 默认 0.3，可配） */
export const DEFAULT_CORRIDOR_GEOMETRY_TOLERANCE = 0.3

export interface BuildCorridorsOptions {
  /** 配对边几何偏差阈值（米），缺省 DEFAULT_CORRIDOR_GEOMETRY_TOLERANCE */
  geometryDeviationThreshold?: number
}

/** 走廊配对统计（SPEC §4.1 实测分布口径；§10 计数要求） */
export interface CorridorStats {
  /** 输入有向边数 */
  inputEdges: number
  /** 走廊总数 */
  corridors: number
  /** 双向走廊数（存在反向配对边） */
  bidirectional: number
  /** 单向走廊数 */
  oneWay: number
  /** 双向组中恰一条 isBackEdge 的组数 */
  bidirectionalWithBack: number
  /** 双向组中两条均非 back 的组数 */
  bidirectionalBothForward: number
  /** 双向组中两条均 back 的组数（实测 0，用于算术封闭校验） */
  bidirectionalBothBack: number
  /** 无配对单向 back 边数（渲染：整条虚线 + 异色） */
  oneWayBack: number
  /** 配对边几何偏差超阈值、取较短者的组数（console 警告计数） */
  geometryMismatch: number
  /** 同方向重复边被丢弃的条数（数据异常兜底，实测 0） */
  duplicateDirectionEdges: number
}

export interface BuildCorridorsResult {
  corridors: Corridor[]
  stats: CorridorStats
}

/** 偏差对向采样间距（米）：每 ≤0.5m 采样一对点 */
const DEVIATION_SAMPLE_SPACING = 0.5
/** 偏差采样点数上下限 */
const DEVIATION_SAMPLE_MIN = 4
const DEVIATION_SAMPLE_MAX = 64

/** 按无序节点对聚合有向边为走廊（确定性：端点按 id 字典序、方向 nodeA→nodeB 在前） */
export function buildCorridors(
  edges: NormalizedEdge[],
  options?: BuildCorridorsOptions,
): BuildCorridorsResult {
  const threshold = options?.geometryDeviationThreshold ?? DEFAULT_CORRIDOR_GEOMETRY_TOLERANCE

  const stats: CorridorStats = {
    inputEdges: edges.length,
    corridors: 0,
    bidirectional: 0,
    oneWay: 0,
    bidirectionalWithBack: 0,
    bidirectionalBothForward: 0,
    bidirectionalBothBack: 0,
    oneWayBack: 0,
    geometryMismatch: 0,
    duplicateDirectionEdges: 0,
  }

  interface PairGroup {
    nodeA: string
    nodeB: string
    edges: NormalizedEdge[]
  }
  const groups = new Map<string, PairGroup>()
  for (const edge of edges) {
    const forwardOrder = edge.from < edge.to
    const nodeA = forwardOrder ? edge.from : edge.to
    const nodeB = forwardOrder ? edge.to : edge.from
    const key = `${nodeA}|${nodeB}`
    let group = groups.get(key)
    if (group === undefined) {
      group = { nodeA, nodeB, edges: [] }
      groups.set(key, group)
    }
    group.edges.push(edge)
  }

  const corridors: Corridor[] = []
  for (const group of groups.values()) {
    const { nodeA, nodeB } = group
    // 拆分两个行驶方向；同方向重复边取较短者并警告计数（当前数据不出现）
    const forward = pickDirectionEdge(
      group.edges.filter((edge) => edge.from === nodeA),
      stats,
    )
    const backward = pickDirectionEdge(
      group.edges.filter((edge) => edge.from === nodeB),
      stats,
    )

    // 统一几何：一致时取 nodeA→nodeB 方向；偏差超阈值取较短者并警告（SPEC §6.1 规则 2）
    let reference: NormalizedEdge
    if (forward !== null && backward !== null) {
      const deviation = opposingDeviation(forward.geometry, backward.geometry)
      if (deviation > threshold) {
        reference = forward.geometry.length <= backward.geometry.length ? forward : backward
        stats.geometryMismatch++
        console.warn(
          `[corridors] 走廊 ${nodeA}|${nodeB} 配对边几何偏差 ${deviation.toFixed(3)}m ` +
            `超阈值 ${threshold}m，取较短者渲染`,
        )
      } else {
        reference = forward
      }
    } else {
      reference = (forward ?? backward) as NormalizedEdge
    }

    const directions: CorridorDirection[] = []
    for (const edge of [forward, backward]) {
      if (edge === null) {
        continue
      }
      directions.push({
        edgeId: edge.id,
        from: edge.from,
        to: edge.to,
        alongGeometry: edge.from === reference.from,
        isBack: edge.isBackEdge,
      })
    }

    const bidirectional = forward !== null && backward !== null
    const backCount = directions.filter((direction) => direction.isBack).length
    if (bidirectional) {
      stats.bidirectional++
      if (backCount === 1) stats.bidirectionalWithBack++
      else if (backCount === 0) stats.bidirectionalBothForward++
      else stats.bidirectionalBothBack++
    } else {
      stats.oneWay++
      if (backCount === 1) stats.oneWayBack++
    }

    corridors.push({
      id: `c:${nodeA}|${nodeB}`,
      nodeA,
      nodeB,
      edgeIds: directions.map((direction) => direction.edgeId),
      geometry: reference.geometry,
      bidirectional,
      directions,
    })
  }

  stats.corridors = corridors.length
  if (stats.geometryMismatch > 0 || stats.duplicateDirectionEdges > 0) {
    console.warn(
      `[corridors] 配对质量计数：几何偏差超阈值 ${stats.geometryMismatch} 组（阈值 ${threshold}m），` +
        `同方向重复边丢弃 ${stats.duplicateDirectionEdges} 条`,
    )
  }
  return { corridors, stats }
}

/** 同方向边取几何较短者；>1 条时警告计数（数据异常兜底，SPEC §10） */
function pickDirectionEdge(
  directionEdges: NormalizedEdge[],
  stats: CorridorStats,
): NormalizedEdge | null {
  if (directionEdges.length === 0) {
    return null
  }
  let shortest = directionEdges[0]
  for (const edge of directionEdges.slice(1)) {
    if (edge.geometry.length < shortest.geometry.length) {
      shortest = edge
    }
  }
  if (directionEdges.length > 1) {
    stats.duplicateDirectionEdges += directionEdges.length - 1
    console.warn(
      `[corridors] ${shortest.from} → ${shortest.to} 存在 ${directionEdges.length} 条同方向边，` +
        `取较短者 ${shortest.id}，丢弃 ${directionEdges.length - 1} 条`,
    )
  }
  return shortest
}

/**
 * 配对边几何最大偏差：两条边行驶方向相反，
 * 按弧长参数 t 对向采样（forward 在 t 处的点 vs backward 在 1-t 处的点）取最大距离。
 */
function opposingDeviation(forward: Polyline, backward: Polyline): number {
  const maxLength = Math.max(forward.length, backward.length)
  const sampleCount = Math.min(
    DEVIATION_SAMPLE_MAX,
    Math.max(DEVIATION_SAMPLE_MIN, Math.ceil(maxLength / DEVIATION_SAMPLE_SPACING)),
  )
  let maxDeviation = 0
  for (let i = 0; i <= sampleCount; i++) {
    const t = i / sampleCount
    const a = samplePolylineAt(forward, t * forward.length).point
    const b = samplePolylineAt(backward, (1 - t) * backward.length).point
    const distance = Math.hypot(a.x - b.x, a.y - b.y)
    if (distance > maxDeviation) {
      maxDeviation = distance
    }
  }
  return maxDeviation
}
