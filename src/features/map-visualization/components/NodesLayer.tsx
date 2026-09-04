/**
 * 节点实例图层（SPEC §5.1 节点行：一个 InstancedMesh + 实例颜色；TASK-004；
 * P1-5 视觉差距修订：屏幕尺寸 shader LOD；P2-8 视觉对齐：多层同心圆台；
 * 视觉对齐 P0-5.4/5.1：实例角色最低可见场景等级门控）。
 *
 * 职责：以唯一一个 InstancedMesh 渲染地图全部节点站点（当前 4,291 个），
 *       实例矩阵、实例颜色与角色最低可见场景等级来自 buildMapGeometry 的
 *       NodeInstanceData 静态数据，上载一次后不再逐帧修改。几何为「暗色底
 *       座 → 状态色实心柱身」的两层圆台（各层亮度经顶点色 × 实例颜色表达，
 *       柱身顶面 >1 借 ACES 过曝提亮）；材质注入两路 GPU 显隐（P1-5）：
 *       投影尺寸淡出 + 场景等级门控（aMinLevel ≤ uSceneLevel 才可见，等级由
 *       SceneDetailController 共享写入）——总览隐藏普通节点与纯导航控制点、
 *       作业区显示工位与交叉节点、近景补齐单个库位标识。材质开启深度写入：
 *       圆台层间/实例间的遮挡由深度测试保证，与绘制顺序无关；淡出残留在
 *       投影 ≤3.5px 的尺寸内不可察。本组件仅把视口高度写入材质 uniform
 *       （低频真值，非实例缓冲写入）。
 * 边界：实例数据由 MapGeometry 拥有；本组件拥有圆台截面 geometry、材质与
 *       InstancedMesh 自身的实例属性缓冲，卸载或数据更换时全部显式释放。
 * 关键不变量：
 * 1. 全部节点共用一个 InstancedMesh 与一份材质：颜色差异完全由 instanceColor
 *    表达（work/warehouse/charge/park/unknown），Draw Call 恒为 1；层间明暗
 *    = 实例色 × 顶点色乘数（不新增 Draw Call、不破坏实例着色管线）；
 * 2. 实例数据是静态的：instanceMatrix/instanceColor/aMinLevel 上载一次即标
 *    记 StaticDrawUsage，本图层不存在逐帧实例写入路径（LOD 与场景等级门控
 *    纯 GPU）；
 * 3. count=0 时同样成立（不创建实例缓冲歧义），地图空数据由上层校验拦截。
 */
import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { NodeInstanceData } from '../scene/buildMapGeometry'
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

  // dispose={null}：mesh 及其资源由本组件显式释放，禁止 R3F 二次释放
  return <primitive object={nodes.mesh} dispose={null} />
}

interface NodesLayerProps {
  data: NodeInstanceData
  /** 场景细节控制器（P0-5.1）；null 时材质使用自建等级 uniform（恒为总览） */
  sceneDetail: SceneDetailController | null
}

/** 组件自建的 GPU 资源集合：mesh、截面 geometry、材质与 LOD uniforms */
interface NodesResources {
  mesh: THREE.InstancedMesh
  geometry: THREE.BufferGeometry
  material: THREE.Material
  uniforms: NodeLodUniforms
}

/** 创建唯一节点 InstancedMesh：上载一次静态矩阵、颜色与角色等级 */
function createNodesMesh(
  data: NodeInstanceData,
  sceneLevelUniform: { value: number } | undefined,
): NodesResources {
  // 实心圆台合并几何（暗色底座 + 状态色柱身）；实例颜色经 instanceColor
  // 进着色器，屏幕尺寸淡出与场景等级门控注入见 createNodeLodMaterial
  const geometry = createNodeStackGeometry()
  const { material, uniforms } = createNodeLodMaterial({
    sceneLevelUniform,
  })
  // 淡出口径取节点整体外径（底座外沿），与可见轮廓的投影尺寸一致
  uniforms.uNodeRadiusM.value = NODE_OUTER_RADIUS_M
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
    const minLevels = new THREE.InstancedBufferAttribute(data.minLevels, 1)
    minLevels.setUsage(THREE.StaticDrawUsage)
    geometry.setAttribute('aMinLevel', minLevels)
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
