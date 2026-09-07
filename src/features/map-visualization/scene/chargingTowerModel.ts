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
export async function loadChargingTowers(matrices: Float32Array, lightBudget = 8) {
  binary ??= fetch(towerUrl).then((response) => {
    if (!response.ok) throw new Error(`充电塔模型加载失败：HTTP ${response.status}`)
    return response.arrayBuffer()
  }).catch((error: unknown) => { binary = undefined; throw error })
  const gltf = await new GLTFLoader().parseAsync(await binary, '')
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  const lights: THREE.PointLight[] = []
  const instances: THREE.InstancedMesh[] = []
  /**
   * 塔体发光保持完整，实时照明只分配固定数量的灯槽。
   * 每座塔保存静态灯位，镜头变化时再选择有画面贡献的近处灯位。
   */
  const lightPositions: THREE.Vector3[] = []
  const batches: THREE.BatchedMesh[] = []
  const group = new THREE.Group()
  group.name = 'map-charge-towers'
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    group.clear()
    for (const mesh of instances) mesh.dispose()
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
       * 静态模型只计算一次局部矩阵，保留全部透明部件与材质。
       * 灯位单独保存，避免每座塔都给所有受光材质增加一盏实时灯。
       */
      placement.traverse((object) => { if (object.matrixAutoUpdate) object.updateMatrix(); object.matrixAutoUpdate = false })
      lightPositions.push(new THREE.Vector3(0, 2.563, 0).applyMatrix4(placement.matrix))
      group.add(placement)
    }
    /**
     * 灯槽始终可见，空槽强度为零；相机移动不改变着色器中的点光源数量。
     * 未分配实时灯的塔仍保留水晶自发光和合批地面光斑，保证设施位置可辨。
     */
    for (let index = 0; index < Math.min(lightBudget, lightPositions.length); index += 1) {
      const light = new THREE.PointLight(0x42bfff, 0, 4, 2)
      light.name = 'charge-tower-energy-light'
      lights.push(light)
      group.add(light)
    }
    /**
     * 单张小型径向纹理供全部光斑共享，柔和衰减避免出现硬边圆盘。
     * 纹理不依赖图片请求，随塔体资源统一释放。
     */
    const glowPixels = new Uint8Array(32 * 32 * 4)
    for (let y = 0; y < 32; y += 1) for (let x = 0; x < 32; x += 1) {
      const offset = (y * 32 + x) * 4
      glowPixels[offset] = glowPixels[offset + 1] = glowPixels[offset + 2] = 255
      glowPixels[offset + 3] = Math.round(255 * Math.max(0, 1 - Math.hypot((x - 15.5) / 15.5, (y - 15.5) / 15.5)) ** 2)
    }
    const glowTexture = new THREE.DataTexture(glowPixels, 32, 32)
    glowTexture.magFilter = THREE.LinearFilter
    glowTexture.needsUpdate = true
    textures.add(glowTexture)
    const glowGeometry = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2)
    const glowMaterial = new THREE.MeshBasicMaterial({ color: 0x42bfff, map: glowTexture, transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending })
    geometries.add(glowGeometry)
    materials.add(glowMaterial)
    const glow = new THREE.InstancedMesh(glowGeometry, glowMaterial, towerCount)
    instances.push(glow)
    glow.name = 'charge-tower-ground-glow'
    glow.renderOrder = 8
    glow.raycast = () => {}
    for (let index = 0; index < towerCount; index += 1) {
      placementMatrix.makeScale(1.6, 1, 1.6).setPosition(lightPositions[index].x, GROUND_SURFACE_Y + 0.006, lightPositions[index].z)
      glow.setMatrixAt(index, placementMatrix)
    }
    glow.computeBoundingSphere()
    group.add(glow)
    group.updateMatrixWorld(true)
    const frustum = new THREE.Frustum()
    const projection = new THREE.Matrix4()
    const influence = new THREE.Sphere()
    const reflectedInfluence = new THREE.Sphere()
    const contributing = new Uint8Array(lightPositions.length)
    const cameraWorld = new THREE.Matrix4()
    const cameraProjection = new THREE.Matrix4()
    const cameraPosition = new THREE.Vector3()
    const candidates: number[] = []
    const scores = new Float64Array(lightPositions.length)
    let initialized = false
    /**
     * 光源影响球与主视野、地面镜像视野取并集，屏幕外照进画面的灯仍有候选资格。
     * 从候选中按预算分配实时灯，未入选的塔继续显示自发光与合批地面光斑。
     */
    const updateLightVisibility = (camera: THREE.Camera) => {
      camera.updateWorldMatrix(true, false)
      if (initialized && cameraWorld.equals(camera.matrixWorld) && cameraProjection.equals(camera.projectionMatrix)) return
      initialized = true
      cameraWorld.copy(camera.matrixWorld)
      cameraProjection.copy(camera.projectionMatrix)
      cameraPosition.setFromMatrixPosition(camera.matrixWorld)
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      frustum.setFromProjectionMatrix(projection, camera.coordinateSystem, camera.reversedDepth)
      candidates.length = 0
      for (let index = 0; index < lightPositions.length; index += 1) {
        influence.center.copy(lightPositions[index])
        influence.radius = 4.5
        reflectedInfluence.copy(influence)
        reflectedInfluence.center.y = 2 * GROUND_SURFACE_Y - influence.center.y
        if (frustum.intersectsSphere(influence) || frustum.intersectsSphere(reflectedInfluence)) {
          scores[index] = influence.center.distanceToSquared(cameraPosition) * (contributing[index] ? 0.85 : 1)
          candidates.push(index)
        }
      }
      /**
       * 最近的有效灯位优先，已分配灯位给予滞回权重，避免相邻塔来回抢占灯槽。
       * 空槽只清零强度，不隐藏对象，保持程序变体数量稳定。
       */
      candidates.sort((a, b) => scores[a] - scores[b] || a - b)
      contributing.fill(0)
      for (let index = 0; index < lights.length; index += 1) {
        const target = candidates[index]
        lights[index].intensity = target === undefined ? 0 : 3
        if (target !== undefined) {
          contributing[target] = 1
          lights[index].position.copy(lightPositions[target])
        }
      }
    }
    return { group, updateLightVisibility, dispose }
  } catch (error) {
    dispose()
    throw error
  }
}
