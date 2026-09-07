/**
 * 充电塔按材质和顶点布局合并为整塔部件，每座塔只提交一份对应材质的实例。
 * 三档几何保持米制坐标及原材质，水晶保留独立部件以维持透明排序。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { joinGeometry } from '@/shared/industrial/geometry'
import towerUrl from '../../../../assets/agv_charge_tower_20260907_01/agv_charge_tower.glb?url'
import towerLod1Url from '../../../../assets/agv_charge_tower_20260907_01/agv_charge_tower_LOD1.glb?url'
import towerLod2Url from '../../../../assets/agv_charge_tower_20260907_01/agv_charge_tower_LOD2.glb?url'

interface TowerPart {
  geometry: THREE.BufferGeometry
  material: THREE.Material
  lodGeometries?: THREE.BufferGeometry[]
}
const binaries = new Map<string, Promise<ArrayBuffer>>()

export async function loadChargingTowerAsset() {
  const primary = await loadLevel(towerUrl)
  const results = await Promise.allSettled([towerLod1Url, towerLod2Url].map(loadLevel))
  const models = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  try {
    /**
     * 只有两档都包含完整部件时才接入 LOD，发布资源缺失时仍能显示原塔体。
     * 派生几何复制给主句柄后立即释放低模的材质与贴图，运行时不保留三套纹理。
     */
    if (models.length !== 2 || [...primary.opaque.keys()].some((key) => models.some((model) => !model.opaque.has(key)))) {
      console.warn('充电塔低模不可用，保留精修模型')
      return primary
    }
    for (const [key, part] of primary.opaque) part.lodGeometries = models.map((model) => model.opaque.get(key)!.geometry.clone())
    return primary
  } catch (error) {
    primary.dispose()
    throw error
  } finally {
    for (const model of models) model.dispose()
  }
}

/**
 * 每档独立解析，只有二进制请求缓存；上下文恢复时重新建立全部 GPU 资源。
 * 原始层级变换烘焙到副本，带 UV 和不带 UV 的金属仍分组处理，不删除顶点属性。
 */
async function loadLevel(url: string) {
  let binary = binaries.get(url)
  binary ??= fetch(url).then((response) => {
    if (!response.ok) throw new Error(`充电塔模型加载失败：HTTP ${response.status}`)
    return response.arrayBuffer()
  }).catch((error: unknown) => { binaries.delete(url); throw error })
  binaries.set(url, binary)
  const gltf = await new GLTFLoader().parseAsync(await binary, '')
  const sourceGeometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  const groups = new Map<string, THREE.BufferGeometry[]>()
  const opaque = new Map<string, TowerPart>()
  const crystals: TowerPart[] = []
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const part of [...opaque.values(), ...crystals]) {
      part.geometry.dispose()
      for (const geometry of part.lodGeometries ?? []) geometry.dispose()
    }
    for (const material of materials) material.dispose()
    for (const texture of textures) texture.dispose()
  }
  gltf.scene.updateMatrixWorld(true)
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    sourceGeometries.add(object.geometry)
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material)
      /**
       * 主面板与底座的闪电共用绿色材质，三档模型加载时统一应用。
       * 同步调整表面色和自发光色，保留原有发光强度。
       */
      if (material.name === 'Lightning_Emission' && material instanceof THREE.MeshStandardMaterial) {
        material.color.setHex(0x22c55e)
        material.emissive.copy(material.color)
      }
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value)
    }
  })
  try {
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      if (object instanceof THREE.SkinnedMesh || Array.isArray(object.material)) throw new Error('充电塔需要静态单材质子网格')
      const material = object.material
      const geometry: THREE.BufferGeometry = object.geometry.clone().applyMatrix4(object.matrixWorld)
      if (material.transparent || material instanceof THREE.MeshPhysicalMaterial && material.transmission > 0) {
        crystals.push({ geometry, material })
        return
      }
      const layout = Object.entries(geometry.attributes).sort(([a], [b]) => a.localeCompare(b))
        .map(([name, attribute]) => `${name}:${attribute.itemSize}:${attribute.normalized}`).join('|')
      const key = `${material.name}:${geometry.index !== null}:${layout}`
      const group = groups.get(key) ?? []
      group.push(geometry)
      groups.set(key, group)
      if (!opaque.has(key)) opaque.set(key, { geometry: new THREE.BufferGeometry(), material })
    })
    for (const [key, group] of groups) {
      const part = opaque.get(key)!
      part.geometry.dispose()
      part.geometry = joinGeometry(group)
      groups.delete(key)
    }
    return { opaque, crystals, dispose }
  } catch (error) {
    for (const group of groups.values()) for (const geometry of group) geometry.dispose()
    dispose()
    throw error
  } finally {
    for (const geometry of sourceGeometries) geometry.dispose()
  }
}
