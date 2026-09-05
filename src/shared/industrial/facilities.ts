/**
 * 程序化设施采用受光工业材质，零米为承载地面，正 Z 为操作面朝向。
 * 柜体与货架按材质合并重复结构；同款设施再通过实例矩阵复用全部资源。
 */
import * as THREE from 'three'
import { industrialBox, joinGeometry } from './geometry'
import { createIndustrialMaterials } from './materials'

export interface FacilityAsset {
  parts: { geometry: THREE.BufferGeometry; material: THREE.Material }[]
  dispose(): void
}
export interface CabinetConfig { width: number; depth: number; height: number }
export interface RackConfig { bayWidth: number; depth: number; levels: number; levelSpacing: number; bays: number }
export const CABINET_CONFIG: CabinetConfig = { width: 0.4, depth: 0.28, height: 0.9 }
export const RACK_CONFIG: RackConfig = { bayWidth: 1.8, depth: 0.9, levels: 3, levelSpacing: 0.68, bays: 2 }

/**
 * 柜门留有装配缝，底座、操作面板、接口和金属端子分别建模。
 * 仅面板上的小指示灯发光，取消地面大光圈与悬空闪电符号。
 */
export function createChargingCabinet(config: CabinetConfig = CABINET_CONFIG): FacilityAsset {
  const { width: w, depth: d, height: h } = config
  if (![w, d, h].every((n) => Number.isFinite(n) && n > 0.15)) throw new Error('充电柜尺寸无效')
  const materials = createIndustrialMaterials()
  const groups = new Map<THREE.Material, THREE.BufferGeometry[]>()
  const add = (material: THREE.Material, x: number, y: number, z: number, px: number, py: number, pz: number, radius = 0.008) => {
    const parts = groups.get(material) ?? []
    parts.push(industrialBox(x, y, z, radius).translate(px, py, pz))
    groups.set(material, parts)
  }
  add(materials.chassis, w, h * 0.09, d, 0, h * 0.045, 0)
  add(materials.paint, w * 0.96, h * 0.91, d * 0.94, 0, h * 0.545, 0, 0.016)
  add(materials.rubber, w * 0.86, h * 0.68, 0.008, 0, h * 0.48, d * 0.475)
  add(materials.paint, w * 0.83, h * 0.66, 0.009, 0, h * 0.48, d * 0.493)
  add(materials.chassis, w * 0.64, h * 0.21, 0.014, 0, h * 0.74, d * 0.52)
  add(materials.rubber, w * 0.42, h * 0.075, 0.01, 0, h * 0.77, d * 0.552)
  add(materials.rubber, w * 0.40, h * 0.13, 0.030, 0, h * 0.28, d * 0.54)
  for (const side of [-1, 1]) add(materials.metal, w * 0.065, h * 0.065, 0.012, side * w * 0.09, h * 0.28, d * 0.61)
  add(materials.metal, w * 0.03, h * 0.12, 0.013, w * 0.31, h * 0.48, d * 0.535)
  const light = new THREE.MeshStandardMaterial({ color: '#10b9ac', emissive: '#10b9ac', emissiveIntensity: 0.45, roughness: 0.4 })
  // 命名指示灯材质：地图图层（P2-1）据此识别注入目标，补充总览淡出与呼吸脉冲
  light.name = 'charge-cabinet-indicator'
  add(light, w * 0.10, h * 0.018, 0.006, -w * 0.19, h * 0.685, d * 0.556)
  return finish(groups, [...Object.values(materials), light])
}

/**
 * 蓝色立柱、黄色横梁、灰色层板及侧面斜撑构成一组可配置货架。
 * 所有层板上表面按层间距定位，可据此放置托盘；布局未确认时只供预览使用。
 */
export function createIndustrialRack(config: RackConfig = RACK_CONFIG): FacilityAsset {
  const { bayWidth, depth, levels, levelSpacing, bays } = config
  if (![bayWidth, depth, levelSpacing].every((v) => Number.isFinite(v) && v > 0.25) ||
    !Number.isInteger(levels) || levels < 1 || levels > 12 || !Number.isInteger(bays) || bays < 1 || bays > 20) throw new Error('货架配置无效')
  const height = levels * levelSpacing + 0.18
  const width = bays * bayWidth
  const blue = new THREE.MeshStandardMaterial({ color: '#265d89', roughness: 0.53, metalness: 0.28 })
  const yellow = new THREE.MeshStandardMaterial({ color: '#d39a27', roughness: 0.56, metalness: 0.22 })
  const steel = new THREE.MeshStandardMaterial({ color: '#818a90', roughness: 0.63, metalness: 0.65 })
  const groups = new Map<THREE.Material, THREE.BufferGeometry[]>([[blue, []], [yellow, []], [steel, []]])
  const beam = (material: THREE.Material, x: number, y: number, z: number, px: number, py: number, pz: number) => {
    groups.get(material)!.push(industrialBox(x, y, z, 0.005).translate(px, py, pz))
  }
  for (let i = 0; i <= bays; i += 1) {
    const x = -width / 2 + i * bayWidth
    for (const z of [-depth / 2, depth / 2]) {
      beam(blue, 0.065, height, 0.065, x, height / 2, z)
      beam(steel, 0.14, 0.018, 0.14, x, 0.009, z)
    }
    for (let level = 0; level < levels; level += 1) {
      const bottom = 0.14 + level * levelSpacing
      const a = new THREE.Vector3(x, bottom, -depth / 2)
      const b = new THREE.Vector3(x, bottom + levelSpacing * 0.85, depth / 2)
      const direction = b.clone().sub(a)
      const brace = industrialBox(0.025, direction.length(), 0.025, 0.003)
      brace.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()))
      brace.translate(...a.add(b).multiplyScalar(0.5).toArray())
      groups.get(steel)!.push(brace)
    }
  }
  for (let bay = 0; bay < bays; bay += 1) for (let level = 0; level < levels; level += 1) {
    const x = -width / 2 + (bay + 0.5) * bayWidth
    const y = 0.14 + level * levelSpacing
    for (const z of [-depth / 2, depth / 2]) beam(yellow, bayWidth - 0.06, 0.085, 0.05, x, y, z)
    beam(steel, bayWidth - 0.075, 0.025, depth - 0.025, x, y + 0.055, 0)
  }
  return finish(groups, [blue, yellow, steel])
}

function finish(groups: Map<THREE.Material, THREE.BufferGeometry[]>, materials: THREE.Material[]): FacilityAsset {
  const parts = [...groups].map(([material, geometries]) => ({ geometry: joinGeometry(geometries), material }))
  return { parts, dispose() {
    for (const part of parts) part.geometry.dispose()
    for (const material of materials) material.dispose()
  } }
}

/**
 * 同款设施的全部实例只共享一组几何和材质，矩阵来自地图节点或明确配置。
 * 释放句柄仅回收实例缓冲；资产所有者负责几何和材质，避免重复释放共享资源。
 */
export function instanceFacility(asset: FacilityAsset, matrices: Float32Array): { group: THREE.Group; dispose(): void } {
  const group = new THREE.Group()
  const count = matrices.length / 16
  for (const part of asset.parts) {
    const mesh = new THREE.InstancedMesh(part.geometry, part.material, count)
    mesh.instanceMatrix.array.set(matrices)
    mesh.instanceMatrix.needsUpdate = true
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.computeBoundingSphere()
    group.add(mesh)
  }
  return { group, dispose() { for (const child of group.children) (child as THREE.InstancedMesh).dispose() } }
}
