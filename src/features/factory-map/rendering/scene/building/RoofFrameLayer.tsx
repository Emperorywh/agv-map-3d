/**
 * RoofFrameLayer：屋顶桁架——主梁 + 檩条（SPEC §6.4，不封顶）。
 * 仅挂载 FactorySceneResources 装配好的两个 InstancedMesh（几何算法见同目录
 * roofFrameGeometry.ts 纯函数模块）；不释放借用的 geometry/material。
 */

import type { ReactElement } from 'react'

import type { FactorySceneSnapshot } from '../../resources/FactorySceneResources'

export interface RoofFrameLayerProps {
  readonly resources: FactorySceneSnapshot
}

export function RoofFrameLayer({ resources }: RoofFrameLayerProps): ReactElement {
  return (
    <>
      <primitive object={resources.roofBeamMesh} />
      <primitive object={resources.roofPurlinMesh} />
    </>
  )
}
