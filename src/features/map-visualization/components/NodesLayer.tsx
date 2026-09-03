/**
 * 节点实例图层（SPEC §5.1 节点行：一个 InstancedMesh + 实例颜色；TASK-004；
 * P1-5 视觉差距修订：屏幕尺寸 shader LOD；P2-3：几何内环暗描边）。
 *
 * 职责：以唯一一个 InstancedMesh 渲染地图全部节点站点（当前 4,291 个），
 *       实例矩阵与实例颜色来自 buildMapGeometry 的 NodeInstanceData 静态数据，
 *       上载一次后不再逐帧修改。几何为中心盘 + 外圈暗描边环的合并几何
 *       （P2-3：描边经顶点色 × 实例颜色表达，Reference 的「嵌 into 路面」
 *       轮廓）；材质注入屏幕尺寸淡出（P1-5）：投影直径低于阈值的节点盘在
 *       GPU 侧渐隐，总览回归路网骨架、近景不受影响；本组件仅把视口高度
 *       写入材质 uniform（低频真值，非实例缓冲写入）。
 * 边界：实例数据由 MapGeometry 拥有；本组件拥有圆盘截面 geometry、材质与
 *       InstancedMesh 自身的实例属性缓冲，卸载或数据更换时全部显式释放。
 * 关键不变量：
 * 1. 全部节点共用一个 InstancedMesh 与一份材质：颜色差异完全由 instanceColor
 *    表达（work/warehouse/charge/park/unknown），Draw Call 恒为 1；描边色 =
 *    实例色 × 顶点色乘数（不新增 Draw Call、不破坏实例着色管线）；
 * 2. 实例数据是静态的：instanceMatrix/instanceColor 上载一次即标记
 *    StaticDrawUsage，本图层不存在逐帧实例写入路径（LOD 淡出纯 GPU）；
 * 3. count=0 时同样成立（不创建实例缓冲歧义），地图空数据由上层校验拦截。
 */
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { NodeInstanceData } from '../scene/buildMapGeometry'
import { createNodeDiscGeometry } from '../scene/nodeDiscGeometry'
import {
  NODE_FADE_END_PX,
  NODE_FADE_START_PX,
  NODE_RADIUS_M,
} from '../scene/mapAppearance'
import { createNodeLodMaterial, type NodeLodUniforms } from '../scene/semanticMaterials'

export function NodesLayer({ data }: NodesLayerProps) {
  const nodes = useMemo(() => createNodesMesh(data), [data])
  useEffect(() => () => disposeNodesMesh(nodes), [nodes])

  // 视口高度 uniform：真实渲染循环随 resize/首帧写入；测试渲染器无循环时
  // 保持初值 0（节点淡出为 0 尺寸 → discard，不影响任何实例断言）
  const uniformsRef = useRef<NodeLodUniforms>(nodes.uniforms)
  useFrame((state) => {
    uniformsRef.current.uViewportHeightPx.value = state.size?.height ?? 0
  })

  // dispose={null}：mesh 及其资源由本组件显式释放，禁止 R3F 二次释放
  return <primitive object={nodes.mesh} dispose={null} />
}

interface NodesLayerProps {
  data: NodeInstanceData
}

/** 组件自建的 GPU 资源集合：mesh、截面 geometry、材质与 LOD uniforms */
interface NodesResources {
  mesh: THREE.InstancedMesh
  geometry: THREE.BufferGeometry
  material: THREE.Material
  uniforms: NodeLodUniforms
}

/** 创建唯一节点 InstancedMesh：上载一次静态矩阵与颜色 */
function createNodesMesh(data: NodeInstanceData): NodesResources {
  // 盘 + 暗描边内环合并几何（P2-3）；实例颜色经 instanceColor 进着色器，
  // 屏幕尺寸淡出注入见 createNodeLodMaterial
  const geometry = createNodeDiscGeometry()
  const { material, uniforms } = createNodeLodMaterial()
  uniforms.uNodeRadiusM.value = NODE_RADIUS_M
  uniforms.uFadeStartPx.value = NODE_FADE_START_PX
  uniforms.uFadeEndPx.value = NODE_FADE_END_PX
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
  return { mesh, geometry, material, uniforms }
}

/** 释放节点图层全部自建 GPU 资源：截面 geometry、材质与实例属性缓冲 */
function disposeNodesMesh(resources: NodesResources): void {
  resources.mesh.dispose()
  resources.geometry.dispose()
  resources.material.dispose()
}
