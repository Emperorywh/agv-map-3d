/**
 * 道路图层由低对比路面、连续白边、蓝色真实轨迹与精选路口光点组成。
 * 组件只拥有材质，静态几何由 MapGeometry 在地图替换时统一释放；不再渲染箭头。
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { MapGeometry } from '../scene/buildMapGeometry'
import { ROAD_SURFACE_COLOR, ROAD_SURFACE_OPACITY, ROAD_BOUNDARY_COLOR } from '../scene/mapAppearance'

export function PhysicalPathsLayer({ geometry }: { geometry: MapGeometry }) {
  const objects = useMemo(() => createPathObjects(geometry), [geometry])
  useEffect(() => () => {
    for (const object of objects) object.material.dispose()
  }, [objects])
  return <>{objects.map((object) => <primitive key={object.name} object={object} dispose={null} />)}</>
}

/**
 * 白边使用不受灯光影响的实色贴花；路面和蓝线保持透明且不写深度。
 * 蓝线统一保持清晰，接入线不再降透明度；逐帧不重建道路或遍历路径。
 */
function createPathObjects(geometry: MapGeometry): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] {
  const definitions = [
    { name: 'map-road-surface', geometry: geometry.roadSurface, color: ROAD_SURFACE_COLOR, opacity: ROAD_SURFACE_OPACITY, vertexColors: false },
    { name: 'map-road-boundaries', geometry: geometry.roadBoundaries, color: ROAD_BOUNDARY_COLOR, opacity: 1, vertexColors: false },
    { name: 'map-road-guides', geometry: geometry.roadGuides, color: '#ffffff', opacity: 1, vertexColors: true },
    { name: 'map-road-junction-lights', geometry: geometry.roadJunctionLights, color: '#ffffff', opacity: 1, vertexColors: true },
  ]
  return definitions.map((definition, index) => {
    const material = new THREE.MeshBasicMaterial({
      color: definition.color,
      opacity: definition.opacity,
      vertexColors: definition.vertexColors,
      transparent: definition.opacity < 1 || definition.vertexColors,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    })
    const mesh = new THREE.Mesh(definition.geometry, material)
    mesh.name = definition.name
    mesh.matrixAutoUpdate = false
    mesh.renderOrder = index + 2
    mesh.castShadow = false
    mesh.receiveShadow = false
    return mesh
  })
}
