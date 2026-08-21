/**
 * 详情面板视图模型（SPEC §8.2）：由 domain 纯数据派生面板展示结构的纯函数。
 *
 * ui 层只消费 domain 类型与 store、不 import rendering（SPEC §12）——
 * 本模块是面板与 domain 数据之间的唯一转换点，全部字段在此一次性解析
 * （边名称 / 端点节点名 / 方向分组），组件只做展示。
 */

import type { AgvSnapshot, AgvStatus } from '../domain/simulator'
import type { NodeKind, NormalizedEdge, NormalizedMap } from '../domain/types'

// ---------------------------------------------------------------------------
// 节点详情：名称 / 类型 / 坐标 / angle / 关联边列表
// ---------------------------------------------------------------------------

/** 节点关联边（有向边，含端点节点名解析） */
export interface NodeEdgeRef {
  id: string
  name: string
  fromId: string
  fromName: string
  toId: string
  toName: string
  /** true = 该方向倒车通过（源数据 isBackEdge） */
  isBackEdge: boolean
}

export interface NodeDetails {
  kind: 'node'
  id: string
  name: string
  nodeKind: NodeKind
  /** 地图平面坐标（米，规范化原始值） */
  x: number
  y: number
  /** 停放 / 作业朝向（弧度）；数据为空时为 null */
  angle: number | null
  /** 关联有向边列表（from 或 to 指向该节点） */
  edges: NodeEdgeRef[]
}

/** 由规范化地图派生节点详情；节点不存在返回 null */
export function buildNodeDetails(map: NormalizedMap, nodeId: string): NodeDetails | null {
  const node = map.nodes.find((item) => item.id === nodeId)
  if (node === undefined) {
    return null
  }
  const nodeName = (id: string) => map.nodes.find((item) => item.id === id)?.name ?? id
  const edges: NodeEdgeRef[] = []
  for (const edge of map.edges) {
    if (edge.from !== nodeId && edge.to !== nodeId) {
      continue
    }
    edges.push({
      id: edge.id,
      name: edge.name,
      fromId: edge.from,
      fromName: nodeName(edge.from),
      toId: edge.to,
      toName: nodeName(edge.to),
      isBackEdge: edge.isBackEdge,
    })
  }
  return {
    kind: 'node',
    id: node.id,
    name: node.name,
    nodeKind: node.kind,
    x: node.x,
    y: node.y,
    angle: node.angle,
    edges,
  }
}

// ---------------------------------------------------------------------------
// 走廊详情：名称 / 单双向 / 是否倒车 / 长度 / cost / 限速等原始属性（按方向分组）
// ---------------------------------------------------------------------------

/**
 * 走廊单方向的有向属性组（SPEC §8.2：双向走廊两方向的有向属性——
 * 限速 / 加速度 / cost 可能不同——按方向分组展示，单向仅一组）。
 * 限速 / 加速度等字段源数据可为 null（SPEC §7.2 缺省兜底由模拟器处理，面板原样展示）。
 */
export interface CorridorDirectionDetails {
  /** 该方向有向边 id / 名称 */
  edgeId: string
  edgeName: string
  fromId: string
  fromName: string
  toId: string
  toName: string
  /** true = 该方向倒车通过（源数据 isBackEdge） */
  isBack: boolean
  /** 有向边折线长度（米） */
  length: number
  cost: number
  maxSpeedLoad: number | null
  maxSpeedFree: number | null
  maxAccelerationLoad: number | null
  maxAccelerationFree: number | null
  maxDecelerationLoad: number | null
  maxDecelerationFree: number | null
  maxRotationSpeedLoad: number | null
  maxRotationSpeedFree: number | null
  /** 入边 / 出边车头朝向（弧度，SPEC §7.2 车头语义） */
  sFacing: number
  eFacing: number
}

export interface CorridorDetails {
  kind: 'corridor'
  id: string
  /** 走廊两端节点（标题名用端点节点名展示） */
  nodeAId: string
  nodeAName: string
  nodeBId: string
  nodeBName: string
  bidirectional: boolean
  /** 走廊统一几何长度（米） */
  length: number
  /** 各行驶方向的有向属性组（1~2 项，nodeA→nodeB 在前） */
  directions: CorridorDirectionDetails[]
}

/** 由规范化地图派生走廊详情；走廊不存在或其方向边缺失返回 null */
export function buildCorridorDetails(
  map: NormalizedMap,
  corridorId: string,
): CorridorDetails | null {
  const corridor = map.corridors.find((item) => item.id === corridorId)
  if (corridor === undefined) {
    return null
  }
  const nodeName = (id: string) => map.nodes.find((item) => item.id === id)?.name ?? id
  const directions: CorridorDirectionDetails[] = []
  for (const direction of corridor.directions) {
    const edge = map.edges.find((item) => item.id === direction.edgeId)
    if (edge === undefined) {
      return null
    }
    directions.push(buildDirectionDetails(edge, nodeName))
  }
  return {
    kind: 'corridor',
    id: corridor.id,
    nodeAId: corridor.nodeA,
    nodeAName: nodeName(corridor.nodeA),
    nodeBId: corridor.nodeB,
    nodeBName: nodeName(corridor.nodeB),
    bidirectional: corridor.bidirectional,
    length: corridor.geometry.length,
    directions,
  }
}

function buildDirectionDetails(
  edge: NormalizedEdge,
  nodeName: (id: string) => string,
): CorridorDirectionDetails {
  return {
    edgeId: edge.id,
    edgeName: edge.name,
    fromId: edge.from,
    fromName: nodeName(edge.from),
    toId: edge.to,
    toName: nodeName(edge.to),
    isBack: edge.isBackEdge,
    length: edge.geometry.length,
    cost: edge.cost,
    maxSpeedLoad: edge.maxSpeedLoad,
    maxSpeedFree: edge.maxSpeedFree,
    maxAccelerationLoad: edge.maxAccelerationLoad,
    maxAccelerationFree: edge.maxAccelerationFree,
    maxDecelerationLoad: edge.maxDecelerationLoad,
    maxDecelerationFree: edge.maxDecelerationFree,
    maxRotationSpeedLoad: edge.maxRotationSpeedLoad,
    maxRotationSpeedFree: edge.maxRotationSpeedFree,
    sFacing: edge.sFacing,
    eFacing: edge.eFacing,
  }
}

// ---------------------------------------------------------------------------
// AGV 详情：编号 / 状态 / 当前任务 / 所在边 / 电量（模拟值）
// ---------------------------------------------------------------------------

export interface AgvDetails {
  kind: 'agv'
  /** AGV 编号（0 起） */
  id: number
  status: AgvStatus
  /** 当前任务描述；空闲时为 null */
  task: string | null
  /** 当前行驶所在有向边（id + 名称）；停靠时为 null */
  edgeId: string | null
  edgeName: string | null
  /** 当前停靠节点（id + 名称）；行驶中为 null */
  nodeId: string | null
  nodeName: string | null
  /** 电量百分比（模拟值，0~100） */
  battery: number
}

/**
 * 由模拟器快照派生 AGV 详情；边 / 节点名称经 mapData 解析（mapData 为 null 时回退 id）。
 * 快照不存在（编号越界）返回 null。
 */
export function buildAgvDetails(
  snapshots: readonly AgvSnapshot[],
  map: NormalizedMap | null,
  agvId: number,
): AgvDetails | null {
  const snapshot = snapshots.find((item) => item.id === agvId)
  if (snapshot === undefined) {
    return null
  }
  const edge =
    snapshot.edgeId === null
      ? undefined
      : map?.edges.find((item) => item.id === snapshot.edgeId)
  const node =
    snapshot.nodeId === null
      ? undefined
      : map?.nodes.find((item) => item.id === snapshot.nodeId)
  return {
    kind: 'agv',
    id: snapshot.id,
    status: snapshot.status,
    task: snapshot.task,
    edgeId: snapshot.edgeId,
    edgeName: edge?.name ?? snapshot.edgeId,
    nodeId: snapshot.nodeId,
    nodeName: node?.name ?? snapshot.nodeId,
    battery: snapshot.battery,
  }
}

// ---------------------------------------------------------------------------
// 展示标签（中文）：节点类型 / AGV 状态
// ---------------------------------------------------------------------------

/** 节点类型中文标签（elevator 仅预留，SPEC §6.3） */
export const NODE_KIND_LABELS: Record<NodeKind, string> = {
  node: '导航点',
  work: '装卸站点',
  charge: '充电位',
  park: '停车位',
  elevator: '电梯',
}

/** AGV 对外状态中文标签（SPEC §7.1 状态集合） */
export const AGV_STATUS_LABELS: Record<AgvStatus, string> = {
  idle: '空闲',
  toPick: '去取货',
  hauling: '载货中',
  toCharge: '去充电',
  charging: '充电中',
  loading: '装卸中',
}
