/**
 * BuildingEnvelopeLayer：围墙三段（实墙/玻璃/实墙）+ 墙柱分格条（SPEC §6.3）。
 * 仅挂载 FactorySceneResources 装配好的两个 mesh 与一个 InstancedMesh（几何算法
 * 见同目录 buildingGeometry.ts 纯函数模块）；不释放借用的 geometry/material。
 */

import type { ReactElement } from 'react'

import type { FactorySceneSnapshot } from '../../resources/FactorySceneResources'

export interface BuildingEnvelopeLayerProps {
  readonly resources: FactorySceneSnapshot
}

export function BuildingEnvelopeLayer({ resources }: BuildingEnvelopeLayerProps): ReactElement {
  return (
    <>
      <primitive object={resources.solidWallMesh} />
      <primitive object={resources.glassWallMesh} />
      <primitive object={resources.wallColumnMesh} />
    </>
  )
}
