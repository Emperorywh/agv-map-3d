/**
 * 物理路径图层（SPEC §5.1 物理路径行；路网原型复刻：暗色路面 + 发光蓝边 +
 * 黄色方向箭头）。
 *
 * 职责：把 buildMapGeometry 产出的四份静态合批几何（路面条带、蓝边细芯、
 *       蓝边晕圈、方向箭头）以固定材质上载到场景，共四个 Draw Call。
 * 边界：几何对象由 MapGeometry（地图运行时）拥有并在模型原子替换时释放；
 *       本组件只拥有四个材质，并在卸载或几何更换时释放它们，绝不释放
 *       外部几何。组件不感知去重与方向推导逻辑，只消费已构建好的世界坐
 *       标几何。
 * 关键不变量：
 * 1. 几何更换（地图恢复）时：新几何先渲染、旧几何由 useMapVisualization 的
 *    所有权 effect 释放，本组件只同步更换材质引用，不产生中间空档；
 * 2. 路面为 Unlit（MeshBasicMaterial）双面：路面贴花是视觉标记而非受光面，
 *    任意绕序可见且不受灯光影响，色彩稳定；
 * 3. 蓝边的「发光」是两段式贴花而非后处理辉光：细芯颜色乘 BOOST 借 ACES
 *    色调映射肩部过曝出灯管感，晕圈用加法混合宽条带做贴地微光；晕圈不写
 *    深度（transparent + depthWrite=false），细芯与箭头按高度阶梯盖在其上。
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { MapGeometry } from '../scene/buildMapGeometry'
import {
  PATH_ARROW_BOOST,
  PATH_ARROW_COLOR,
  PATH_EDGE_BOOST,
  PATH_EDGE_COLOR,
  PATH_EDGE_HALO_COLOR,
  PATH_EDGE_HALO_OPACITY,
  PATH_SURFACE_COLOR,
} from '../scene/mapAppearance'

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
      <primitive object={objects.edgeHalo} dispose={null} />
      <primitive object={objects.edgeCore} dispose={null} />
      <primitive object={objects.arrows} dispose={null} />
    </>
  )
}

interface PhysicalPathsLayerProps {
  geometry: MapGeometry
}

interface PathObjects {
  surface: THREE.Mesh
  edgeCore: THREE.Mesh
  edgeHalo: THREE.Mesh
  arrows: THREE.Mesh
  materials: THREE.Material[]
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

  // 细芯：颜色乘 BOOST 过曝（ACES 肩部滚降），双面固定绕序可见
  const edgeCoreMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PATH_EDGE_COLOR).multiplyScalar(PATH_EDGE_BOOST),
    side: THREE.DoubleSide,
  })
  const edgeCore = new THREE.Mesh(geometry.pathEdgeCores, edgeCoreMaterial)
  edgeCore.name = 'map-path-edge-core'
  edgeCore.matrixAutoUpdate = false
  edgeCore.castShadow = false
  edgeCore.receiveShadow = false

  // 晕圈：加法混合 + 不写深度，只做亮度叠加，不参与遮挡
  const edgeHaloMaterial = new THREE.MeshBasicMaterial({
    color: PATH_EDGE_HALO_COLOR,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: PATH_EDGE_HALO_OPACITY,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const edgeHalo = new THREE.Mesh(geometry.pathEdgeHalos, edgeHaloMaterial)
  edgeHalo.name = 'map-path-edge-halo'
  edgeHalo.matrixAutoUpdate = false
  edgeHalo.renderOrder = 1
  edgeHalo.castShadow = false
  edgeHalo.receiveShadow = false

  const arrowMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PATH_ARROW_COLOR).multiplyScalar(PATH_ARROW_BOOST),
    side: THREE.DoubleSide,
  })
  const arrows = new THREE.Mesh(geometry.pathArrows, arrowMaterial)
  arrows.name = 'map-path-arrows'
  arrows.matrixAutoUpdate = false
  arrows.castShadow = false
  arrows.receiveShadow = false

  return {
    surface,
    edgeCore,
    edgeHalo,
    arrows,
    materials: [surfaceMaterial, edgeCoreMaterial, edgeHaloMaterial, arrowMaterial],
  }
}

/** 只释放本组件创建的材质；几何归 MapGeometry 所有，不得在此释放 */
function disposePathMaterials(objects: PathObjects): void {
  for (const material of objects.materials) {
    material.dispose()
  }
}
