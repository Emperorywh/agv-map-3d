/**
 * 物理路径图层（SPEC §5.1 物理路径行；TASK-004）。
 *
 * 职责：把 buildMapGeometry 产出的静态合批几何（路面条带 + 中线）以固定材质
 *       上载到场景，共两个 Draw Call：路面 Mesh 与中线 LineSegments。
 * 边界：几何对象由 MapGeometry（地图运行时）拥有并在模型原子替换时释放；
 *       本组件只拥有两个材质，并在卸载或几何更换时释放它们，绝不释放
 *       外部几何。组件不感知去重逻辑，只消费已构建好的世界坐标几何。
 * 关键不变量：
 * 1. 几何更换（地图恢复）时：新几何先渲染、旧几何由 useMapVisualization 的
 *    所有权 effect 释放，本组件只同步更换材质引用，不产生中间空档；
 * 2. 材质为 Unlit（MeshBasicMaterial/LineBasicMaterial）双面：路面贴花是
 *    视觉标记而非受光面，任意绕序可见且不受灯光影响，色彩稳定。
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { MapGeometry } from '../scene/buildMapGeometry'
import { PATH_CENTERLINE_COLOR, PATH_SURFACE_COLOR } from '../scene/mapAppearance'

export function PhysicalPathsLayer({ geometry }: PhysicalPathsLayerProps) {
  const objects = useMemo(
    () => createPathObjects(geometry),
    [geometry],
  )
  useEffect(() => () => disposePathMaterials(objects), [objects])
  return (
    <>
      {/* dispose={null}：几何由 MapGeometry 拥有，材质由本组件 effect 释放 */}
      <primitive object={objects.surface} dispose={null} />
      <primitive object={objects.centerline} dispose={null} />
    </>
  )
}

interface PhysicalPathsLayerProps {
  geometry: MapGeometry
}

interface PathObjects {
  surface: THREE.Mesh
  centerline: THREE.LineSegments
  surfaceMaterial: THREE.Material
  centerlineMaterial: THREE.Material
}

function createPathObjects(geometry: MapGeometry): PathObjects {
  const surfaceMaterial = new THREE.MeshBasicMaterial({
    color: PATH_SURFACE_COLOR,
    side: THREE.DoubleSide,
  })
  const surface = new THREE.Mesh(geometry.pathsSurface, surfaceMaterial)
  surface.name = 'map-path-surface'
  surface.matrixAutoUpdate = false
  surface.castShadow = false
  surface.receiveShadow = false

  const centerlineMaterial = new THREE.LineBasicMaterial({ color: PATH_CENTERLINE_COLOR })
  const centerline = new THREE.LineSegments(geometry.pathsCenterline, centerlineMaterial)
  centerline.name = 'map-path-centerline'
  centerline.matrixAutoUpdate = false

  return { surface, centerline, surfaceMaterial, centerlineMaterial }
}

/** 只释放本组件创建的材质；几何归 MapGeometry 所有，不得在此释放 */
function disposePathMaterials(objects: PathObjects): void {
  objects.surfaceMaterial.dispose()
  objects.centerlineMaterial.dispose()
}
