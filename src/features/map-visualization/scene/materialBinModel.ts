/**
 * 库区站点使用八箱托盘货物，保留交付 GLB 的层级、贴图及 PBR 材质，运行时校准尺寸与原点。
 * 二进制请求共享缓存，几何与材质由每次加载单独持有，随地图资源代释放。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
/**
 * 近景与两档远景统一使用托盘货物资产，避免视距切换时退回旧货架外观。
 * 沿用库区站点的尺寸校准与底面定位，三档共用同一缩放和原点。
 */
import materialBinUrl from '../../../../assets/agv_shelf_20260907_01/shelf_loaded.glb?url'
import materialBinLod1Url from '../../../../assets/agv_shelf_20260907_01/shelf_loaded_LOD1.glb?url'
import materialBinLod2Url from '../../../../assets/agv_shelf_20260907_01/shelf_loaded_LOD2.glb?url'

const MATERIAL_BIN_WIDTH_M = 1.2
const binaries = new Map<string, Promise<ArrayBuffer>>()

export async function loadMaterialBinModel() {
  const primary = await loadLevel(materialBinUrl)
  const results = await Promise.allSettled([materialBinLod1Url, materialBinLod2Url].map(loadLevel))
  const models = [primary]
  /**
   * 两档低模完整到达后才交接给实例层，失败时保持原模型可用。
   * 已成功解析但不能组成完整档位的资源立即释放，避免上下文恢复累积资源。
   */
  if (results.every((result) => result.status === 'fulfilled')) {
    for (const result of results) if (result.status === 'fulfilled') models.push(result.value)
  } else {
    for (const result of results) if (result.status === 'fulfilled') result.value.dispose()
    console.warn('料箱低模不可用，保留精修模型')
  }
  const dispose = () => { for (const model of models) model.dispose() }
  try {
    /**
     * 三档共用原模型的米制缩放与底面中心，不分别归一化减面后的包围盒。
     * 这样切换档位不会出现平移、缩放或高度跳动，地图节点坐标保持一致。
     * 保留资产原始朝向，由各库位按接入路径独立旋转，脚底仍贴合地坪。
     */
    const bounds = new THREE.Box3().setFromObject(primary.scene, true)
    const size = bounds.getSize(new THREE.Vector3())
    const width = Math.max(size.x, size.z)
    if (bounds.isEmpty() || !Number.isFinite(width) || width <= 0) throw new Error('料箱模型尺寸无效')
    const center = bounds.getCenter(new THREE.Vector3())
    const origin = new THREE.Vector3(center.x, bounds.min.y, center.z)
    const groups = models.map((model) => {
      const group = new THREE.Group()
      model.scene.position.sub(origin)
      group.scale.setScalar(MATERIAL_BIN_WIDTH_M / width)
      group.add(model.scene)
      return group
    })
    return { group: groups[0], lodGroups: groups.slice(1), dispose }
  } catch (error) {
    dispose()
    throw error
  }
}

/**
 * 文件字节按地址缓存，几何、材质和贴图由每次加载独立持有。
 * 主模型与低模使用相同材质校准，最终合批统一复用主模型材质。
 */
async function loadLevel(url: string) {
  let binary = binaries.get(url)
  binary ??= fetch(url).then((response) => {
    if (!response.ok) throw new Error(`料箱模型加载失败：HTTP ${response.status}`)
    return response.arrayBuffer()
  }).catch((error: unknown) => { binaries.delete(url); throw error })
  binaries.set(url, binary)
  const gltf = await new GLTFLoader().parseAsync(await binary, '')
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const geometry of geometries) geometry.dispose()
    for (const material of materials) material.dispose()
    for (const texture of textures) texture.dispose()
  }
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    object.castShadow = true
    object.receiveShadow = true
    geometries.add(object.geometry)
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material)
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value)
    }
  })
  /**
   * 满载货架使用自身的材质名称校准，将白漆降为哑光浅灰，保留箱体与标签贴图。
   * 所有部件关闭自发光并降低环境反射，避免架体在厂房顶光下呈现灯带般的亮边。
   * 按集合逐材质处理，多个箱体共用的材质只校准一次，近中远三档外观保持一致。
   */
  for (const material of materials) {
    if (!(material instanceof THREE.MeshStandardMaterial)) continue
    /**
     * 新托盘货物已包含正确的基础色、粗糙度、织纹及印刷透明裁切。
     * 跳过旧货架的统一哑光校准，保留主体 #9AB5F6 与半哑光工业涂层。
     */
    if (material.name.startsWith('Cargo_')) continue
    material.emissive.set(0x000000)
    material.emissiveIntensity = 0
    material.metalness = 0
    material.roughness = 0.95
    material.envMapIntensity = 0.12
    if (material.name === 'PowderCoat_OffWhite') material.color.set('#a5adae')
    else if (material.name === 'Label_Ivory') material.color.set('#b9b6aa')
    /**
     * 场景泛光按最高颜色通道提取亮区，仅关闭自发光仍可能被强光反射触发。
     * 货架在输出前将线性亮度限制为一，低于一点二的泛光阈值，保留正常受光与阴影。
     */
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
        outgoingLight = min(outgoingLight, vec3(1.0));
        #include <opaque_fragment>
      `)
    }
    material.customProgramCacheKey = () => 'warehouse-shelf-matte-v1'
  }
  return { scene: gltf.scene, dispose }
}
