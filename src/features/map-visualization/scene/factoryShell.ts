/**
 * 程序化厂房剖面：灰色工业墙板、混凝土墙脚、柱网、高窗和关闭的卷帘门。
 * 不创建屋面；上墙与墙脚分别合批，近侧上墙可独立隐藏而不丢失空间边界。
 */
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
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
  /**
   * 柱子按真实尺寸建立倒角，避免非均匀缩放把高柱的倒角拉成长斜面。
   * 墙板用共享遮蔽贴图保留接缝和墙脚层次，不为每块板增加实时灯光。
   */
  const columnGeometry = new RoundedBoxGeometry(0.64, layout.config.wallHeightM - layout.config.plinthHeightM, 0.7, 2, 0.045)
  const wallAo = createWallOcclusion()
  const materials = {
    panel: new THREE.MeshStandardMaterial({ color: FACTORY_WALL_COLOR, roughness: 0.64, aoMap: wallAo, aoMapIntensity: 0.65 }),
    concrete: new THREE.MeshStandardMaterial({ color: '#929b9f', roughness: 0.8 }),
    steel: new THREE.MeshStandardMaterial({ color: '#c0c6c8', roughness: 0.46, metalness: 0.12 }),
    trim: new THREE.MeshStandardMaterial({ color: '#778389', roughness: 0.55, metalness: 0.18 }),
    glass: new THREE.MeshStandardMaterial({ color: '#b7c5cc', roughness: 0.3, emissive: '#d7e5ec', emissiveIntensity: 0.38 }),
    shutter: new THREE.MeshStandardMaterial({ color: '#acb4b8', roughness: 0.6, metalness: 0.12 }),
    safety: new THREE.MeshStandardMaterial({ color: '#c0ae7d', roughness: 0.75 }),
    lamp: new THREE.MeshStandardMaterial({ color: '#eaf2f4', roughness: 0.3, emissive: '#e3eff5', emissiveIntensity: 2.4 }),
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
     * 墙体复用单位立方体，立柱复用米制倒角几何；局部负向深度指向室内。
     */
    const parts = new Map<string, { parent: THREE.Group; material: MaterialKey; geometry: THREE.BufferGeometry; matrices: THREE.Matrix4[] }>()
    const box = (material: MaterialKey, low: boolean, x: number, y: number, z: number, w: number, h: number, d: number, column = false): void => {
      const key = `${material}-${low}-${column}`
      let batch = parts.get(key)
      if (batch === undefined) {
        batch = { parent: low ? side : upper, material, geometry: column ? columnGeometry : geometry, matrices: [] }
        parts.set(key, batch)
      }
      transform.position.set(x, y, z)
      transform.scale.set(column ? 1 : w, column ? 1 : h, column ? 1 : d)
      transform.updateMatrix()
      batch.matrices.push(transform.matrix.clone())
    }
    box('concrete', true, 0, plinth / 2, -thickness / 2, wall.length, plinth, thickness + 0.12)
    box('concrete', false, 0, (height + plinth) / 2, -thickness / 2, wall.length, height - plinth, thickness)
    box('steel', false, 0, height - 0.2, -0.28, wall.length, 0.4, 0.45)
    box('trim', true, 0, plinth, -0.32, wall.length, 0.07, 0.22)
    const bays = Math.round(wall.length / spacing)
    for (let i = 0; i <= bays; i += 1) {
      const x = -wall.length / 2 + i * spacing
      box('concrete', true, x, 0.18, -0.58, 0.95, 0.36, 0.85)
      box('steel', false, x, (height + plinth) / 2, -0.5, 0.64, height - plinth, 0.7, true)
      box('concrete', true, x, 0.6, -0.5, 0.68, 0.6, 0.75)
      box('steel', true, x, 0.94, -0.5, 0.7, 0.08, 0.77)
      if (i === bays) {
        continue
      }
      const center = x + spacing / 2

      /**
       * 每个柱跨分成六块独立浅灰墙板，细缝由真实间隙和遮蔽贴图共同表现。
       * 低位灯槽保持连续节奏，门口自然中断，底部柔光由地坪材质接续。
       */
      for (let panel = 0; panel < 6; panel += 1) {
        box('panel', false, x + (panel + 0.5) * spacing / 6, (height + plinth) / 2, -thickness - 0.012, spacing / 6 - 0.018, height - plinth - 0.06, 0.035)
      }
      const hasDoor = i === Math.floor(bays / 3) || (bays > 12 && i === Math.floor(bays * 2 / 3))
      if (!hasDoor) {
        box('trim', false, center, 1.24, -0.38, spacing - 0.7, 0.26, 0.14)
        box('lamp', false, center, 1.24, -0.465, spacing - 0.8, 0.1, 0.025)
        box('steel', false, center, 1.07, -0.45, spacing - 0.7, 0.035, 0.2)
      }

      /**
       * 高窗采用不透明磨砂玻璃，关闭的门作为完整内墙的一部分。
       * 剖面不借门窗暴露外界；窗框、卷帘横肋提供真实米制尺度。
       */
      box('trim', false, center, height - 2.7, -0.4, 5.6, 2.25, 0.12)
      /**
       * 玻璃位于窗框内侧表面之前，留出实际深度，消除共面造成的条纹闪烁。
       * 窗格再向室内前移，细杆不会和玻璃共享深度。
       */
      box('glass', false, center, height - 2.7, -0.5, 5.3, 1.95, 0.08)
      for (const divider of [-1.8, 0, 1.8]) {
        box('steel', false, center + divider, height - 2.7, -0.57, 0.06, 2, 0.08)
      }
      if (hasDoor) {
        box('trim', false, center, 2.65, -0.43, 4.9, 5.3, 0.3)
        box('shutter', false, center, 2.5, -0.61, 4.5, 5, 0.1)
        for (let rib = 1; rib < 20; rib += 1) {
          box('concrete', false, center, rib * 0.25, -0.68, 4.5, 0.025, 0.045)
        }
        box('safety', true, center - 2.55, 0.45, -0.9, 0.18, 0.9, 0.18)
        box('safety', true, center + 2.55, 0.45, -0.9, 0.18, 0.9, 0.18)
      }
    }
    for (const batch of parts.values()) {
      const mesh = new THREE.InstancedMesh(batch.geometry, materials[batch.material], batch.matrices.length)
      batch.matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix))
      mesh.instanceMatrix.needsUpdate = true
      mesh.castShadow = batch.material !== 'glass' && batch.material !== 'lamp'
      mesh.receiveShadow = batch.material !== 'glass' && batch.material !== 'lamp'
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
      columnGeometry.dispose()
      wallAo.dispose()
      for (const material of Object.values(materials)) material.dispose()
    },
  }
}

/**
 * 墙板遮蔽以线性灰度储存，只调制环境光，保留实时主光的正常响应。
 * 左右接缝与底部比板心略暗，重复使用同一小贴图即可覆盖所有柱跨。
 */
function createWallOcclusion(): THREE.DataTexture {
  const size = 128
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / (size - 1)
      const v = y / (size - 1)
      const edge = Math.exp(-Math.min(u, 1 - u) * 45) * 0.16
      const foot = Math.exp(-v * 12) * 0.25
      const value = Math.round((1 - edge - foot) * 255)
      const index = (y * size + x) * 4
      data[index] = value
      data[index + 1] = value
      data[index + 2] = value
      data[index + 3] = 255
    }
  }
  const texture = new THREE.DataTexture(data, size, size)
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  return texture
}
