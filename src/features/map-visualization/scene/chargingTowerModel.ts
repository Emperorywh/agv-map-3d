/**
 * 直接加载交付的完整充电塔，保留原始层级、法线、材质与米制尺寸。
 * 仅缓存二进制；每个图层资源代独立解析，几何和材质在该代内共享并统一释放。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import towerUrl from '../../../../assets/agv_charge_tower_20260907_01/agv_charge_tower.glb?url'
import { GROUND_SURFACE_Y } from './mapAppearance'

let binary: Promise<ArrayBuffer> | undefined

/**
 * 静态导入让 Vite 原样输出 GLB，并自动处理内容哈希及子路径部署。
 * 请求失败清除缓存，下次挂载可以重新加载，不用旧充电柜代替缺失模型。
 */
export async function loadChargingTowers(matrices: Float32Array) {
  binary ??= fetch(towerUrl).then((response) => {
    if (!response.ok) throw new Error(`充电塔模型加载失败：HTTP ${response.status}`)
    return response.arrayBuffer()
  }).catch((error: unknown) => { binary = undefined; throw error })
  const gltf = await new GLTFLoader().parseAsync(await binary, '')
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  const lights: THREE.PointLight[] = []
  const batches: THREE.BatchedMesh[] = []
  const group = new THREE.Group()
  group.name = 'map-charge-towers'
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    group.clear()
    for (const batch of batches) batch.dispose()
    for (const light of lights) light.dispose()
    for (const geometry of geometries) geometry.dispose()
    for (const material of materials) material.dispose()
    for (const texture of textures) texture.dispose()
  }

  try {
    gltf.scene.updateMatrixWorld(true)
    const opaque = new Map<string, { material: THREE.Material; parts: THREE.Mesh<THREE.BufferGeometry, THREE.Material>[] }>()
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      geometries.add(object.geometry)
      const meshMaterials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of meshMaterials) {
        materials.add(material)
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) textures.add(value)
        }
      }
      /**
       * 不透明装甲参与实时投影，透射水晶不投射错误的实心黑影。
       * 保留加载器读出的透明度、透射率、折射率和自发光，不注入淡出或呼吸着色器。
       */
      object.castShadow = meshMaterials.every((material) =>
        !material.transparent && !(material instanceof THREE.MeshPhysicalMaterial && material.transmission > 0),
      )
      object.receiveShadow = true
      /**
       * 不透明部件按原材质合批，只复用顶点与变换，不做减面或材质替换。
       * 水晶仍保留独立网格和原层级，由渲染器维持透明与透射绘制顺序。
       */
      if (object.castShadow && !Array.isArray(object.material)) {
        /**
         * 交付资产中同种金属同时存在带 UV 和不带 UV 的部件，批次还需按顶点布局分组。
         * 保留每种布局原样，避免为合批删除属性，或因缺失 UV 导致加载失败。
         */
        const part = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material>
        const layout = Object.entries(part.geometry.attributes).sort(([a], [b]) => a.localeCompare(b))
          .map(([name, attribute]) => `${name}:${attribute.itemSize}:${attribute.normalized}`).join('|')
        const key = `${object.material.uuid}:${object.geometry.index !== null}:${layout}`
        const entry = opaque.get(key)
        if (entry === undefined) opaque.set(key, { material: part.material, parts: [part] })
        else entry.parts.push(part)
      }
    })

    const placementMatrix = new THREE.Matrix4()
    const partMatrix = new THREE.Matrix4()
    const towerCount = matrices.length / 16
    for (const { material, parts } of opaque.values()) {
      const vertices = parts.reduce((sum, part) => sum + part.geometry.getAttribute('position').count, 0)
      const indices = parts.reduce((sum, part) => sum + (part.geometry.index?.count ?? 0), 0)
      const batch = new THREE.BatchedMesh(towerCount * parts.length, vertices, indices, material)
      batches.push(batch)
      batch.name = `charge-tower-opaque-${material.name}`
      batch.castShadow = true
      batch.receiveShadow = true
      batch.perObjectFrustumCulled = true
      for (const part of parts) {
        const geometryId = batch.addGeometry(part.geometry)
        for (let offset = 0; offset < matrices.length; offset += 16) {
          placementMatrix.fromArray(matrices, offset)
          partMatrix.multiplyMatrices(placementMatrix, part.matrixWorld)
          batch.setMatrixAt(batch.addInstance(geometryId), partMatrix)
        }
      }
      batch.computeBoundingSphere()
      group.add(batch)
    }
    /**
     * 合批完成后从克隆模板摘除不透明网格，防止同时绘制两份装甲。
     * 原始几何与材质继续登记到释放清单，透明模板只共享尚需独立绘制的部件。
     */
    for (const { parts } of opaque.values()) for (const part of parts) part.removeFromParent()

    for (let offset = 0; offset < matrices.length; offset += 16) {
      /**
       * 每座塔保留独立透明网格，由渲染器逐对象排序和剔除，保持水晶遮挡关系。
       * 变换施加在外层容器，原始根节点、部件位置及一比一尺度全部保留。
       */
      const placement = new THREE.Group()
      placement.name = `charge-tower-${offset / 16}`
      placement.matrix.fromArray(matrices, offset)
      placement.matrixAutoUpdate = false
      placement.add(gltf.scene.clone(true))
      /**
       * GLB 的发光不会自动照亮邻近物体，光环高度补充有限距离的蓝色点光源。
       * 强度与照明距离保持原值，只剔除影响范围完全落在画面及倒影外的光源。
       */
      const light = new THREE.PointLight(0x42bfff, 3, 4, 2)
      light.name = 'charge-tower-energy-light'
      light.position.set(0, 2.563, 0)
      lights.push(light)
      placement.add(light)
      group.add(placement)
    }
    group.updateMatrixWorld(true)
    const frustum = new THREE.Frustum()
    const projection = new THREE.Matrix4()
    const influence = new THREE.Sphere()
    const reflectedInfluence = new THREE.Sphere()
    const contributing = new Uint8Array(lights.length)
    /**
     * 光源的四米影响球与主视野、地面镜像视野取并集，屏幕外灯照进画面时仍保留。
     * 额外边距避免视口边缘反复切换；剔除的是无画面贡献的实时灯，不是自发光材质。
     */
    const updateLightVisibility = (camera: THREE.Camera) => {
      camera.updateWorldMatrix(true, false)
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      frustum.setFromProjectionMatrix(projection, camera.coordinateSystem, camera.reversedDepth)
      let visibleCount = 0
      for (let index = 0; index < lights.length; index += 1) {
        const light = lights[index]
        light.getWorldPosition(influence.center)
        influence.radius = light.distance + (contributing[index] ? 1 : 0.5)
        reflectedInfluence.copy(influence)
        reflectedInfluence.center.y = 2 * GROUND_SURFACE_Y - influence.center.y
        contributing[index] = Number(frustum.intersectsSphere(influence) || frustum.intersectsSphere(reflectedInfluence))
        visibleCount += contributing[index]
      }
      /**
       * 灯槽数量按四、八、十六等档位取整，减少移动镜头时逐盏增减引发的着色器重编译。
       * 所有有贡献的灯仍以原强度参与；填充槽亮度为零，不改变可见照明或限制灯数。
       */
      const slotCount = visibleCount === 0 ? 0 : Math.min(lights.length, 2 ** Math.ceil(Math.log2(Math.max(4, visibleCount))))
      let padding = slotCount - visibleCount
      for (let index = 0; index < lights.length; index += 1) {
        const active = contributing[index] === 1
        lights[index].visible = active || padding > 0
        lights[index].intensity = active ? 3 : 0
        if (!active && padding > 0) padding -= 1
      }
    }
    return { group, updateLightVisibility, dispose }
  } catch (error) {
    dispose()
    throw error
  }
}
