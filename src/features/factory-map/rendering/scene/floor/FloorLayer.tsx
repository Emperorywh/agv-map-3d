/**
 * FloorLayer：厂房地坪 + 分缝（SPEC §6.2）。
 * 仅挂载 FactorySceneResources 装配好的两个 mesh（几何算法见同目录
 * floorGeometry.ts / floorTexture.ts 纯函数模块）；不释放借用的 geometry/material。
 */

import type { ReactElement } from 'react'

import type { FactorySceneSnapshot } from '../../resources/FactorySceneResources'

export interface FloorLayerProps {
  readonly resources: FactorySceneSnapshot
}

export function FloorLayer({ resources }: FloorLayerProps): ReactElement {
  return (
    <>
      <primitive object={resources.floorMesh} />
      <primitive object={resources.floorJointMesh} />
    </>
  )
}
