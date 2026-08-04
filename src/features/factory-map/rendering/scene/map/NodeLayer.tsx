/**
 * NodeLayer：节点圆点、站点圆环与站点朝向符号（SPEC §7.3、§7.4、§7.5）。
 *
 * 仅挂载 MapSceneResources 装配好的 3 个 InstancedMesh（圆环/朝向符号经
 * instanceColor 表达 work/charge/park 三色）；本组件不释放借用的
 * geometry/material/buffer。
 */

import type { ReactElement } from 'react'

import type { MapSceneSnapshot } from '../../resources/MapSceneResources'

export interface NodeLayerProps {
  readonly resources: MapSceneSnapshot
}

export function NodeLayer({ resources }: NodeLayerProps): ReactElement {
  return (
    <>
      <primitive object={resources.nodeDotMesh} />
      <primitive object={resources.stationRingMesh} />
      <primitive object={resources.stationDirectionMesh} />
    </>
  )
}
