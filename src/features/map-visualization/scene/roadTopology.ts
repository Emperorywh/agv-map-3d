/**
 * 道路拓扑重建（视觉对齐改造 P0-5.3）。
 *
 * 职责：在物理路径去重结果之上重建「展示级道路网络」——把只经过二度节点
 *       （恰好两条物理路径相连）的连续道路合并为一条链式 polyline，识别
 *       三岔及以上交叉节点。几何构建层据此：
 *       1. 保留连续链供诊断，路面独立按全部物理路径构建，不按链筛选；
 *       2. 包络并集裁掉路口内部边线，再描连续白色外边界；
 *       3. 从交叉节点中筛选稀疏蓝色光点，不再逐节点叠加圆盘路口。
 * 边界：纯数据拓扑，不创建 Three.js 对象、不进 React；输入必须来自
 *       dedupePhysicalPaths 的物理路径索引与只读 MapModel。
 * 关键不变量：
 * 1. 每条物理路径恰好进入一条链且只进入一次（visited 全覆盖，无遗漏、无
 *    重复）；链的采样点顺序与行进方向一致，相邻路径在共享节点处首尾相接；
 * 2. 度数 = 节点邻接的物理路径端数：二度节点被合并穿越，一度（断头）与
 *    三度以上（交叉）节点是链的端点；
 * 3. 链端节点与度数判定一致：道路分级与边界裁剪由构建层完成，
 *    本模块不预设宽度、端帽或交叉点的外观决策。
 */
import type { MapModel } from '../model/types'
import type { PlanePoint2 } from '../model/edgeGeometry'
import type { PhysicalPathIndex } from './buildMapGeometry'

/** 一条合并后的连续道路链（展示级道路的最小渲染单元） */
export interface RoadChain {
  readonly index: number
  /** 平面坐标采样点（米）：成员物理路径按行进方向顺序拼接、去重共享节点 */
  readonly points: readonly PlanePoint2[]
  /** 链起点节点 ID（与 points[0] 对应） */
  readonly startNodeId: string
  /** 链终点节点 ID（与 points[points.length-1] 对应） */
  readonly endNodeId: string
  /** 合并进本链的物理路径 index（按行进顺序；诊断与测试用） */
  readonly pathIndexes: readonly number[]
}

/** 交叉节点（度数 ≥3）：关键路口光点的候选来源 */
export interface RoadJunction {
  readonly nodeId: string
  /** 平面坐标（米） */
  readonly x: number
  readonly y: number
  /** 邻接物理路径端数（= 道路度数） */
  readonly degree: number
}

/** 重建后的道路网络（纯数据） */
export interface RoadNetwork {
  readonly chains: readonly RoadChain[]
  readonly junctions: readonly RoadJunction[]
  /** nodeId → 邻接物理路径端数（全路径端点节点覆盖） */
  readonly nodeDegree: ReadonlyMap<string, number>
  /** 被合并穿越的二度节点数（诊断用） */
  readonly mergedNodeCount: number
}

/** 物理路径端点侧：与 points[0] / points[length-1] 对应的节点 */
type PathEnd = 'start' | 'end'

interface PathEndpointInfo {
  readonly startNodeId: string
  readonly endNodeId: string
}

/**
 * 判定物理路径两端各自的节点 ID。路径采样点可能被归一化反向（与代表逻辑
 * 边方向相反），用首点与逻辑边起点坐标的一致性判定方向（坐标来自同一
 * 节点字段，精确相等；容差只防浮点格式噪声）。
 */
function resolvePathEndpoints(
  mapModel: MapModel,
  physical: PhysicalPathIndex,
): PathEndpointInfo[] {
  const CoordEpsilon = 1e-6
  return physical.physicalPaths.map((path) => {
    const edge = mapModel.edges.get(path.representativeEdgeId)
    if (edge === undefined) {
      // 输入合同要求物理路径来自同一 MapModel；兜底视为孤立路径
      return { startNodeId: '', endNodeId: '' }
    }
    const first = path.points[0]
    const startsAtSource =
      Math.abs(first.x - edge.sx) < CoordEpsilon &&
      Math.abs(first.y - edge.sy) < CoordEpsilon
    return startsAtSource
      ? { startNodeId: edge.snodeId, endNodeId: edge.enodeId }
      : { startNodeId: edge.enodeId, endNodeId: edge.snodeId }
  })
}

/** 反转采样点副本（不修改物理路径的冻结数组） */
function reversedPoints(points: readonly PlanePoint2[]): PlanePoint2[] {
  return [...points].reverse()
}

/**
 * 重建道路网络：邻接统计 → 链合并（穿越全部二度节点）→ 交叉节点识别。
 * 链合并从每条未访问路径向两端生长：当前端点是二度节点时，取邻接的另一条
 * 未访问路径按行进方向拼接（跳过共享节点重复点）并继续；环路的闭合路径
 * 已访问时停止，避免重复入链。
 */
export function buildRoadNetwork(
  mapModel: MapModel,
  physical: PhysicalPathIndex,
): RoadNetwork {
  const endpoints = resolvePathEndpoints(mapModel, physical)

  // 节点邻接：nodeId → [(路径 index, 端点侧)]
  const incidents = new Map<string, { pathIndex: number; end: PathEnd }[]>()
  const addIncident = (
    nodeId: string,
    pathIndex: number,
    end: PathEnd,
  ): void => {
    if (nodeId === '') {
      return
    }
    const list = incidents.get(nodeId)
    if (list === undefined) {
      incidents.set(nodeId, [{ pathIndex, end }])
    } else {
      list.push({ pathIndex, end })
    }
  }
  endpoints.forEach((info, pathIndex) => {
    addIncident(info.startNodeId, pathIndex, 'start')
    addIncident(info.endNodeId, pathIndex, 'end')
  })

  const nodeDegree = new Map<string, number>()
  for (const [nodeId, list] of incidents) {
    nodeDegree.set(nodeId, list.length)
  }

  /** 取节点上除 excludePath 之外的唯一邻接项（二度节点恰有一条） */
  const otherIncidentAt = (
    nodeId: string,
    excludePath: number,
  ): { pathIndex: number; end: PathEnd } | null => {
    const list = incidents.get(nodeId)
    if (list === undefined) {
      return null
    }
    for (const item of list) {
      if (item.pathIndex !== excludePath) {
        return item
      }
    }
    return null
  }

  const visited = new Set<number>()
  const chains: RoadChain[] = []
  let mergedNodeCount = 0

  /** 物理路径给定端侧上的节点 ID（链生长游标所在节点） */
  const nodeAt = (pathIndex: number, end: PathEnd): string =>
    end === 'start'
      ? endpoints[pathIndex].startNodeId
      : endpoints[pathIndex].endNodeId

  for (let seed = 0; seed < physical.physicalPaths.length; seed += 1) {
    if (visited.has(seed)) {
      continue
    }
    visited.add(seed)
    const seedPoints = physical.physicalPaths[seed].points
    let startNodeId = endpoints[seed].startNodeId
    let endNodeId = endpoints[seed].endNodeId
    let points: PlanePoint2[] = [...seedPoints]
    const pathIndexes: number[] = [seed]

    // 向终点方向生长：穿越二度终端节点
    let cursor = seed
    let cursorEnd: PathEnd = 'end'
    while (true) {
      const node = nodeAt(cursor, cursorEnd)
      if ((nodeDegree.get(node) ?? 0) !== 2) {
        endNodeId = node
        break
      }
      const next = otherIncidentAt(node, cursor)
      if (next === null || visited.has(next.pathIndex)) {
        // 环路闭合（链回到已访问路径）：保持当前端点，避免重复入链
        endNodeId = node
        break
      }
      visited.add(next.pathIndex)
      mergedNodeCount += 1
      const nextPath = physical.physicalPaths[next.pathIndex]
      const nextPoints =
        next.end === 'start' ? [...nextPath.points] : reversedPoints(nextPath.points)
      // 行进方向：next 的首点即共享节点，跳过避免重复
      points = points.concat(nextPoints.slice(1))
      pathIndexes.push(next.pathIndex)
      cursor = next.pathIndex
      // 从 next.end 侧进入该路径后，链的行进端点停在它的对侧
      cursorEnd = next.end === 'start' ? 'end' : 'start'
    }

    // 向起点方向生长：对称处理
    cursor = seed
    cursorEnd = 'start'
    while (true) {
      const node = nodeAt(cursor, cursorEnd)
      if ((nodeDegree.get(node) ?? 0) !== 2) {
        startNodeId = node
        break
      }
      const prev = otherIncidentAt(node, cursor)
      if (prev === null || visited.has(prev.pathIndex)) {
        startNodeId = node
        break
      }
      visited.add(prev.pathIndex)
      mergedNodeCount += 1
      const prevPath = physical.physicalPaths[prev.pathIndex]
      const prevPoints =
        prev.end === 'end' ? [...prevPath.points] : reversedPoints(prevPath.points)
      // 行进方向：prev 的末点即共享节点，跳过避免重复
      points = prevPoints.slice(0, -1).concat(points)
      pathIndexes.unshift(prev.pathIndex)
      cursor = prev.pathIndex
      // 从 prev.end 侧进入该路径后，链的起点端点停在它的对侧
      cursorEnd = prev.end === 'start' ? 'end' : 'start'
    }

    chains.push({
      index: chains.length,
      points: Object.freeze(points),
      startNodeId,
      endNodeId,
      pathIndexes: Object.freeze(pathIndexes),
    })
  }

  /**
   * 每个三度及以上节点只登记一次，供展示层筛选关键路口。
   * 节点记录不代表新增通行连接，实际方向仍由 MapModel 的有向边决定。
   */
  const junctions: RoadJunction[] = []
  for (const node of mapModel.nodeList) {
    const degree = nodeDegree.get(node.id) ?? 0
    if (degree >= 3) {
      junctions.push({ nodeId: node.id, x: node.x, y: node.y, degree })
    }
  }

  return {
    chains: Object.freeze(chains),
    junctions: Object.freeze(junctions),
    nodeDegree,
    mergedNodeCount,
  }
}
