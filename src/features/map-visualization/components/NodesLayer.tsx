/**
 * 节点实例图层（SPEC §5.1 节点行：一个 InstancedMesh + 实例颜色；TASK-004）。
 *
 * 职责：以唯一一个 InstancedMesh 渲染地图全部节点站点（当前 4,291 个），
 *       实例矩阵与实例颜色来自 buildMapGeometry 的 NodeInstanceData 静态数据，
 *       上载一次后不再逐帧修改。
 * 边界：实例数据由 MapGeometry 拥有；本组件拥有圆形截面 geometry、材质与
 *       InstancedMesh 自身的实例属性缓冲，卸载或数据更换时全部显式释放。
 * 关键不变量：
 * 1. 全部节点共用一个 InstancedMesh 与一份材质：颜色差异完全由 instanceColor
 *    表达（work/warehouse/charge/park/unknown），Draw Call 恒为 1；
 * 2. 实例数据是静态的：instanceMatrix/instanceColor 上载一次即标记
 *    StaticDrawUsage，本图层不存在逐帧写入路径；
 * 3. count=0 时同样成立（不创建实例缓冲歧义），地图空数据由上层校验拦截。
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { NodeInstanceData } from '../scene/buildMapGeometry'
import { NODE_CIRCLE_SEGMENTS, NODE_RADIUS_M } from '../scene/mapAppearance'

export function NodesLayer({ data }: NodesLayerProps) {
  const nodes = useMemo(() => createNodesMesh(data), [data])
  useEffect(() => () => disposeNodesMesh(nodes), [nodes])
  // dispose={null}：mesh 及其资源由本组件显式释放，禁止 R3F 二次释放
  return <primitive object={nodes.mesh} dispose={null} />
}

interface NodesLayerProps {
  data: NodeInstanceData
}

/** 组件自建的 GPU 资源集合：mesh、截面 geometry 与材质各自持有释放责任 */
interface NodesResources {
  mesh: THREE.InstancedMesh
  geometry: THREE.BufferGeometry
  material: THREE.Material
}

/** 创建唯一节点 InstancedMesh：上载一次静态矩阵与颜色 */
function createNodesMesh(data: NodeInstanceData): NodesResources {
  const geometry = new THREE.CircleGeometry(NODE_RADIUS_M, NODE_CIRCLE_SEGMENTS)
  geometry.rotateX(-Math.PI / 2)

  // 实例颜色经 instanceColor 进着色器；基础材质保证色彩不受灯光干扰
  const material = new THREE.MeshBasicMaterial()
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(data.count, 0))
  mesh.name = 'map-nodes'
  mesh.count = data.count

  if (data.count > 0) {
    mesh.instanceMatrix.array.set(data.matrices)
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    const instanceColor = new THREE.InstancedBufferAttribute(data.colors, 3)
    instanceColor.setUsage(THREE.StaticDrawUsage)
    mesh.instanceColor = instanceColor
    mesh.computeBoundingSphere()
  }

  mesh.matrixAutoUpdate = false
  mesh.castShadow = false
  mesh.receiveShadow = false
  return { mesh, geometry, material }
}

/** 释放节点图层全部自建 GPU 资源：截面 geometry、材质与实例属性缓冲 */
function disposeNodesMesh(resources: NodesResources): void {
  resources.mesh.dispose()
  resources.geometry.dispose()
  resources.material.dispose()
}
