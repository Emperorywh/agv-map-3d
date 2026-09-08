/**
 * 料箱位置只来源于库区站点，每个 warehouse 节点对应一个料箱。
 * 坐标和朝向统一经过地图世界变换，不修改节点数据或导航拓扑。
 */
import type { WorldTransform } from '@/shared/spatial'
import type { MapModel } from '../model/types'

export interface MaterialBinPlacement {
  readonly nodeId: string
  readonly x: number
  readonly z: number
  readonly rotation: number
}

export function buildMaterialBinLayout(mapModel: MapModel, worldTransform: WorldTransform): MaterialBinPlacement[] {
  return mapModel.nodeList.filter((node) => node.category === 'warehouse').map((node) => ({
    nodeId: node.id,
    ...worldTransform.toWorldXZ(node.x, node.y),
    rotation: worldTransform.angleToWorldYRotation(node.angle ?? 0),
  }))
}
