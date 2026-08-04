/**
 * MapLayer：地图编排层（SPEC §5 场景架构树、§7、§9.3）。
 *
 * 只编排 PathLayer / NodeLayer 两个子层，不包含几何算法与资源生命周期；
 * 快照由 MapSceneResources（唯一 owner）装配，经本组件向下传递。
 * 根 group raycast=()=>false：阻断 R3F 递归拾取（§5.2/§9.3 无拾取约定）；
 * 不注册任何 onClick/onPointerOver/onContextMenu（§9.3）。
 */

import type { ReactElement } from 'react'

import type { MapSceneSnapshot } from '../../resources/MapSceneResources'
import { NodeLayer } from './NodeLayer'
import { PathLayer } from './PathLayer'

/** §5.2/§9.3：根 group raycast 返回 false（three 递归终止语义） */
const noRaycast = (): boolean => false

export interface MapLayerProps {
  /** MapSceneResources.setup 产出的地图快照（7 个绘制批次，§7.5） */
  readonly resources: MapSceneSnapshot
}

export function MapLayer({ resources }: MapLayerProps): ReactElement {
  return (
    <group raycast={noRaycast}>
      <PathLayer resources={resources} />
      <NodeLayer resources={resources} />
    </group>
  )
}
