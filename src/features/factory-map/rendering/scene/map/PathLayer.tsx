/**
 * PathLayer：路径条带与方向箭头（SPEC §7.1、§7.2、§7.5）。
 *
 * 仅挂载 MapSceneResources 装配好的 4 个绘制批次（正向/反向路径带 Mesh、
 * 正向/反向箭头 InstancedMesh）；几何构建见 Worker builders 与
 * scene/map/instanceGeometry.ts，本组件不释放借用的 geometry/material/buffer。
 */

import type { ReactElement } from 'react'

import type { MapSceneSnapshot } from '../../resources/MapSceneResources'

export interface PathLayerProps {
  readonly resources: MapSceneSnapshot
}

export function PathLayer({ resources }: PathLayerProps): ReactElement {
  return (
    <>
      <primitive object={resources.pathForwardMesh} />
      <primitive object={resources.pathBackwardMesh} />
      <primitive object={resources.arrowForwardMesh} />
      <primitive object={resources.arrowBackwardMesh} />
    </>
  )
}
