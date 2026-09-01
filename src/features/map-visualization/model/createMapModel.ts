/**
 * 逻辑索引与静态派生模型（SPEC §2.5、§9.1、§10.3 阶段 3；TASK-003）。
 *
 * 职责：以校验后的地图数据为唯一输入，一次性建立世界坐标原点、场景包围盒、
 *       节点/边/分组索引、有向出边、弱连通分量与 charge 查询，产出冻结的
 *       只读 MapModel 与配套 WorldTransform。
 * 边界：不做校验（输入必须来自 validateMap）、不做几何离散化以外的派生
 *       （物理路径去重与 Three 几何属 TASK-004 场景层）、不实现寻路
 *       （Dijkstra 属 mock-simulation）；本模块只提供 O(1) 查询索引。
 * 关键不变量：
 * 1. 世界原点只来自「节点平面包围盒中心经仿射后的点」，在建模型期间计算
 *    一次；与节点遍历顺序、车辆到达顺序无关（包围盒中心是顺序无关量）；
 * 2. 弱连通分量覆盖全部节点（含无边的孤立单节点分量），按节点数降序编号，
 *    同尺寸以最小节点插入序决胜——编号稳定，可供 Mock 安全引用；
 * 3. 有向出边索引只含 snodeId → 出边方向，绝不因反向几何混入入边；
 * 4. 输出深度冻结：条目、数组、索引容器全部不可通过公开引用修改。
 */
import {
  createPlaneTransform,
  createWorldTransform,
  IDENTITY_AFFINE,
  type AffineParams,
  type WorldTransform,
} from '@/shared/spatial'
import type {
  MapComponent,
  MapModel,
  MapNode,
  SceneBounds,
  ValidatedMapData,
} from './types'

export interface CreateMapModelOptions {
  /** 运行时二维仿射参数；缺省为恒等变换（当前输入即恒等） */
  coordinateTransform?: AffineParams
}

export interface CreateMapModelResult {
  readonly mapModel: MapModel
  readonly worldTransform: WorldTransform
}

/** 并查集：路径压缩 + 按秩合并前先按大小合并，保证近线性构建耗时 */
class UnionFind {
  private readonly parent: number[]
  private readonly rank: number[]

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i)
    this.rank = new Array<number>(size).fill(0)
  }

  find(x: number): number {
    let root = x
    while (this.parent[root] !== root) {
      root = this.parent[root]
    }
    while (this.parent[x] !== root) {
      const next = this.parent[x]
      this.parent[x] = root
      x = next
    }
    return root
  }

  union(a: number, b: number): void {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA === rootB) {
      return
    }
    if (this.rank[rootA] < this.rank[rootB]) {
      this.parent[rootA] = rootB
    } else if (this.rank[rootA] > this.rank[rootB]) {
      this.parent[rootB] = rootA
    } else {
      this.parent[rootB] = rootA
      this.rank[rootA] += 1
    }
  }
}

/** 由节点集合计算世界场景包围盒；空地图回退为全零退化包围盒 */
function computeSceneBounds(
  nodeList: readonly MapNode[],
  toWorldXZ: (x: number, y: number) => { x: number; z: number },
): SceneBounds {
  let minWorldX = Infinity
  let maxWorldX = -Infinity
  let minWorldZ = Infinity
  let maxWorldZ = -Infinity
  for (const node of nodeList) {
    const p = toWorldXZ(node.x, node.y)
    if (p.x < minWorldX) minWorldX = p.x
    if (p.x > maxWorldX) maxWorldX = p.x
    if (p.z < minWorldZ) minWorldZ = p.z
    if (p.z > maxWorldZ) maxWorldZ = p.z
  }
  if (!Number.isFinite(minWorldX)) {
    minWorldX = 0
    maxWorldX = 0
    minWorldZ = 0
    maxWorldZ = 0
  }
  return Object.freeze({
    minWorldX,
    maxWorldX,
    minWorldZ,
    maxWorldZ,
    centerWorldX: (minWorldX + maxWorldX) / 2,
    centerWorldZ: (minWorldZ + maxWorldZ) / 2,
    diagonal: Math.hypot(maxWorldX - minWorldX, maxWorldZ - minWorldZ),
  })
}

/** 建立弱连通分量：覆盖全部节点，节点数降序编号，尺寸相同按插入序稳定 */
function buildComponents(
  nodeList: readonly MapNode[],
  nodeIndexOfId: ReadonlyMap<string, number>,
  edges: readonly { snodeId: string; enodeId: string }[],
): { components: readonly MapComponent[]; componentIndexOfNode: Map<string, number> } {
  const unionFind = new UnionFind(nodeList.length)
  for (const edge of edges) {
    const a = nodeIndexOfId.get(edge.snodeId)
    const b = nodeIndexOfId.get(edge.enodeId)
    // 输入来自 validateMap：边引用必然有效；此处兜底跳过以防误用
    if (a === undefined || b === undefined) {
      continue
    }
    unionFind.union(a, b)
  }

  // 按并查集根归并节点，同时记录每个分量的最小插入序（平局决胜用）
  interface RootGroup {
    root: number
    memberIndexes: number[]
    minIndex: number
  }
  const groups: RootGroup[] = []
  const rootToGroup = new Map<number, RootGroup>()
  nodeList.forEach((_node, index) => {
    const root = unionFind.find(index)
    const existing = rootToGroup.get(root)
    if (existing) {
      existing.memberIndexes.push(index)
    } else {
      const group: RootGroup = { root, memberIndexes: [index], minIndex: index }
      rootToGroup.set(root, group)
      groups.push(group)
    }
  })

  const edgeCountByRoot = new Map<number, number>()
  for (const edge of edges) {
    const a = nodeIndexOfId.get(edge.snodeId)
    if (a === undefined) {
      continue
    }
    const root = unionFind.find(a)
    edgeCountByRoot.set(root, (edgeCountByRoot.get(root) ?? 0) + 1)
  }

  // 节点数降序；同尺寸按最小插入序升序——编号与输入遍历顺序都稳定
  groups.sort((groupA, groupB) => {
    const sizeDiff = groupB.memberIndexes.length - groupA.memberIndexes.length
    if (sizeDiff !== 0) {
      return sizeDiff
    }
    return groupA.minIndex - groupB.minIndex
  })

  const components: MapComponent[] = []
  const componentIndexOfNode = new Map<string, number>()
  groups.forEach((group, index) => {
    const nodeIds: string[] = []
    const chargeNodeIds: string[] = []
    for (const nodeIndex of group.memberIndexes) {
      const node = nodeList[nodeIndex]
      nodeIds.push(node.id)
      if (node.category === 'charge') {
        chargeNodeIds.push(node.id)
      }
      componentIndexOfNode.set(node.id, index)
    }
    components.push(
      Object.freeze({
        index,
        nodeIds: Object.freeze(nodeIds),
        chargeNodeIds: Object.freeze(chargeNodeIds),
        edgeCount: edgeCountByRoot.get(group.root) ?? 0,
      }),
    )
  })

  return {
    components: Object.freeze(components),
    componentIndexOfNode,
  }
}

/**
 * 由校验后的地图数据构建只读 MapModel 与世界变换。
 * 世界原点取「节点平面包围盒中心经仿射后的点」；由于仿射保持包围盒中心，
 * 该点等价于变换后包围盒的中心（SPEC §2.5 的 originX/originY）。
 */
export function createMapModel(
  data: ValidatedMapData,
  options: CreateMapModelOptions = {},
): CreateMapModelResult {
  const plane = createPlaneTransform(options.coordinateTransform ?? IDENTITY_AFFINE)
  const { nodes, edges } = data

  // 节点平面包围盒中心：顺序无关量，只在此处计算一次（不变量 1）
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    if (node.x < minX) minX = node.x
    if (node.x > maxX) maxX = node.x
    if (node.y < minY) minY = node.y
    if (node.y > maxY) maxY = node.y
  }
  const centerX = Number.isFinite(minX) ? (minX + maxX) / 2 : 0
  const centerY = Number.isFinite(minY) ? (minY + maxY) / 2 : 0
  const origin = plane.transformPoint(centerX, centerY)
  const worldTransform = createWorldTransform(plane, origin)

  const sceneBounds = computeSceneBounds(nodes, (x, y) => worldTransform.toWorldXZ(x, y))

  // 节点/边/分组索引：构建期可变 Map，对外只暴露 ReadonlyMap 视图
  const nodeMap = new Map<string, MapNode>()
  const nodeIndexOfId = new Map<string, number>()
  nodes.forEach((node, index) => {
    nodeMap.set(node.id, node)
    nodeIndexOfId.set(node.id, index)
  })
  const edgeMap = new Map(data.edges.map((edge) => [edge.id, edge] as const))
  const groupMap = new Map(data.groups.map((group) => [group.id, group] as const))

  // 有向出边索引：每个节点都有条目（无出边为空数组），查询方无需判 undefined
  const outEdgeIds = new Map<string, string[]>()
  for (const node of nodes) {
    outEdgeIds.set(node.id, [])
  }
  for (const edge of edges) {
    outEdgeIds.get(edge.snodeId)?.push(edge.id)
  }
  const frozenOutEdgeIds = new Map<string, readonly string[]>()
  for (const [id, list] of outEdgeIds) {
    frozenOutEdgeIds.set(id, Object.freeze(list))
  }

  const { components, componentIndexOfNode } = buildComponents(
    nodes,
    nodeIndexOfId,
    data.edges,
  )

  const mapModel: MapModel = Object.freeze({
    mapId: data.mapId,
    nodeList: data.nodes,
    edgeList: data.edges,
    groupList: data.groups,
    nodes: nodeMap,
    edges: edgeMap,
    groups: groupMap,
    outEdgeIds: frozenOutEdgeIds,
    components,
    componentIndexOfNode,
    sceneBounds,
  })

  return { mapModel, worldTransform }
}
