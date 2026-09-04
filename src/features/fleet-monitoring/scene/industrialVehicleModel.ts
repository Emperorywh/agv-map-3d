/**
 * 精修资源按材质合并为八个实例部件，模型层级的世界矩阵在合并前烘焙到顶点。
 * 原始文件只缓存二进制，不缓存 GPU 对象；每次上下文恢复都重新解析并明确释放。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { joinGeometry } from '@/shared/industrial/geometry'
import { createStatusMaterial } from '@/shared/industrial/materials'
import { INDUSTRIAL_AGV_MODEL } from './vehicleModelConfig'

export const GLB_MATERIAL_PARTS = {
  Paint_LightGray: 'glbPaint',
  Chassis_DarkGray: 'glbChassis',
  Platform_Matte: 'glbPlatform',
  Rubber_Black: 'glbRubber',
  Sensor_Glass: 'glbSensor',
  Hardware_SatinMetal: 'glbMetal',
  Emergency_Red: 'glbEmergency',
  Status_Emission: 'glbStatus',
} as const
export type GlbPartKind = typeof GLB_MATERIAL_PARTS[keyof typeof GLB_MATERIAL_PARTS]
export interface IndustrialModel {
  parts: Record<GlbPartKind, { geometry: THREE.BufferGeometry; material: THREE.Material }>
  dispose(): void
}
let binary: Promise<ArrayBuffer> | undefined

export async function loadIndustrialVehicleModel(): Promise<IndustrialModel> {
  const url = new URL(INDUSTRIAL_AGV_MODEL.url, document.baseURI)
  binary ??= fetch(url).then((response) => {
    if (!response.ok) throw new Error(`工业模型加载失败：${response.status}`)
    return response.arrayBuffer()
  }).catch((error: unknown) => { binary = undefined; throw error })
  const gltf = await new GLTFLoader().parseAsync(await binary, new URL('.', url).href)
  const sourceGeometries = new Set<THREE.BufferGeometry>()
  const sourceMaterials = new Set<THREE.Material>()
  const sourceTextures = new Set<THREE.Texture>()
  const geometryGroups = new Map<GlbPartKind, THREE.BufferGeometry[]>()
  const parts = {} as IndustrialModel['parts']
  gltf.scene.updateMatrixWorld(true)
  const dispose = () => {
    for (const part of Object.values(parts)) { part.geometry.dispose(); part.material.dispose() }
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
    if (Math.abs(size.x - 1.8) > 0.001 || Math.abs(size.z - 0.7) > 0.001 ||
      Math.abs(size.y - 0.35) > 0.001 || Math.abs(bounds.min.y) > 0.001 ||
      Math.abs(bounds.min.x + bounds.max.x) > 0.001 || Math.abs(bounds.min.z + bounds.max.z) > 0.001) {
      throw new Error('工业模型尺寸或定位与适配档案不一致')
    }
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      if (object instanceof THREE.SkinnedMesh || Array.isArray(object.material)) {
        throw new Error('当前工业模型适配器仅接受静态单材质子网格')
      }
      const kind = GLB_MATERIAL_PARTS[object.material.name as keyof typeof GLB_MATERIAL_PARTS]
      if (kind === undefined) throw new Error(`工业模型出现未配置材质：${object.material.name}`)
      const geometry = object.geometry.index === null ? object.geometry.clone() : object.geometry.toNonIndexed()
      geometry.applyMatrix4(object.matrixWorld)
      for (const name of Object.keys(geometry.attributes)) {
        if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name)
      }
      const group = geometryGroups.get(kind) ?? []
      group.push(geometry)
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
