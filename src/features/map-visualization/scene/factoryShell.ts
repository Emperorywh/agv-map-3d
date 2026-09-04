/**
 * 程序化厂房剖面：灰色工业墙板、混凝土墙脚、柱网、高窗和关闭的卷帘门。
 * 不创建屋面；上墙与墙脚分别合批，近侧上墙可独立隐藏而不丢失空间边界。
 */
import * as THREE from 'three'
import type { FactoryLayout } from '../model/factoryLayout'
import { FACTORY_WALL_COLOR } from './mapAppearance'

interface WallBatch {
  readonly upper: THREE.Group
  readonly normalX: number
  readonly normalZ: number
}

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
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const materials = {
    panel: new THREE.MeshStandardMaterial({ color: FACTORY_WALL_COLOR, roughness: 0.86 }),
    concrete: new THREE.MeshStandardMaterial({ color: '#737f86', roughness: 0.96 }),
    steel: new THREE.MeshStandardMaterial({ color: '#56646c', roughness: 0.65, metalness: 0.25 }),
    glass: new THREE.MeshStandardMaterial({ color: '#b5d1d8', roughness: 0.48, emissive: '#90b2be', emissiveIntensity: 0.22 }),
    shutter: new THREE.MeshStandardMaterial({ color: '#929da3', roughness: 0.7, metalness: 0.18 }),
    safety: new THREE.MeshStandardMaterial({ color: '#d0ae50', roughness: 0.85 }),
  }
  type MaterialKey = keyof typeof materials
  const walls: WallBatch[] = []
  const batches: THREE.InstancedMesh[] = []
  const transform = new THREE.Object3D()
  const direction = new THREE.Vector3()
  const { wallHeightM: height, wallThicknessM: thickness, plinthHeightM: plinth, columnSpacingM: spacing } = layout.config

  for (const wall of layout.walls) {
    const side = new THREE.Group()
    side.name = `factory-wall-${wall.name}`
    side.position.set(wall.x, 0, wall.z)
    side.rotation.y = wall.rotation
    group.add(side)
    const upper = new THREE.Group()
    upper.name = `factory-wall-${wall.name}-cutaway`
    side.add(upper)
    walls.push({ upper, normalX: wall.normalX, normalZ: wall.normalZ })

    /**
     * 每侧墙按材质和剖切层合批，柱数增加不会线性增加绘制调用。
     * 全部构件复用单位立方体，局部负向深度指向室内。
     */
    const parts = new Map<string, { parent: THREE.Group; material: MaterialKey; matrices: THREE.Matrix4[] }>()
    const box = (material: MaterialKey, low: boolean, x: number, y: number, z: number, w: number, h: number, d: number): void => {
      const key = `${material}-${low}`
      let batch = parts.get(key)
      if (batch === undefined) {
        batch = { parent: low ? side : upper, material, matrices: [] }
        parts.set(key, batch)
      }
      transform.position.set(x, y, z)
      transform.scale.set(w, h, d)
      transform.updateMatrix()
      batch.matrices.push(transform.matrix.clone())
    }
    box('concrete', true, 0, plinth / 2, -thickness / 2, wall.length, plinth, thickness + 0.12)
    box('panel', false, 0, (height + plinth) / 2, -thickness / 2, wall.length, height - plinth, thickness)
    box('steel', false, 0, height - 0.2, -0.28, wall.length, 0.4, 0.45)
    box('steel', true, 0, plinth, -0.25, wall.length, 0.08, 0.25)
    const bays = Math.round(wall.length / spacing)
    for (let i = 0; i <= bays; i += 1) {
      const x = -wall.length / 2 + i * spacing
      box('concrete', true, x, 0.18, -0.58, 0.95, 0.36, 0.85)
      box('steel', false, x, (height + plinth) / 2, -0.5, 0.42, height - plinth, 0.6)
      box('safety', true, x, 0.6, -0.5, 0.48, 0.6, 0.65)
      box('steel', true, x, 0.62, -0.5, 0.5, 0.14, 0.67)
      if (i === bays) {
        continue
      }
      const center = x + spacing / 2

      /**
       * 高窗采用不透明磨砂玻璃，关闭的门作为完整内墙的一部分。
       * 剖面不借门窗暴露外界；窗框、卷帘横肋提供真实米制尺度。
       */
      box('steel', false, center, height - 2.7, -0.34, 5.6, 2.25, 0.12)
      box('glass', false, center, height - 2.7, -0.42, 5.3, 1.95, 0.08)
      for (const divider of [-1.8, 0, 1.8]) {
        box('steel', false, center + divider, height - 2.7, -0.48, 0.06, 2, 0.08)
      }
      for (let seam = 1; seam < 6; seam += 1) {
        box('concrete', false, x + seam * spacing / 6, 4.15, -thickness - 0.01, 0.025, 6.1, 0.025)
      }
      if (i === Math.floor(bays / 3) || (bays > 12 && i === Math.floor(bays * 2 / 3))) {
        box('steel', false, center, 2.65, -0.43, 4.9, 5.3, 0.3)
        box('shutter', false, center, 2.5, -0.61, 4.5, 5, 0.1)
        for (let rib = 1; rib < 20; rib += 1) {
          box('concrete', false, center, rib * 0.25, -0.68, 4.5, 0.025, 0.045)
        }
        box('safety', true, center - 2.55, 0.45, -0.9, 0.18, 0.9, 0.18)
        box('safety', true, center + 2.55, 0.45, -0.9, 0.18, 0.9, 0.18)
      }
    }
    for (const batch of parts.values()) {
      const mesh = new THREE.InstancedMesh(geometry, materials[batch.material], batch.matrices.length)
      batch.matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix))
      mesh.instanceMatrix.needsUpdate = true
      mesh.castShadow = batch.material !== 'glass'
      mesh.receiveShadow = true
      mesh.computeBoundingSphere()
      batch.parent.add(mesh)
      batches.push(mesh)
    }
  }
  let disposed = false
  return {
    id: ++shellSequence,
    group,
    updateCutaway(camera) {
      /**
       * 用最终观察方向判断近侧墙，保留远侧墙体；迟滞避免贴着墙向旋转时闪烁。
       * 只切换整个上墙组，柱、窗和门同步显隐，墙脚始终保留。
       */
      camera.getWorldDirection(direction)
      for (const wall of walls) {
        const facing = direction.x * wall.normalX + direction.z * wall.normalZ
        if (facing < -0.08) wall.upper.visible = false
        else if (facing > -0.02) wall.upper.visible = true
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const batch of batches) batch.dispose()
      geometry.dispose()
      for (const material of Object.values(materials)) material.dispose()
    },
  }
}
