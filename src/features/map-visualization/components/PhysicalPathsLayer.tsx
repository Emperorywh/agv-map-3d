/**
 * 物理路径图层（SPEC §5.1 物理路径行；实体道路俯视表达）。
 *
 * 职责：把 buildMapGeometry 产出的五份静态合批几何（路面、路肩、路缘、
 *       黄色中心实线、方向箭头）以固定材质上载到场景，共五个 Draw Call。
 * 边界：几何对象由 MapGeometry（地图运行时）拥有并在模型原子替换时释放；
 *       本组件只拥有五个材质，并在卸载或几何更换时释放它们，绝不释放
 *       外部几何。组件不感知去重与路网裁剪逻辑，只消费已构建好的世界坐
 *       标几何。
 * 关键不变量：
 * 1. 几何更换（地图恢复）时：新几何先渲染、旧几何由 useMapVisualization 的
 *    所有权 effect 释放，本组件只同步更换材质引用，不产生中间空档；
 * 2. 路面为 Unlit（MeshBasicMaterial）双面：路面贴花是视觉标记而非受光面，
 *    任意绕序可见且不受灯光影响，色彩稳定；
 * 3. 路肩、路缘、中心实线与箭头均为 Unlit 贴花；高度按道路层次逐级抬升，
 *    颜色不受场景灯光影响，俯视和倾斜近景都能稳定辨识道路边界与行进方向。
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { MapGeometry } from '../scene/buildMapGeometry'
import {
  PATH_DIRECTION_ARROW_BOOST,
  PATH_DIRECTION_ARROW_COLOR,
  PATH_EDGE_BOOST,
  PATH_EDGE_COLOR,
  PATH_EDGE_HALO_COLOR,
  PATH_EDGE_HALO_OPACITY,
  PATH_MARKING_BOOST,
  PATH_MARKING_COLOR,
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
      <primitive object={objects.shoulder} dispose={null} />
      <primitive object={objects.edgeCore} dispose={null} />
      <primitive object={objects.centerLines} dispose={null} />
      <primitive object={objects.directionArrows} dispose={null} />
    </>
  )
}

interface PhysicalPathsLayerProps {
  geometry: MapGeometry
}

interface PathObjects {
  surface: THREE.Mesh
  edgeCore: THREE.Mesh
  shoulder: THREE.Mesh
  centerLines: THREE.Mesh
  directionArrows: THREE.Mesh
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

  /**
   * 路缘浅色压边：双面保证任意绕序可见，固定 renderOrder 使它稳定覆盖
   * 在较宽的混凝土路肩之上。
   */
  const edgeCoreMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PATH_EDGE_COLOR).multiplyScalar(PATH_EDGE_BOOST),
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  const edgeCore = new THREE.Mesh(geometry.pathEdgeCores, edgeCoreMaterial)
  edgeCore.name = 'map-path-edge-core'
  edgeCore.matrixAutoUpdate = false
  edgeCore.renderOrder = 2
  edgeCore.castShadow = false
  edgeCore.receiveShadow = false

  /**
   * 混凝土路肩使用不透明材质，作为沥青与浅色路缘之间的实体过渡，不再采用
   * 加法混合的霓虹晕圈，避免道路边界呈现发光管效果。
   */
  const shoulderMaterial = new THREE.MeshBasicMaterial({
    color: PATH_EDGE_HALO_COLOR,
    opacity: PATH_EDGE_HALO_OPACITY,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  const shoulder = new THREE.Mesh(geometry.pathEdgeHalos, shoulderMaterial)
  shoulder.name = 'map-path-edge-halo'
  shoulder.matrixAutoUpdate = false
  shoulder.renderOrder = 1
  shoulder.castShadow = false
  shoulder.receiveShadow = false

  /**
   * 黄色中心实线负责连接节点；方向箭头改用高对比暖白标线并单独成批，避免
   * 箭头与中心线融合成菱形。箭头略高于中心线，双向标记不会产生深度闪烁。
   */
  const centerLineMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PATH_MARKING_COLOR).multiplyScalar(PATH_MARKING_BOOST),
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  const centerLines = new THREE.Mesh(geometry.pathCenterLines, centerLineMaterial)
  centerLines.name = 'map-path-center-lines'
  centerLines.matrixAutoUpdate = false
  centerLines.renderOrder = 3
  centerLines.castShadow = false
  centerLines.receiveShadow = false

  const directionArrowMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PATH_DIRECTION_ARROW_COLOR).multiplyScalar(
      PATH_DIRECTION_ARROW_BOOST,
    ),
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  const directionArrows = new THREE.Mesh(
    geometry.pathDirectionArrows,
    directionArrowMaterial,
  )
  directionArrows.name = 'map-path-direction-arrows'
  directionArrows.matrixAutoUpdate = false
  directionArrows.renderOrder = 4
  directionArrows.castShadow = false
  directionArrows.receiveShadow = false

  return {
    surface,
    edgeCore,
    shoulder,
    centerLines,
    directionArrows,
    materials: [
      surfaceMaterial,
      edgeCoreMaterial,
      shoulderMaterial,
      centerLineMaterial,
      directionArrowMaterial,
    ],
  }
}

/** 只释放本组件创建的材质；几何归 MapGeometry 所有，不得在此释放 */
function disposePathMaterials(objects: PathObjects): void {
  for (const material of objects.materials) {
    material.dispose()
  }
}
