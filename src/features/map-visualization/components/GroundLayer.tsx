/**
 * 工业地坪图层（SPEC §5.1 地面行；TASK-004）。
 *
 * 职责：按地图世界包围盒加 10m 边距一次生成工业地坪平面与 5m 间隔网格刻线，
 *       以静态 Group 挂入场景；地坪使用 MeshStandardMaterial 接收阴影。
 * 边界：只消费 SceneBounds 纯数据；几何与材质在本组件内创建并在卸载时释放
 *       （R3F 对 primitive 传入的外部对象不做释放，资源所有权归本组件）。
 * 关键不变量：
 * 1. 地坪尺寸 = (包围盒跨度 + 2×边距)，中心对齐包围盒中心，一次生成不重建；
 * 2. bounds 变化（地图原子替换）时 useMemo 重建新对象，旧对象在其 effect
 *    清理中整体释放，任何时刻场景内只有一份地坪。
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { SceneBounds } from '../model/types'
import {
  GROUND_COLOR,
  GROUND_GRID_COLOR,
  GROUND_GRID_SPACING_M,
  GROUND_MARGIN_M,
  GROUND_METALNESS,
  GROUND_ROUGHNESS,
  GROUND_Y,
  GRID_Y,
} from '../scene/mapAppearance'

/** 构建地坪平面 + 网格刻线的静态组合对象 */
function createGroundObject(bounds: SceneBounds): THREE.Group {
  const group = new THREE.Group()
  group.name = 'map-ground'
  group.matrixAutoUpdate = false

  const spanX = bounds.maxWorldX - bounds.minWorldX + GROUND_MARGIN_M * 2
  const spanZ = bounds.maxWorldZ - bounds.minWorldZ + GROUND_MARGIN_M * 2

  const planeGeometry = new THREE.PlaneGeometry(spanX, spanZ)
  // 平面几何默认在 XY 面，旋转到 XZ 地面
  planeGeometry.rotateX(-Math.PI / 2)
  const planeMaterial = new THREE.MeshStandardMaterial({
    color: GROUND_COLOR,
    roughness: GROUND_ROUGHNESS,
    metalness: GROUND_METALNESS,
  })
  const plane = new THREE.Mesh(planeGeometry, planeMaterial)
  plane.position.set(bounds.centerWorldX, GROUND_Y, bounds.centerWorldZ)
  plane.receiveShadow = true
  plane.matrixAutoUpdate = false
  plane.updateMatrix()
  group.add(plane)

  group.add(createGridLines(bounds, spanX, spanZ))

  group.updateMatrix()
  return group
}

/** 网格刻线：覆盖扩展后包围盒、按固定间距的平行线段合批 */
function createGridLines(
  bounds: SceneBounds,
  spanX: number,
  spanZ: number,
): THREE.LineSegments {
  const minX = bounds.centerWorldX - spanX / 2
  const maxX = bounds.centerWorldX + spanX / 2
  const minZ = bounds.centerWorldZ - spanZ / 2
  const maxZ = bounds.centerWorldZ + spanZ / 2
  const positions: number[] = []

  for (let x = Math.ceil(minX / GROUND_GRID_SPACING_M) * GROUND_GRID_SPACING_M; x <= maxX; x += GROUND_GRID_SPACING_M) {
    positions.push(x, GRID_Y, minZ, x, GRID_Y, maxZ)
  }
  for (let z = Math.ceil(minZ / GROUND_GRID_SPACING_M) * GROUND_GRID_SPACING_M; z <= maxZ; z += GROUND_GRID_SPACING_M) {
    positions.push(minX, GRID_Y, z, maxX, GRID_Y, z)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  const material = new THREE.LineBasicMaterial({ color: GROUND_GRID_COLOR })
  const lines = new THREE.LineSegments(geometry, material)
  lines.matrixAutoUpdate = false
  return lines
}

/** 释放地坪组合对象创建的全部 geometry 与材质（不含外部传入资源） */
function disposeGroundObject(group: THREE.Group): void {
  group.traverse((child) => {
    const mesh = child as THREE.Mesh
    mesh.geometry?.dispose()
    const material = (mesh as unknown as { material?: THREE.Material | THREE.Material[] })
      .material
    if (Array.isArray(material)) {
      for (const item of material) {
        item.dispose()
      }
    } else {
      material?.dispose()
    }
  })
}

export function GroundLayer({ bounds }: GroundLayerProps) {
  const group = useMemo(() => createGroundObject(bounds), [bounds])
  useEffect(() => () => disposeGroundObject(group), [group])
  // dispose={null}：对象由本组件显式拥有与释放，禁止 R3F 卸载时二次释放
  return <primitive object={group} dispose={null} />
}

interface GroundLayerProps {
  bounds: SceneBounds
}
