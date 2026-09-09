/**
 * 全部节点共用圆核、细环、光晕与拾取实例，位置只来自正式世界坐标变换。
 * 各层按节点类型着色，悬停与选中只增强轮廓亮度；标签仅显示当前关注节点。
 */
import { useEffect, useMemo, useState } from 'react'
import { Html } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import type { MapModel } from '../model/types'
import type { WorldTransform } from '@/shared/spatial'
import { NAVIGATION_STYLE as S } from '../scene/navigationAppearance'
import { NODE_COLORS } from '../scene/mapAppearance'
import { useNavigationState } from '../model/navigationState'

export function NavigationNodesLayer({ mapModel, worldTransform }: { mapModel: MapModel; worldTransform: WorldTransform }) {
  const group = useMemo(() => new THREE.Group(), [])
  const [hovered, setHovered] = useState<number | null>(null)
  const selected = useNavigationState((state) => state.selectedNode)
  const [meshes, setMeshes] = useState<THREE.InstancedMesh[]>([])
  useEffect(() => {
    const circle = new THREE.CircleGeometry(S.nodeCore, 24).rotateX(-Math.PI / 2)
    const ring = new THREE.RingGeometry(S.nodeRadius - S.nodeRingWidth, S.nodeRadius, 40).rotateX(-Math.PI / 2)
    const halo = new THREE.PlaneGeometry(S.nodeHalo * 2, S.nodeHalo * 2).rotateX(-Math.PI / 2)
    const pick = new THREE.CircleGeometry(S.nodeRadius * 1.5, 20).rotateX(-Math.PI / 2)
    const definitions = [circle, ring, halo, pick]
    const matrix = new THREE.Matrix4()
    const objects = definitions.map((geometry, layer) => {
      /**
       * 圆核和细环使用普通混合，避免叠加地坪底色后把不同类型的颜色冲淡。
       * 光晕继续采用加法混合，在节点周围保留同色的柔和发光。
       */
      const material = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, opacity: layer === 1 ? 0.65 : layer === 2 ? 0.14 : 1, blending: layer === 2 ? THREE.AdditiveBlending : THREE.NormalBlending, colorWrite: layer !== 3 })
      if (layer === 2) {
        /**
         * 径向高斯在同一共享材质内计算，边界平滑归零。
         * 光晕仅为地面色斑，不创建每节点灯光，也不参与反射采集。
         */
        material.onBeforeCompile = (shader) => {
          shader.vertexShader = `varying vec2 nodeUv;\n${shader.vertexShader}`.replace('#include <uv_vertex>', '#include <uv_vertex>\nnodeUv = uv;')
          shader.fragmentShader = `varying vec2 nodeUv;\n${shader.fragmentShader}`.replace('#include <opaque_fragment>', 'float radius = length(nodeUv - 0.5) * 2.0;\ndiffuseColor.a *= exp(-radius * radius * 7.0) * (1.0 - smoothstep(0.7, 1.0, radius));\n#include <opaque_fragment>')
        }
        material.customProgramCacheKey = () => 'navigation-node-halo-v1'
      }
      const mesh = new THREE.InstancedMesh(geometry, material, mapModel.nodeList.length)
      mesh.name = `navigation-node-${['core', 'ring', 'halo', 'pick'][layer]}`
      mesh.renderOrder = 5 + layer
      mapModel.nodeList.forEach((node, index) => {
        const p = worldTransform.toWorldXZ(node.x, node.y)
        matrix.makeTranslation(p.x, S.nodeY + (layer === 2 ? -0.008 : layer * 0.002), p.z)
        mesh.setMatrixAt(index, matrix)
        /**
         * category 由原始 type 直接归一化，已知类型一一对应，未知类型走颜色表兜底。
         * 初始化和资源重建都读取同一颜色表，避免先显示统一蓝色再切换类型色。
         */
        mesh.setColorAt(index, new THREE.Color(NODE_COLORS[node.category]).multiplyScalar(layer === 0 ? 1 : 0.75))
      })
      mesh.computeBoundingSphere()
      if (layer !== 3) mesh.raycast = () => {}
      group.add(mesh)
      return mesh
    })
    setMeshes(objects)
    return () => {
      group.clear()
      for (const mesh of objects) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); mesh.dispose() }
    }
  }, [group, mapModel, worldTransform])
  useEffect(() => {
    const color = new THREE.Color()
    for (let index = 0; index < mapModel.nodeList.length; index += 1) {
      const node = mapModel.nodeList[index]
      const active = node.id === selected
      for (let layer = 0; layer < meshes.length; layer += 1) {
        /**
         * 悬停和选中只提升细环与光晕的强度，圆核始终保留对应业务类型的基色。
         * 取消交互后恢复默认亮度，不用统一白色或琥珀色覆盖站点分类。
         */
        color.set(NODE_COLORS[node.category]).multiplyScalar(layer === 0 ? 1 : active ? 1.6 : hovered === index ? 1.15 : 0.75)
        meshes[layer].setColorAt(index, color)
      }
    }
    for (const mesh of meshes) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [meshes, hovered, selected, mapModel])
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') useNavigationState.getState().selectNode(null) }
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('keydown', key); document.body.style.cursor = '' }
  }, [])
  const focus = hovered !== null ? mapModel.nodeList[hovered] : selected ? mapModel.nodes.get(selected) : null
  const p = focus ? worldTransform.toWorldXZ(focus.x, focus.y) : null
  const over = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation()
    setHovered(event.instanceId ?? null)
    document.body.style.cursor = 'pointer'
  }
  return <>
    <primitive object={group} dispose={null} onPointerMove={over} onPointerOut={() => { setHovered(null); document.body.style.cursor = '' }} onClick={(event: ThreeEvent<MouseEvent>) => {
      if (event.delta > 4 || event.instanceId === undefined) return
      event.stopPropagation()
      const id = mapModel.nodeList[event.instanceId].id
      useNavigationState.getState().selectNode(selected === id ? null : id)
    }} />
    {focus && p ? <Html position={[p.x, 0.35, p.z]} center style={{ pointerEvents: 'none', whiteSpace: 'nowrap', color: '#dcf6ff', background: '#16222de8', border: '1px solid #6acfff66', padding: '4px 8px', borderRadius: 3, fontSize: 12 }}>{focus.name}</Html> : null}
  </>
}
