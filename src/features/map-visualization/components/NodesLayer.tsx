/**
 * 节点按五种业务类型及未知兜底分批，共享一份材质和场景显隐参数。
 * 每类轮廓与图标合并在一个实例网格中，最多六次绘制，不逐节点创建对象。
 * 原始实例矩阵、颜色、角色等级只上载一次，投影淡出仍完全由 GPU 处理。
 * 本组件统一拥有并释放分组、实例缓冲、各类几何与共享材质。
 */
import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { NodeInstanceData } from '../scene/buildMapGeometry'
import type { NodeCategory } from '../model/types'
import { createNodeStackGeometry } from '../scene/nodeStackGeometry'
import {
  NODE_FADE_END_PX,
  NODE_FADE_START_PX,
  NODE_OUTER_RADIUS_M,
} from '../scene/mapAppearance'
import { createNodeLodMaterial, type NodeLodUniforms } from '../scene/semanticMaterials'
import type { SceneDetailController } from '../scene/sceneDetailController'

export function NodesLayer({ data, sceneDetail }: NodesLayerProps) {
  const nodes = useMemo(
    () => createNodesMesh(data, sceneDetail?.uniforms.uSceneLevel),
    [data, sceneDetail],
  )
  useEffect(() => () => disposeNodesMesh(nodes), [nodes])

  /**
   * 直接更新当前节点资源的视口参数，地图重建后不会继续写入已释放的材质。
   * 每帧只更新一个 uniform，密集节点的实例缩放仍保持静态。
   */
  useFrame((state) => {
    nodes.uniforms.uViewportHeightPx.value = state.size?.height ?? 0
  })

  /**
   * 分组替换时使用新资源标识重挂载，避免沿用已经释放的实例几何。
   * 资源统一由 effect 释放，关闭框架对 primitive 的自动回收。
   */
  return <primitive key={nodes.group.uuid} object={nodes.group} dispose={null} />
}

interface NodesLayerProps {
  data: NodeInstanceData
  /** 场景细节控制器（P0-5.1）；null 时材质使用自建等级 uniform（恒为总览） */
  sceneDetail: SceneDetailController | null
}

/**
 * 每个非空类别独占一份几何和实例缓冲，全部类别共享唯一材质。
 * 空地图只保留空分组，不分配零长度实例属性。
 */
interface NodesResources {
  group: THREE.Group
  meshes: THREE.InstancedMesh[]
  material: THREE.Material
  uniforms: NodeLodUniforms
}

/**
 * 按真实类别分桶，保留每个节点对应的矩阵、颜色和原有最低场景等级。
 * 分桶只发生在地图构建或资源重建时，不改变业务节点顺序和道路拓扑。
 */
function createNodesMesh(
  data: NodeInstanceData,
  sceneLevelUniform: { value: number } | undefined,
): NodesResources {
  const group = new THREE.Group()
  group.name = 'map-nodes'
  group.matrixAutoUpdate = false
  const meshes: THREE.InstancedMesh[] = []
  const buckets = new Map<NodeCategory, number[]>()
  for (let i = 0; i < data.count; i += 1) {
    const category = data.categories[i]
    const bucket = buckets.get(category)
    if (bucket === undefined) buckets.set(category, [i])
    else bucket.push(i)
  }
  const { material, uniforms } = createNodeLodMaterial({
    sceneLevelUniform,
  })
  // 淡出口径取节点整体外径（底座外沿），与可见轮廓的投影尺寸一致
  uniforms.uNodeRadiusM.value = NODE_OUTER_RADIUS_M
  uniforms.uFadeStartPx.value = NODE_FADE_START_PX
  uniforms.uFadeEndPx.value = NODE_FADE_END_PX
  for (const [category, indices] of buckets) {
    const geometry = createNodeStackGeometry(category)
    const mesh = new THREE.InstancedMesh(geometry, material, indices.length)
    mesh.name = `map-nodes-${category}`
    const colors = new Float32Array(indices.length * 3)
    const levels = new Float32Array(indices.length)
    for (let i = 0; i < indices.length; i += 1) {
      const source = indices[i]
      mesh.instanceMatrix.array.set(data.matrices.subarray(source * 16, source * 16 + 16), i * 16)
      colors.set(data.colors.subarray(source * 3, source * 3 + 3), i * 3)
      levels[i] = data.minLevels[source]
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    const instanceColor = new THREE.InstancedBufferAttribute(colors, 3)
    instanceColor.setUsage(THREE.StaticDrawUsage)
    mesh.instanceColor = instanceColor
    const minLevels = new THREE.InstancedBufferAttribute(levels, 1)
    minLevels.setUsage(THREE.StaticDrawUsage)
    geometry.setAttribute('aMinLevel', minLevels)
    mesh.computeBoundingSphere()
    mesh.matrixAutoUpdate = false
    mesh.castShadow = false
    mesh.receiveShadow = false
    meshes.push(mesh)
    group.add(mesh)
  }
  return { group, meshes, material, uniforms }
}

/**
 * 各批次分别释放实例与几何，共享材质仅释放一次。
 * 不回收输入数据，地图模型和原始节点数组仍由上层拥有。
 */
function disposeNodesMesh(resources: NodesResources): void {
  for (const mesh of resources.meshes) {
    mesh.dispose()
    mesh.geometry.dispose()
  }
  resources.material.dispose()
}
