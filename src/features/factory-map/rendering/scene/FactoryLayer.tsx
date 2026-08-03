/**
 * FactoryLayer：厂房环境编排层（SPEC §5、§6）。
 *
 * 只编排四个环境子层，不包含几何算法；几何/纹理由 rendering/scene 子目录纯函数
 * 模块构建、resources/FactorySceneResources 装配（本组件只接收其快照）。
 * 根 group raycast=()=>false：阻断 R3F 递归拾取（§5.2/§9.3 无拾取约定；
 * 标签遮挡检测直接持有快照 labelOccluders 中的 mesh 引用，不经过该根 group）。
 */

import type { ReactElement } from 'react'

import type { FactorySceneSnapshot } from '../resources/FactorySceneResources'
import { BuildingEnvelopeLayer } from './building/BuildingEnvelopeLayer'
import { RoofFrameLayer } from './building/RoofFrameLayer'
import { ExteriorLayer } from './exterior/ExteriorLayer'
import { FloorLayer } from './floor/FloorLayer'

/** §5.2/§9.3：根 group raycast 返回 false（three 递归终止语义） */
const noRaycast = (): boolean => false

export interface FactoryLayerProps {
  /** FactorySceneResources.setup 产出的环境快照（含 labelOccluders） */
  readonly resources: FactorySceneSnapshot
}

export function FactoryLayer({ resources }: FactoryLayerProps): ReactElement {
  return (
    <group raycast={noRaycast}>
      <FloorLayer resources={resources} />
      <BuildingEnvelopeLayer resources={resources} />
      <RoofFrameLayer resources={resources} />
      <ExteriorLayer resources={resources} />
    </group>
  )
}
