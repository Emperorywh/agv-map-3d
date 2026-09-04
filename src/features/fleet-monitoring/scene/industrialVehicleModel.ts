/**
 * 精修资源按材质合并为九个实例部件，模型层级的世界矩阵在合并前烘焙到顶点。
 * 原始文件只缓存二进制，不缓存 GPU 对象；每次上下文恢复都重新解析并明确释放。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { joinGeometry } from '@/shared/industrial/geometry'
import { createStatusMaterial } from '@/shared/industrial/materials'
import { INDUSTRIAL_AGV_MODEL } from './vehicleModelConfig'

/**
 * AGV_FUTURE 资产的材质→实例部件映射（材质名必须与 GLB 完全一致）。
 * glbPaint 为主车体（可拾取），glbPlatform 承载黑色货舱面板（可拾取），
 * glbStatus 为青色灯带并替换为实例色状态材质，其余保持资产原始 PBR 参数。
 */
export const GLB_MATERIAL_PARTS = {
  Body_Metal_Graphite: 'glbPaint',
  Panel_Black: 'glbPlatform',
  Body_Metal_Silver: 'glbArmor',
  Marking_Satin_Silver: 'glbMetal',
  Rubber_Black: 'glbRubber',
  Sensor_Dark_Glass: 'glbSensor',
  Red_Emissive: 'glbEmergency',
  Cyan_Emissive: 'glbStatus',
  LiDAR_Blue_Emissive: 'glbLidar',
} as const
export type GlbPartKind = typeof GLB_MATERIAL_PARTS[keyof typeof GLB_MATERIAL_PARTS]
export interface IndustrialModel {
  parts: Record<GlbPartKind, { geometry: THREE.BufferGeometry; material: THREE.Material }>
  dispose(): void
}
let binary: Promise<ArrayBuffer> | undefined

/** 资产原朝向为车头 +Z，场景约定车头 +X：合并前绕 Y 旋转 90° 烘入顶点 */
const FORWARD_BAKE_ROTATION_Y = Math.PI / 2
/** 资产车长方向首尾不对称约 3mm，居中校验放宽到厘米级即可接受 */
const CENTERING_TOLERANCE_M = 0.01

export async function loadIndustrialVehicleModel(): Promise<IndustrialModel> {
  const url = new URL(INDUSTRIAL_AGV_MODEL.url, document.baseURI)
  binary ??= fetch(url).then((response) => {
    if (!response.ok) throw new Error(`工业模型加载失败：${response.status}`)
    return response.arrayBuffer()
  }).catch((error: unknown) => { binary = undefined; throw error })
  const gltf = await new GLTFLoader().parseAsync(await binary, new URL('.', url).href)
  gltf.scene.rotation.y = FORWARD_BAKE_ROTATION_Y
  gltf.scene.updateMatrixWorld(true)
  const sourceGeometries = new Set<THREE.BufferGeometry>()
  const sourceMaterials = new Set<THREE.Material>()
  const sourceTextures = new Set<THREE.Texture>()
  const geometryGroups = new Map<GlbPartKind, THREE.BufferGeometry[]>()
  const parts = {} as IndustrialModel['parts']
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
    const config = INDUSTRIAL_AGV_MODEL
    const tolerance = config.dimensionToleranceM
    if (Math.abs(size.x - config.length) > tolerance || Math.abs(size.z - config.width) > tolerance ||
      Math.abs(size.y - config.height) > tolerance || Math.abs(bounds.min.y) > tolerance ||
      Math.abs(bounds.min.x + bounds.max.x) > CENTERING_TOLERANCE_M ||
      Math.abs(bounds.min.z + bounds.max.z) > CENTERING_TOLERANCE_M) {
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
