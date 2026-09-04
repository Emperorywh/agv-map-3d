/**
 * 物理路径图层（SPEC §5.1 物理路径行；道路标线表达）。
 *
 * 职责：把 buildMapGeometry 产出的两份静态合批几何（黄色中心实线、方向
 *       箭头）以固定材质上载到场景，共两个 Draw Call。
 * 边界：几何对象由 MapGeometry（地图运行时）拥有并在模型原子替换时释放；
 *       本组件只拥有两个材质，并在卸载或几何更换时释放它们，绝不释放
 *       外部几何。组件不感知去重与路网裁剪逻辑，只消费已构建好的世界坐
 *       标几何。道路不绘制路面与两侧边界，只以标线表达。
 * 关键不变量：
 * 1. 几何更换（地图恢复）时：新几何先渲染、旧几何由 useMapVisualization 的
 *    所有权 effect 释放，本组件只同步更换材质引用，不产生中间空档；
 * 2. 中心实线与箭头均为 Unlit 贴花；高度按道路层次逐级抬升，颜色不受场景
 *    灯光影响，俯视和倾斜近景都能稳定辨识行进方向。
 */
import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { MapGeometry } from '../scene/buildMapGeometry'
import { createPathArrowMaterial } from '../scene/pathArrowMaterial'
import {
  PATH_MARKING_BOOST,
  PATH_MARKING_COLOR,
} from '../scene/mapAppearance'

export function PhysicalPathsLayer({ geometry }: PhysicalPathsLayerProps) {
  const objects = useMemo(
    () => createPathObjects(geometry),
    [geometry],
  )
  useEffect(() => () => disposePathMaterials(objects), [objects])
  /**
   * GPU 用当前 CSS 视口计算箭头投影尺寸，避免高 DPR 改变细节显隐阈值。
   * 相机推拉和窗口变化只更新这两个数值，不重建或遍历路径几何。
   */
  useFrame((state) => {
    objects.arrowViewport.set(state.size.width, state.size.height)
  })
  return (
    <>
      {/* dispose={null}：几何由 MapGeometry 拥有，材质由本组件 effect 释放 */}
      <primitive object={objects.centerLines} dispose={null} />
      <primitive object={objects.directionArrows} dispose={null} />
    </>
  )
}

interface PhysicalPathsLayerProps {
  geometry: MapGeometry
}

interface PathObjects {
  centerLines: THREE.Mesh
  directionArrows: THREE.Mesh
  arrowViewport: THREE.Vector2
  materials: THREE.Material[]
}

function createPathObjects(geometry: MapGeometry): PathObjects {
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

  /**
   * 箭头复用一份可淡出的基础材质，远景隐藏低于可读像素尺寸的标记；颜色由
   * 几何的逐顶点色承载（默认暖白，isBackEdge=true 红色）。
   * 静态批次与资源释放方式不变，中心线仍持续表达全部路径连接。
   */
  const { material: directionArrowMaterial, viewport: arrowViewport } = createPathArrowMaterial()
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
    centerLines,
    directionArrows,
    arrowViewport,
    materials: [
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
