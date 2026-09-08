/**
 * 精修资源按材质合并为十个实例部件，模型层级的世界矩阵在合并前烘焙到顶点。
 * 原始文件只缓存二进制，不缓存 GPU 对象；每次上下文恢复都重新解析并明确释放。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { joinGeometry } from '@/shared/industrial/geometry'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { createStatusMaterial } from '@/shared/industrial/materials'
import { INDUSTRIAL_AGV_MODEL } from './vehicleModelConfig'

/**
 * 设计一资产的材质→实例部件映射（材质名必须与 GLB 完全一致）。
 * glbPaint 为银灰主车体（可拾取），glbPlatform 为深灰承载平台（可拾取），
 * glbStatus 包含车身与立柱的五段灯，沿用实例状态色，其余保留原始 PBR 参数。
 */
export const GLB_MATERIAL_PARTS = {
  Body_Silver_Satin: 'glbPaint',
  Platform_DarkGray: 'glbPlatform',
  Chassis_Powdercoat: 'glbChassis',
  Structure_Charcoal: 'glbStructure',
  Fascia_Graphite: 'glbArmor',
  Hardware_Satin: 'glbMetal',
  Rubber_Black: 'glbRubber',
  Screen_Sensor_Glass: 'glbSensor',
  Emergency_Stop_Red: 'glbEmergency',
  LED_Cyan_Emission: 'glbStatus',
} as const
export type GlbPartKind = typeof GLB_MATERIAL_PARTS[keyof typeof GLB_MATERIAL_PARTS]
export interface IndustrialModel {
  parts: Record<GlbPartKind, { geometry: THREE.BufferGeometry; material: THREE.Material; lodGeometries?: THREE.BufferGeometry[] }>
  dispose(): void
}
/**
 * 只缓存文件字节，每个资源代独立创建几何和材质。
 * 两档派生模型加载失败时保留原精修资产，避免低模缺失拖垮车队显示。
 */
const binaries = new Map<string, Promise<ArrayBuffer>>()

/** 资产原朝向为车头 +Z，场景约定车头 +X：合并前绕 Y 旋转 90° 烘入顶点 */
const FORWARD_BAKE_ROTATION_Y = Math.PI / 2
/**
 * 设计一屏幕等突出部件使前后边界绝对值相差约 16mm，允许两厘米的不对称。
 * 保留资产的车身地面中心原点，不按整车包围盒重新平移模型。
 */
const CENTERING_TOLERANCE_M = 0.02

export async function loadIndustrialVehicleModel(): Promise<IndustrialModel> {
  const primary = await loadModelLevel(INDUSTRIAL_AGV_MODEL.url, true)
  const results = await Promise.allSettled(INDUSTRIAL_AGV_MODEL.lodUrls.map((url) => loadModelLevel(url, false)))
  /**
   * 派生几何共用精修材质，颜色与发光参数不会在距离切换时改变。
   * 只接受连续完整的两档，失败或材质缺失时统一回退到精修几何。
   */
  if (results.every((result) => result.status === 'fulfilled')) {
    for (const kind of Object.values(GLB_MATERIAL_PARTS)) {
      primary.parts[kind].lodGeometries = results.map((result) => {
        const part = (result as PromiseFulfilledResult<IndustrialModel>).value.parts[kind]
        part.material.dispose()
        return part.geometry
      })
    }
  } else {
    for (const result of results) {
      if (result.status === 'fulfilled') result.value.dispose()
      else console.warn('车辆低模不可用，保留精修模型', result.reason)
    }
  }
  return primary
}

/**
 * 各档使用相同朝向烘焙和材质映射；仅原始资产执行毫米级尺寸合同校验。
 * 派生模型的边缘可能因减面产生微小变化，不重新缩放或改变其定位原点。
 */
async function loadModelLevel(path: string, validateDimensions: boolean): Promise<IndustrialModel> {
  const url = new URL(path, document.baseURI)
  let binary = binaries.get(url.href)
  binary ??= fetch(url).then((response) => {
    if (!response.ok) throw new Error(`工业模型加载失败：${response.status}`)
    return response.arrayBuffer()
  }).catch((error: unknown) => { binaries.delete(url.href); throw error })
  binaries.set(url.href, binary)
  const gltf = await new GLTFLoader().parseAsync(await binary, new URL('.', url).href)
  gltf.scene.rotation.y = FORWARD_BAKE_ROTATION_Y
  gltf.scene.updateMatrixWorld(true)
  const sourceGeometries = new Set<THREE.BufferGeometry>()
  const sourceMaterials = new Set<THREE.Material>()
  const sourceTextures = new Set<THREE.Texture>()
  const geometryGroups = new Map<GlbPartKind, THREE.BufferGeometry[]>()
  const parts = {} as IndustrialModel['parts']
  const dispose = () => {
    for (const part of Object.values(parts)) {
      part.geometry.dispose()
      for (const lod of part.lodGeometries ?? []) lod.dispose()
      part.material.dispose()
    }
  }
  try {
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      sourceGeometries.add(object.geometry)
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        sourceMaterials.add(material)
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) sourceTextures.add(value)
        }
      }
    })
    const bounds = new THREE.Box3().setFromObject(gltf.scene)
    const size = bounds.getSize(new THREE.Vector3())
    const config = INDUSTRIAL_AGV_MODEL
    const tolerance = config.dimensionToleranceM
    if (validateDimensions && (Math.abs(size.x - config.length) > tolerance || Math.abs(size.z - config.width) > tolerance ||
      Math.abs(size.y - config.height) > tolerance || Math.abs(bounds.min.y) > tolerance ||
      Math.abs(bounds.min.x + bounds.max.x) > CENTERING_TOLERANCE_M ||
      Math.abs(bounds.min.z + bounds.max.z) > CENTERING_TOLERANCE_M)) {
      throw new Error('工业模型尺寸或定位与适配档案不一致')
    }
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      if (object instanceof THREE.SkinnedMesh || Array.isArray(object.material)) {
        throw new Error('当前工业模型适配器仅接受静态单材质子网格')
      }
      const kind = GLB_MATERIAL_PARTS[object.material.name as keyof typeof GLB_MATERIAL_PARTS]
      if (kind === undefined) throw new Error(`工业模型出现未配置材质：${object.material.name}`)
      const geometry = object.geometry.clone()
      geometry.applyMatrix4(object.matrixWorld)
      for (const name of Object.keys(geometry.attributes)) {
        if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name)
      }
      /**
       * 统一为带索引的几何，保留法线接缝，只合并所有剩余属性都一致的顶点。
       * 避免把共享顶点展开成三角形独占顶点，降低合批后的顶点带宽与内存。
       */
      const indexed = mergeVertices(geometry, 0.00001)
      geometry.dispose()
      const group = geometryGroups.get(kind) ?? []
      group.push(indexed)
      geometryGroups.set(kind, group)
      if (parts[kind] === undefined) {
        parts[kind] = { geometry: new THREE.BufferGeometry(), material: kind === 'glbStatus' ? createStatusMaterial() : object.material.clone() }
      }
    })
    for (const kind of Object.values(GLB_MATERIAL_PARTS)) {
      const group = geometryGroups.get(kind)
      if (!group?.length) throw new Error(`工业模型缺少部件：${kind}`)
      parts[kind].geometry.dispose()
      parts[kind].geometry = joinGeometry(group)
      geometryGroups.delete(kind)
    }
    return { parts, dispose }
  } catch (error) {
    for (const group of geometryGroups.values()) for (const geometry of group) geometry.dispose()
    dispose()
    throw error
  } finally {
    for (const geometry of sourceGeometries) geometry.dispose()
    for (const material of sourceMaterials) material.dispose()
    for (const texture of sourceTextures) texture.dispose()
  }
}
