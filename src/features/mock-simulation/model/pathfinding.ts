/**
 * Mock 有向寻路（SPEC §9.2；TASK-008）。
 *
 * 职责：在只读 MapModel 的有向逻辑边图上执行 Dijkstra 最短路径——普通点到
 *       点寻路（findDirectedPath）与「当前节点到本分量最近 charge 节点」
 *       的多目标查询（findNearestChargePath），供内核低电量寻充与 TASK-009
 *       场景脚本复用。
 * 边界：纯图算法——只消费 MapModel 公开只读索引（nodes/outEdgeIds/components/
 *       componentIndexOfNode），不修改地图、不缓存跨调用状态；不判断电量或
 *       业务语义（那是内核的职责）。
 * 关键不变量：
 * 1. 严格有向：只沿 outEdgeIds（snodeId → enodeId）扩展，绝不借道反向边，
 *   「单向不可达」是合法结果而非错误；
 * 2. 代价规则唯一：edge.cost 为正有限值时用代价，否则回退物理长度
 *   （SPEC §9.2：cost 非有限或非正时使用物理长度）；两者都不可用时该边
 *   视为不可通行（纵深防御，当前地图由 TASK-003 保证长度恒为正有限值）；
 * 3. 可达性蕴含同分量：有向路径永远不会跨出起点的弱连通分量，因此最近
 *   充电查询天然满足「不传送到其他分量」；
 * 4. 结果确定：堆内相同距离按插入序决胜，tie-break 与节点遍历顺序一起保证
 *   同一地图同一查询得到逐边一致的结果。
 */
import type { MapEdge, MapModel } from '@/features/map-visualization'
import { isFiniteNumber } from '@/shared/validation'

/** 单条寻路结果：目标节点、按序经过的有向边序列与总代价 */
export interface MockPathResult {
  readonly goalNodeId: string
  /** 从起点出发按序乘用的有向边 ID；起点即目标时为空数组 */
  readonly edgeIds: readonly string[]
  readonly totalCost: number
}

/** 计算一条有向边的寻路代价；边不可通行时返回 null */
function resolveEdgeCost(edge: MapEdge): number | null {
  // 业务代价有效（正有限）时优先使用
  if (isFiniteNumber(edge.cost) && edge.cost > 0) {
    return edge.cost
  }
  // 代价缺失或非法：回退物理长度（LINE 直线 / BEZIER 24 段折线，TASK-003）
  if (isFiniteNumber(edge.length) && edge.length > 0) {
    return edge.length
  }
  return null
}

/** 最小堆元素：节点距离 + 插入序（相同距离按插入序决胜，保证结果确定） */
interface HeapEntry {
  nodeId: string
  distance: number
  order: number
}

/** 二叉最小堆：按 (distance, order) 取最小，push/pop 均为 O(log n) */
class MinHeap {
  private readonly items: HeapEntry[] = []

  push(entry: HeapEntry): void {
    this.items.push(entry)
    let i = this.items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.less(i, parent)) {
        this.swap(i, parent)
        i = parent
      } else {
        break
      }
    }
  }

  pop(): HeapEntry | undefined {
    const top = this.items[0]
    const last = this.items.pop()
    if (this.items.length > 0 && last) {
      this.items[0] = last
      let i = 0
      for (;;) {
        const left = i * 2 + 1
        const right = left + 1
        let smallest = i
        if (left < this.items.length && this.less(left, smallest)) {
          smallest = left
        }
        if (right < this.items.length && this.less(right, smallest)) {
          smallest = right
        }
        if (smallest === i) {
          break
        }
        this.swap(i, smallest)
        i = smallest
      }
    }
    return top
  }

  get size(): number {
    return this.items.length
  }

  private less(a: number, b: number): boolean {
    const x = this.items[a]
    const y = this.items[b]
    return x.distance < y.distance || (x.distance === y.distance && x.order < y.order)
  }

  private swap(a: number, b: number): void {
    const t = this.items[a]
    this.items[a] = this.items[b]
    this.items[b] = t
  }
}

/** Dijkstra 运行中的节点记录：最优距离 + 前驱边（重建路径用） */
interface NodeRecord {
  distance: number
  prevEdgeId: string | null
  prevNodeId: string | null
  settled: boolean
}

/**
 * 从 startNodeId 出发的有向 Dijkstra 骨架：isGoal 在节点出堆（即取得最终
 * 最短距离）时裁决是否提前结束。返回已结算记录表，由调用方重建路径。
 */
function runDijkstra(
  mapModel: MapModel,
  startNodeId: string,
  isGoal: (nodeId: string) => boolean,
): Map<string, NodeRecord> | null {
  if (!mapModel.nodes.has(startNodeId)) {
    return null
  }
  const records = new Map<string, NodeRecord>()
  const heap = new MinHeap()
  let order = 0
  records.set(startNodeId, {
    distance: 0,
    prevEdgeId: null,
    prevNodeId: null,
    settled: false,
  })
  heap.push({ nodeId: startNodeId, distance: 0, order: order++ })

  while (heap.size > 0) {
    const current = heap.pop()
    if (!current) {
      break
    }
    const record = records.get(current.nodeId)
    // 堆中可能存在同一节点的过期更差条目：只处理仍有效的出堆
    if (!record || record.settled || current.distance > record.distance) {
      continue
    }
    record.settled = true
    if (isGoal(current.nodeId)) {
      return records
    }
    const outEdgeIds = mapModel.outEdgeIds.get(current.nodeId) ?? []
    for (const edgeId of outEdgeIds) {
      const edge = mapModel.edges.get(edgeId)
      if (!edge) {
        continue
      }
      const cost = resolveEdgeCost(edge)
      if (cost === null) {
        continue
      }
      const nextDistance = record.distance + cost
      const nextId = edge.enodeId
      const nextRecord = records.get(nextId)
      if (!nextRecord) {
        records.set(nextId, {
          distance: nextDistance,
          prevEdgeId: edge.id,
          prevNodeId: current.nodeId,
          settled: false,
        })
        heap.push({ nodeId: nextId, distance: nextDistance, order: order++ })
      } else if (!nextRecord.settled && nextDistance < nextRecord.distance) {
        // 松弛：覆盖前驱并以更优距离重复入堆（惰性删除模式）
        nextRecord.distance = nextDistance
        nextRecord.prevEdgeId = edge.id
        nextRecord.prevNodeId = current.nodeId
        heap.push({ nodeId: nextId, distance: nextDistance, order: order++ })
      }
    }
  }
  return records
}

/** 沿前驱边链从记录表重建起点→goal 的边序列 */
function reconstructPath(
  records: Map<string, NodeRecord>,
  startNodeId: string,
  goalNodeId: string,
): MockPathResult {
  const edgeIds: string[] = []
  let cursor = goalNodeId
  while (cursor !== startNodeId) {
    const record = records.get(cursor)
    if (!record || record.prevEdgeId === null || record.prevNodeId === null) {
      break
    }
    edgeIds.push(record.prevEdgeId)
    cursor = record.prevNodeId
  }
  edgeIds.reverse()
  const goal = records.get(goalNodeId)
  return {
    goalNodeId,
    edgeIds,
    totalCost: goal ? goal.distance : 0,
  }
}

/**
 * 点到点有向最短路径。起点即目标时返回空路径（代价 0）；
 * 目标不可达（含跨分量、方向不可达、起点不存在）时返回 null。
 */
export function findDirectedPath(
  mapModel: MapModel,
  startNodeId: string,
  goalNodeId: string,
): MockPathResult | null {
  if (!mapModel.nodes.has(startNodeId) || !mapModel.nodes.has(goalNodeId)) {
    return null
  }
  if (startNodeId === goalNodeId) {
    return { goalNodeId, edgeIds: [], totalCost: 0 }
  }
  const records = runDijkstra(mapModel, startNodeId, (nodeId) => nodeId === goalNodeId)
  if (!records) {
    return null
  }
  const goal = records.get(goalNodeId)
  if (!goal || !goal.settled) {
    return null
  }
  return reconstructPath(records, startNodeId, goalNodeId)
}

/**
 * 本分量最近充电路径：从 startNodeId 做一次 Dijkstra，任一本分量 charge
 * 节点取得最终最短距离时立即结算返回（多目标早停）。找不到可达 charge
 * （本分量无充电站或方向不可达）时返回 null——内核将据此安全停车并产生
 * Mock 数据告警，绝不跨分量传送（SPEC §9.2）。
 */
export function findNearestChargePath(
  mapModel: MapModel,
  startNodeId: string,
  componentIndex: number,
): MockPathResult | null {
  const component = mapModel.components[componentIndex]
  if (!component || component.chargeNodeIds.length === 0) {
    return null
  }
  const chargeIds = new Set<string>(component.chargeNodeIds)
  const records = runDijkstra(mapModel, startNodeId, (nodeId) => chargeIds.has(nodeId))
  if (!records) {
    return null
  }
  // 多目标早停只结算了最近的一个 charge；遍历找出那个已结算的目标
  let best: { nodeId: string; distance: number } | null = null
  for (const chargeId of chargeIds) {
    const record = records.get(chargeId)
    if (record && record.settled) {
      if (best === null || record.distance < best.distance) {
        best = { nodeId: chargeId, distance: record.distance }
      }
    }
  }
  if (!best) {
    return null
  }
  return reconstructPath(records, startNodeId, best.nodeId)
}
