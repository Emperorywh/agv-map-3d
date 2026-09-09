/**
 * 石墨灰模块墙、金属包边和圆弧矮墙全部使用基础几何生成。
 * 同材质重复部件实例化，近侧上墙沿用原有相机剖切机制保证路网可见。
 */
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { FactoryLayout } from '../model/factoryLayout'
import { NAVIGATION_STYLE as S } from './navigationAppearance'

export interface FactoryShellHandle {
  readonly id: number
  readonly group: THREE.Group
  updateCutaway(camera: THREE.Camera): void
  dispose(): void
}
let shellSequence = 0
export function createFactoryShell(layout: FactoryLayout): FactoryShellHandle {
  const group = new THREE.Group()
  group.name = 'factory-shell'
  const materials = {
    panel: new THREE.MeshStandardMaterial({ color: S.panel, roughness: S.panelRoughness, metalness: 0 }),
    frame: new THREE.MeshStandardMaterial({ color: '#1c242b', roughness: 0.62, metalness: 0 }),
    trim: new THREE.MeshStandardMaterial({ color: S.trim, roughness: S.trimRoughness, metalness: 0.8 }),
    lamp: new THREE.MeshStandardMaterial({ color: S.wallLamp, emissive: S.wallLamp, emissiveIntensity: S.wallEmission, roughness: 0.4 }),
  }
  const unit = new THREE.BoxGeometry(1, 1, 1)
  const column = new RoundedBoxGeometry(0.24, S.wallHeight, 0.36, 2, 0.025)
  const panelWidth = 1.25
  const panel = new RoundedBoxGeometry(panelWidth - 0.025, S.wallHeight - 0.35, 0.14, 2, 0.015)
  const geometries: THREE.BufferGeometry[] = [unit, column, panel]
  const batches: THREE.InstancedMesh[] = []
  const walls: { upper: THREE.Group; normalX: number; normalZ: number }[] = []
  const matrix = new THREE.Object3D()
  const direction = new THREE.Vector3()
  for (const wall of layout.walls) {
    const side = new THREE.Group()
    side.position.set(wall.x, 0, wall.z)
    side.rotation.y = wall.rotation
    group.add(side)
    const upper = new THREE.Group()
    side.add(upper)
    walls.push({ upper, normalX: wall.normalX, normalZ: wall.normalZ })
    const parts = new Map<string, { geometry: THREE.BufferGeometry; material: keyof typeof materials; low: boolean; matrices: THREE.Matrix4[] }>()
    const add = (material: keyof typeof materials, geometry: THREE.BufferGeometry, low: boolean, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => {
      const key = `${material}-${geometry.id}-${low}`
      if (!parts.has(key)) parts.set(key, { geometry, material, low, matrices: [] })
      matrix.position.set(x, y, z)
      matrix.scale.set(sx, sy, sz)
      matrix.updateMatrix()
      parts.get(key)!.matrices.push(matrix.matrix.clone())
    }
    const length = wall.length - 4
    const count = Math.max(1, Math.floor(length / panelWidth))
    add('frame', unit, true, 0, 0.21, -0.15, length, 0.42, 0.4)
    add('trim', unit, true, 0, 0.4, -0.22, length, 0.035, 0.46)
    add('frame', unit, false, 0, S.wallHeight / 2, 0.02, length, S.wallHeight, 0.16)
    add('trim', unit, false, 0, S.wallHeight + 0.018, -0.07, length, 0.035, 0.4)
    for (let i = 0; i < count; i += 1) {
      const x = -length / 2 + (i + 0.5) * length / count
      add('panel', panel, false, x, S.wallHeight / 2 + 0.1, -0.15, length / count / panelWidth)
      if (i % 4 === 0) {
        add('frame', column, false, x - length / count / 2, S.wallHeight / 2, -0.28)
        add('lamp', unit, false, x + length / count, S.wallHeight - 0.24, -0.255, length / count * 2.7, 0.038, 0.036)
      }
      add('lamp', unit, true, x, 0.13, -0.367, length / count - 0.1, 0.028, 0.032)
    }
    for (const part of parts.values()) {
      const mesh = new THREE.InstancedMesh(part.geometry, materials[part.material], part.matrices.length)
      part.matrices.forEach((value, index) => mesh.setMatrixAt(index, value))
      mesh.castShadow = mesh.receiveShadow = part.material !== 'lamp'
      mesh.computeBoundingSphere()
      ;(part.low ? side : upper).add(mesh)
      batches.push(mesh)
    }
  }
  /**
   * 四角弧墙位于地图外扩的建筑余量内，完全不侵入真实节点包围盒。
   * 分段轮廓拉伸形成细缝，小倒角和独立金属压顶提供边缘高光。
   */
  const arc = (inner: number, outer: number, height: number, start: number, end: number) => {
    const shape = new THREE.Shape()
    shape.absarc(0, 0, outer, start, end, false)
    shape.absarc(0, 0, inner, end, start, true)
    shape.closePath()
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.012, bevelThickness: 0.012, curveSegments: 12 })
    geometry.rotateX(-Math.PI / 2)
    geometries.push(geometry)
    return geometry
  }
  const segments = Array.from({ length: 8 }, (_, i) => arc(1.68, 2.02, 0.65, i * Math.PI / 16 + 0.006, (i + 1) * Math.PI / 16 - 0.006))
  const cap = arc(1.65, 2.04, 0.036, 0, Math.PI / 2)
  const strip = arc(1.638, 1.657, 0.024, 0, Math.PI / 2)
  const { minWorldX: x0, maxWorldX: x1, minWorldZ: z0, maxWorldZ: z1 } = layout.bounds
  const corners = [[x1 - 2, z0 + 2, 0], [x0 + 2, z0 + 2, Math.PI / 2], [x0 + 2, z1 - 2, Math.PI], [x1 - 2, z1 - 2, Math.PI * 1.5]]
  if (layout.walls.length > 1) for (const [x, z, rotation] of corners) {
    const corner = new THREE.Group()
    corner.position.set(x, 0, z)
    corner.rotation.y = rotation
    for (const geometry of segments) {
      const mesh = new THREE.Mesh(geometry, materials.panel)
      mesh.castShadow = mesh.receiveShadow = true
      corner.add(mesh)
    }
    const top = new THREE.Mesh(cap, materials.trim)
    top.position.y = 0.66
    const light = new THREE.Mesh(strip, materials.lamp)
    light.position.y = 0.6
    corner.add(top, light)
    group.add(corner)
  }
  return { id: ++shellSequence, group, updateCutaway(camera) {
    camera.getWorldDirection(direction)
    for (const wall of walls) {
      const facing = direction.x * wall.normalX + direction.z * wall.normalZ
      if (facing < -0.08) wall.upper.visible = false
      else if (facing > -0.02) wall.upper.visible = true
    }
  }, dispose() {
    for (const batch of batches) batch.dispose()
    for (const geometry of geometries) geometry.dispose()
    for (const material of Object.values(materials)) material.dispose()
  } }
}
