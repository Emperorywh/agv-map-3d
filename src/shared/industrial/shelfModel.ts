/**
 * 空架与满载架直接读取交付的米制 GLB，文件及原始比例保持不变，架体统一适配室内哑光涂层。
 * 地图和车队共用加载入口，仅缓存字节；各资源代独立拥有几何、材质和贴图。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { joinGeometry } from './geometry'
import emptyUrl from '../../../assets/agv_shelf_20260907_01/shelf_empty.glb?url'
import loadedUrl from '../../../assets/agv_shelf_20260907_01/shelf_loaded.glb?url'

export const SHELF_MATERIAL_PARTS = {
  PowderCoat_OffWhite: 'shelfFrame',
  Foot_Rubber: 'shelfFeet',
  Bin_MatteGraphite: 'shelfBins',
  Label_Ivory: 'shelfLabels',
} as const
export type ShelfPartKind = typeof SHELF_MATERIAL_PARTS[keyof typeof SHELF_MATERIAL_PARTS]
export type ShelfVariant = 'empty' | 'loaded'
export interface ShelfModel {
  readonly parts: Partial<Record<ShelfPartKind, { geometry: THREE.BufferGeometry; material: THREE.Material }>>
  dispose(): void
}

const binaries = new Map<ShelfVariant, Promise<ArrayBuffer>>()

/**
 * 按原材质合并静态部件，仅把层级变换应用到运行时几何副本。
 * 保留料箱标签的原始 UV 和内嵌贴图，避免合批后丢失标签图案。
 */
export async function loadShelfModel(variant: ShelfVariant): Promise<ShelfModel> {
  let binary = binaries.get(variant)
  binary ??= fetch(variant === 'empty' ? emptyUrl : loadedUrl).then((response) => {
    if (!response.ok) throw new Error(`货架模型加载失败：HTTP ${response.status}`)
    return response.arrayBuffer()
  }).catch((error: unknown) => { binaries.delete(variant); throw error })
  binaries.set(variant, binary)
  const gltf = await new GLTFLoader().parseAsync(await binary, '')
  const sourceGeometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  const groups = new Map<ShelfPartKind, THREE.BufferGeometry[]>()
  const parts: ShelfModel['parts'] = {}
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const part of Object.values(parts)) part.geometry.dispose()
    for (const material of materials) material.dispose()
    for (const texture of textures) texture.dispose()
  }
  gltf.scene.updateMatrixWorld(true)
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    sourceGeometries.add(object.geometry)
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material)
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value)
    }
  })
  /**
   * 原始白漆在线性空间的反射率接近八成，叠加室内环境与顶光后容易触发泛光。
   * 只将架体改为哑光浅灰并降低环境反射，保留实体受光、阴影和层板明暗差。
   * 材质集合去重后每份只调整一次，地面与车载的两种货架保持相同涂层。
   */
  for (const material of materials) {
    if (material.name !== 'PowderCoat_OffWhite' || !(material instanceof THREE.MeshStandardMaterial)) continue
    material.color.set('#a5adae')
    material.roughness = 0.82
    material.envMapIntensity = 0.35
  }
  try {
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      if (object instanceof THREE.SkinnedMesh || Array.isArray(object.material)) throw new Error('货架需要静态单材质子网格')
      const kind = SHELF_MATERIAL_PARTS[object.material.name as keyof typeof SHELF_MATERIAL_PARTS]
      if (kind === undefined) throw new Error(`货架出现未配置材质：${object.material.name}`)
      const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld)
      const group = groups.get(kind) ?? []
      group.push(geometry)
      groups.set(kind, group)
      parts[kind] ??= { geometry: new THREE.BufferGeometry(), material: object.material }
    })
    for (const [kind, group] of groups) {
      parts[kind]!.geometry.dispose()
      parts[kind]!.geometry = joinGeometry(group)
      groups.delete(kind)
    }
    const required: ShelfPartKind[] = variant === 'loaded' ? Object.values(SHELF_MATERIAL_PARTS) : ['shelfFrame', 'shelfFeet']
    if (required.some((kind) => parts[kind] === undefined)) throw new Error('货架模型缺少必要部件')
    return { parts, dispose }
  } catch (error) {
    for (const group of groups.values()) for (const geometry of group) geometry.dispose()
    dispose()
    throw error
  } finally {
    for (const geometry of sourceGeometries) geometry.dispose()
  }
}
