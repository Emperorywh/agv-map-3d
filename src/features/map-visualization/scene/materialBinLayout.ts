/**
 * 每个 warehouse 节点对应一个货架，长边垂直于该站点接入路径的局部方向。
 * 坐标与路径方向统一经过地图世界变换，不修改节点数据或导航拓扑。
 */
import type { WorldTransform } from '@/shared/spatial'
import type { MapEdge, MapModel } from '../model/types'

/**
 * 以指定路径的连通区域切换库位模型，其他库位继续使用托盘货物。
 * 类型仅描述静态外观，不改变业务节点、车辆载荷或调度拓扑。
 */
export type MaterialBinVariant = 'pallet' | 'rack'
/**
 * 地图校验后的逻辑边不保留显示名称，因此使用原始地图中核对过的稳定路径标识。
 * 两个标识依次对应路径 9014、9015，区域范围仍由实时地图的连通关系决定。
 */
const RACK_ACCESS_PATH_IDS: ReadonlySet<string> = new Set(['PesO7xdZS4TjPHOxpMKXTMQH39kLNyQV', 'ExjrKBZW9Pksi67Jyw1wKvw87LiatiwF'])

export interface MaterialBinPlacement {
  readonly nodeId: string
  readonly variant: MaterialBinVariant
  readonly x: number
  readonly z: number
  readonly rotation: number
}

export function buildMaterialBinLayout(mapModel: MapModel, worldTransform: WorldTransform): MaterialBinPlacement[] {
  const nodes = mapModel.nodeList.filter((node) => node.category === 'warehouse')
  const incidents = new Map(nodes.map((node) => [node.id, [] as MapEdge[]]))
  /**
   * 复用地图已有的弱连通分量索引，不按截图坐标或不稳定的分量编号硬编码区域。
   * 只从指定路径的实际端点收集分量；路径不存在时不替换任何库位。
   */
  const rackComponents = new Set<number>()
  /**
   * 同时收集入边和出边，单向接入也能定位货架，避免仅依赖为空的站点角度。
   * 全图只扫描一次逻辑边，正反向边在同一端点得到相同的朝外切向。
   */
  for (const edge of mapModel.edgeList) {
    if (RACK_ACCESS_PATH_IDS.has(edge.id)) {
      for (const nodeId of [edge.snodeId, edge.enodeId]) {
        const component = mapModel.componentIndexOfNode.get(nodeId)
        if (component !== undefined) rackComponents.add(component)
      }
    }
    incidents.get(edge.snodeId)?.push(edge)
    if (edge.enodeId !== edge.snodeId) incidents.get(edge.enodeId)?.push(edge)
  }
  return nodes.map((node) => {
    const edges = incidents.get(node.id)!
    /**
     * 多条连接优先选择直线和较短接入段，同等条件按边标识稳定选择。
     * 不平均相反方向的向量，避免双向道路抵消后错误回退到全图固定朝向。
     */
    edges.sort((a, b) => Number(a.edgeType !== 'LINE') - Number(b.edgeType !== 'LINE') || a.length - b.length || a.id.localeCompare(b.id))
    let rotation = worldTransform.angleToWorldYRotation(node.angle ?? 0) + Math.PI / 2
    for (const edge of edges) {
      const direction = getAccessDirection(edge, edge.snodeId === node.id, worldTransform)
      if (direction === null) continue
      /**
       * 原始模型长边沿本地横轴，正面沿本地正纵轴；将正面指向接入路径即可保持垂直。
       * 直接使用变换后的世界切向，地图旋转或镜像时仍与可见路径保持同一方向。
       */
      rotation = Math.atan2(direction.x, direction.z)
      break
    }
    /**
     * 模型分类随库位布局一次性派生，原有坐标和接入路径朝向保持一致。
     * 未归入目标连通分量的站点始终保留原来的托盘模型。
     */
    const component = mapModel.componentIndexOfNode.get(node.id)
    const variant: MaterialBinVariant = component !== undefined && rackComponents.has(component) ? 'rack' : 'pallet'
    return { nodeId: node.id, variant, ...worldTransform.toWorldXZ(node.x, node.y), rotation }
  })
}

/**
 * 直线使用端点连线，曲线使用站点处朝向路径内部的端点切线，不使用整条曲线的弦线。
 * 控制点与端点重合时依次寻找下一控制点和对端；完全退化时才回退到站点角度。
 */
function getAccessDirection(edge: MapEdge, atStart: boolean, worldTransform: WorldTransform) {
  const start = [edge.sx, edge.sy]
  const end = [edge.ex, edge.ey]
  const origin = atStart ? start : end
  const points = edge.edgeType === 'LINE'
    ? [atStart ? end : start]
    : atStart ? [[edge.cx!, edge.cy!], [edge.dx!, edge.dy!], end] : [[edge.dx!, edge.dy!], [edge.cx!, edge.cy!], start]
  const from = worldTransform.toWorldXZ(origin[0], origin[1])
  for (const point of points) {
    const to = worldTransform.toWorldXZ(point[0], point[1])
    const direction = { x: to.x - from.x, z: to.z - from.z }
    if (Math.hypot(direction.x, direction.z) > 1e-6) return direction
  }
  return null
}
