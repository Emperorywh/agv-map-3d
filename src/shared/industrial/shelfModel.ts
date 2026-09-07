/**
 * 空架与满载架直接读取交付的米制 GLB，文件及原始比例保持不变，架体统一适配室内哑光涂层。
 * 地图和车队共用加载入口，仅缓存字节；各资源代独立拥有几何、材质和贴图。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { joinGeometry } from './geometry'
import emptyUrl from '../../../assets/agv_shelf_20260907_01/shelf_empty.glb?url'
import loadedUrl from '../../../assets/agv_shelf_20260907_01/shelf_loaded.glb?url'
import emptyLod1Url from '../../../assets/agv_shelf_20260907_01/shelf_empty_LOD1.glb?url'
import emptyLod2Url from '../../../assets/agv_shelf_20260907_01/shelf_empty_LOD2.glb?url'
import loadedLod1Url from '../../../assets/agv_shelf_20260907_01/shelf_loaded_LOD1.glb?url'
import loadedLod2Url from '../../../assets/agv_shelf_20260907_01/shelf_loaded_LOD2.glb?url'

export const SHELF_MATERIAL_PARTS = {
  PowderCoat_OffWhite: 'shelfFrame',
  Foot_Rubber: 'shelfFeet',
  Bin_MatteGraphite: 'shelfBins',
  Label_Ivory: 'shelfLabels',
} as const
export type ShelfPartKind = typeof SHELF_MATERIAL_PARTS[keyof typeof SHELF_MATERIAL_PARTS]
export type ShelfVariant = 'empty' | 'loaded'
export interface ShelfModel {
  readonly parts: Partial<Record<ShelfPartKind, { geometry: THREE.BufferGeometry; material: THREE.Material; lodGeometries?: THREE.BufferGeometry[] }>>
  dispose(): void
}

const binaries = new Map<string, Promise<ArrayBuffer>>()
const modelUrls = { empty: [emptyUrl, emptyLod1Url, emptyLod2Url], loaded: [loadedUrl, loadedLod1Url, loadedLod2Url] } as const

/**
 * 地面与车载货架共享完整的三档材质分区，低模只提供几何，始终复用近景材质。
 * 派生资源不可用时回退原模型，失败档和未接管的贴图仍由原加载句柄对称释放。
 */
export async function loadShelfModel(variant: ShelfVariant): Promise<ShelfModel> {
  const primary = await loadShelfLevel(variant, 0)
  const results = await Promise.allSettled([1, 2].map((level) => loadShelfLevel(variant, level)))
  const models = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  try {
    const kinds = Object.keys(primary.parts) as ShelfPartKind[]
    if (models.length !== 2 || kinds.some((kind) => models.some((model) => model.parts[kind] === undefined))) {
      console.warn(`货架低模不可用，保留精修模型：${variant}`)
      return primary
    }
    for (const kind of kinds) primary.parts[kind]!.lodGeometries = models.map((model) => model.parts[kind]!.geometry.clone())
    return primary
  } catch (error) {
    primary.dispose()
    throw error
  } finally {
    for (const model of models) model.dispose()
  }
}

/**
 * 按原材质合并静态部件，仅把层级变换应用到运行时几何副本。
 * 保留料箱标签的原始 UV 和内嵌贴图，避免合批后丢失标签图案。
 */
async function loadShelfLevel(variant: ShelfVariant, level: number): Promise<ShelfModel> {
  const url = modelUrls[variant][level]
  let binary = binaries.get(url)
  binary ??= fetch(url).then((response) => {
    if (!response.ok) throw new Error(`货架模型加载失败：HTTP ${response.status}`)
    return response.arrayBuffer()
  }).catch((error: unknown) => { binaries.delete(url); throw error })
  binaries.set(url, binary)
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
    /**
     * 中远景几何随原货架一同释放，车队接管 parts 后也沿用相同的资源边界。
     * 原始材质和内嵌标签贴图只登记一份，派生文件的重复贴图不进入常驻资源。
     */
    for (const part of Object.values(parts)) {
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
