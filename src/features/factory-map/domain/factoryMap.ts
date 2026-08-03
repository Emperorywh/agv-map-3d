/**
 * 只读领域实体与合法枚举（SPEC §3.2、§3.3）。
 * 校验完成后才允许创建 FactoryMap；创建后深度冻结，任何层不得就地修改。
 */

/** 合法节点类型（§3.2）；其他值返回 MapValidationError */
export const NODE_TYPES = ['node', 'work', 'park', 'charge'] as const

export type NodeType = (typeof NODE_TYPES)[number]

/** 合法路径类型（§3.2）；不存在其他合法值 */
export const EDGE_TYPES = ['LINE', 'BEZIER'] as const

export type EdgeType = (typeof EDGE_TYPES)[number]

/** 站点（work/park/charge）才允许携带朝向 angle（§3.3、§7.3） */
export function isStationNodeType(type: NodeType): boolean {
  return type !== 'node'
}

export interface FactoryMapNode {
  readonly id: string
  readonly name: string
  readonly type: NodeType
  /** 平面坐标，米。数学坐标系：x 向东，y 向北 */
  readonly x: number
  readonly y: number
  /** 朝向弧度，进入领域模型时已规范化到 [-π, π)；null = 无朝向（不画朝向符号） */
  readonly angle: number | null
}

interface FactoryMapEdgeBase {
  readonly id: string
  readonly name: string
  /** 起点/终点平面坐标，米 */
  readonly sx: number
  readonly sy: number
  readonly ex: number
  readonly ey: number
  /** 反向路径标识：true = 反向（红色语义），false = 正向（灰色语义） */
  readonly isBackEdge: boolean
  /** 起止节点 id 引用；必须引用当前 mapJson 中存在的节点 */
  readonly snodeId: string
  readonly enodeId: string
}

/** LINE：四个控制点必须全为 null（§3.3，不做类型降级） */
export interface FactoryMapLineEdge extends FactoryMapEdgeBase {
  readonly edgeType: 'LINE'
  readonly cx: null
  readonly cy: null
  readonly dx: null
  readonly dy: null
}

/** BEZIER：两个控制点四项必须全为有限数值（§3.3） */
export interface FactoryMapBezierEdge extends FactoryMapEdgeBase {
  readonly edgeType: 'BEZIER'
  readonly cx: number
  readonly cy: number
  readonly dx: number
  readonly dy: number
}

export type FactoryMapEdge = FactoryMapLineEdge | FactoryMapBezierEdge

/** 只读地图实体：消费字段仅 nodes/edges，zones/nodeEdgeGroups 等不进入领域模型（§3.2） */
export interface FactoryMap {
  readonly nodes: readonly FactoryMapNode[]
  readonly edges: readonly FactoryMapEdge[]
}

/**
 * 创建只读 FactoryMap：冻结实体、两个集合与每个元素。
 * 调用方必须已完成 §3.3 全部不变量校验（见 invariants.ts / decodeMapEnvelope.ts）。
 */
export function createFactoryMap(
  nodes: readonly FactoryMapNode[],
  edges: readonly FactoryMapEdge[],
): FactoryMap {
  for (const node of nodes) Object.freeze(node)
  for (const edge of edges) Object.freeze(edge)
  return Object.freeze({
    nodes: Object.freeze([...nodes]),
    edges: Object.freeze([...edges]),
  })
}
