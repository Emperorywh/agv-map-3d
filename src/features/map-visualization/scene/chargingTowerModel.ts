/**
 * 充电塔以整塔材质部件实例化，按距离切换三档几何并限制远景水晶的透射开销。
 * 几何、材质与光源在资源代内共享并统一释放，近景保留原资产尺寸和真实水晶。
 * 塔基发光底环叠加低频呼吸脉冲（P2-1），总览投影过小时整体淡出。
 */
import * as THREE from 'three'
import {
  CHARGE_RING_FADE_END_PX,
  CHARGE_RING_FADE_START_PX,
  CHARGE_RING_INNER_RADIUS_M,
  CHARGE_RING_LIFT_M,
  CHARGE_RING_OPACITY,
  CHARGE_RING_OUTER_RADIUS_M,
  CHARGE_RING_PULSE_MIN_BRIGHTNESS,
  CHARGE_RING_PULSE_PERIOD_S,
  GROUND_SURFACE_Y,
} from './mapAppearance'
import {
  createScreenSizeFadeUniforms,
  injectBrightnessPulse,
  injectScreenSizeFade,
  type PulseUniforms,
  type ScreenSizeFadeUniforms,
} from './semanticMaterials'
import { loadChargingTowerAsset } from './chargingTowerAsset'
import { StaticLodBatch } from '@/shared/rendering/staticLodBatch'
import { setReflectionMaterial } from '@/shared/rendering/reflectionMaterials'

/** 图层逐帧写入的共享 uniforms：底环淡出与脉冲的帧驱动入口 */
export interface ChargingTowerFrameUniforms {
  /** 底环投影尺寸淡出：视口高度（像素）由图层逐帧写入 */
  readonly ringFade: ScreenSizeFadeUniforms
  /** 底环亮度脉冲：单调累计秒由图层逐帧写入 */
  readonly ringPulse: PulseUniforms
}

/**
 * 资产加载器负责字节缓存与三档几何，场景句柄只装配静态实例和灯位。
 * 水晶材质在收集渲染列表之前选择，倒影采集期间临时使用简化版本。
 */
export async function loadChargingTowers(matrices: Float32Array, lightBudget = 8, lodPixels: readonly [number, number] = [180, 60], crystalPixels = 160, crystalLimit = 1) {
  const asset = await loadChargingTowerAsset()
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
  /**
   * 记录每座塔水晶自身的世界包围球，透射资格按真实水晶投影和主视锥计算。
   * 灯光影响范围仍单独维护，屏幕外补光不会误触发全场景透射预渲染。
   */
  const crystalBounds: THREE.Sphere[] = []
  const crystalMeshes: { mesh: THREE.Mesh; original: THREE.Material; simplified: THREE.Material; tower: number }[] = []
  const simplifiedMaterials = new Map<THREE.Material, THREE.MeshStandardMaterial>()
  const detailedCrystals = new Uint8Array(matrices.length / 16)
  const batches: StaticLodBatch[] = []
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
    asset.dispose()
  }

  try {
    const placementMatrix = new THREE.Matrix4()
    const towerCount = matrices.length / 16
    /**
     * 同材质小部件已合成整塔几何，批内按塔剔除，避免每个螺钉都做排序和视锥判断。
     * 全档位保留低模供辅助通道使用，主画面继续按自己的画质阈值选择几何。
     */
    for (const part of asset.opaque.values()) {
      const levels = [part.geometry, ...(part.lodGeometries ?? [])]
      const batch = new StaticLodBatch(levels, part.material, matrices, 3.6, lodPixels)
      batches.push(batch)
      batch.name = `charge-tower-opaque-${part.material.name}`
      group.add(batch)
    }

    /**
     * 水晶几何已经烘焙到整塔坐标，合并包围盒后只需应用各塔的放置矩阵。
     * 这里只在加载阶段计算，镜头变化时复用包围球，不扫描水晶顶点。
     */
    const crystalBox = new THREE.Box3()
    for (const part of asset.crystals) {
      part.geometry.computeBoundingBox()
      crystalBox.union(part.geometry.boundingBox!)
    }
    const crystalSphere = crystalBox.getBoundingSphere(new THREE.Sphere())
    for (let offset = 0; offset < matrices.length; offset += 16) {
      /**
       * 每座塔保留独立水晶网格以维持对象排序，烘焙几何和原材质继续共享。
       * 远景和倒影采用单次绘制的半透明受光材质，不再为水晶重复采集整个场景。
       */
      const placement = new THREE.Group()
      placement.name = `charge-tower-${offset / 16}`
      placement.matrix.fromArray(matrices, offset)
      placement.matrixAutoUpdate = false
      crystalBounds.push(crystalSphere.clone().applyMatrix4(placement.matrix))
      for (const part of asset.crystals) {
        let simplified = simplifiedMaterials.get(part.material)
        if (simplified === undefined) {
          simplified = new THREE.MeshStandardMaterial()
          if (part.material instanceof THREE.MeshStandardMaterial) simplified.copy(part.material)
          simplified.name = `${part.material.name}-simplified`
          simplified.transparent = true
          simplified.opacity = Math.min(part.material.opacity, 0.5)
          simplified.depthWrite = false
          simplified.forceSinglePass = true
          simplifiedMaterials.set(part.material, simplified)
          materials.add(simplified)
        }
        const mesh = new THREE.Mesh(part.geometry, simplified)
        mesh.name = `charge-tower-crystal-${offset / 16}`
        mesh.receiveShadow = true
        mesh.matrixAutoUpdate = false
        mesh.raycast = () => {}
        setReflectionMaterial(mesh, simplified)
        crystalMeshes.push({ mesh, original: part.material, simplified, tower: offset / 16 })
        placement.add(mesh)
      }
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
    /**
     * 塔基发光底环（P2-1）：静态地面光斑之上的呼吸圆环，环抱塔基。
     * 投影尺寸淡出与亮度脉冲都注入共享材质（纯 GPU 完成），59 处底环在总览
     * 同步渐隐、中近景同步呼吸；淡出作用于 alpha、脉冲调制 rgb，可复合注入。
     */
    const ringFadeUniforms = createScreenSizeFadeUniforms(CHARGE_RING_OUTER_RADIUS_M * 2)
    ringFadeUniforms.uFadeStartPx.value = CHARGE_RING_FADE_START_PX
    ringFadeUniforms.uFadeEndPx.value = CHARGE_RING_FADE_END_PX
    const ringPulseUniforms: PulseUniforms = {
      uTime: { value: 0 },
      uPulsePeriod: { value: CHARGE_RING_PULSE_PERIOD_S },
      uPulseMin: { value: CHARGE_RING_PULSE_MIN_BRIGHTNESS },
    }
    const ringGeometry = new THREE.RingGeometry(
      CHARGE_RING_INNER_RADIUS_M,
      CHARGE_RING_OUTER_RADIUS_M,
      48,
    ).rotateX(-Math.PI / 2)
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x42bfff,
      transparent: true,
      opacity: CHARGE_RING_OPACITY,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    injectScreenSizeFade(ringMaterial, ringFadeUniforms, 'map-charge-ring')
    injectBrightnessPulse(ringMaterial, ringPulseUniforms, 'map-charge-ring-pulse')
    geometries.add(ringGeometry)
    materials.add(ringMaterial)
    const ring = new THREE.InstancedMesh(ringGeometry, ringMaterial, towerCount)
    instances.push(ring)
    ring.name = 'charge-tower-base-ring'
    ring.renderOrder = 8
    ring.raycast = () => {}
    for (let index = 0; index < towerCount; index += 1) {
      placementMatrix.identity().setPosition(lightPositions[index].x, GROUND_SURFACE_Y + CHARGE_RING_LIFT_M, lightPositions[index].z)
      ring.setMatrixAt(index, placementMatrix)
    }
    ring.computeBoundingSphere()
    group.add(ring)
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
    /**
     * 透射候选独立于点光源候选，优先保留画面中最大的水晶并为既有入选者留滞回。
     * 数组和分值缓冲跨帧复用，镜头静止时沿用原有整体提前返回。
     */
    const crystalCandidates: number[] = []
    const crystalScores = new Float64Array(lightPositions.length)
    let initialized = false
    let cameraHeight = 0
    /**
     * 光源影响球与主视野、地面镜像视野取并集，屏幕外照进画面的灯仍有候选资格。
     * 从候选中按预算分配实时灯，未入选的塔继续显示自发光与合批地面光斑。
     */
    const updateForCamera = (camera: THREE.Camera, viewportHeight: number) => {
      camera.updateWorldMatrix(true, false)
      if (initialized && cameraHeight === viewportHeight && cameraWorld.equals(camera.matrixWorld) && cameraProjection.equals(camera.projectionMatrix)) return
      initialized = true
      cameraHeight = viewportHeight
      cameraWorld.copy(camera.matrixWorld)
      cameraProjection.copy(camera.projectionMatrix)
      cameraPosition.setFromMatrixPosition(camera.matrixWorld)
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      frustum.setFromProjectionMatrix(projection, camera.coordinateSystem, camera.reversedDepth)
      candidates.length = 0
      crystalCandidates.length = 0
      const view = camera.matrixWorldInverse.elements
      const factor = viewportHeight * Math.abs(camera.projectionMatrix.elements[5])
      for (let index = 0; index < lightPositions.length; index += 1) {
        /**
         * 用水晶自身的包围球估算屏幕直径，避免较大的整塔轮廓过早启用真实透射。
         * 仅主视锥内且达到尺寸门槛的水晶进入候选，性能档零限额直接跳过。
         */
        const sphere = crystalBounds[index]
        const position = sphere.center
        const depth = -(view[2] * position.x + view[6] * position.y + view[10] * position.z + view[14])
        const pixels = camera instanceof THREE.PerspectiveCamera ? depth > 0 ? factor * sphere.radius / depth : 0 : factor * sphere.radius
        if (crystalLimit > 0 && frustum.intersectsSphere(sphere) && pixels >= crystalPixels * (detailedCrystals[index] ? 0.85 : 1.15)) {
          crystalScores[index] = pixels * (detailedCrystals[index] ? 1.15 : 1)
          crystalCandidates.push(index)
        }
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
       * 均衡档最多保留一座近景塔的真实水晶，其余保持发光、透明轮廓和独立排序。
       * 在渲染列表收集前完成材质选择，无合格候选时不会创建透射预通道。
       */
      crystalCandidates.sort((a, b) => crystalScores[b] - crystalScores[a] || a - b)
      detailedCrystals.fill(0)
      for (let slot = 0; slot < Math.min(crystalCandidates.length, crystalLimit); slot += 1) detailedCrystals[crystalCandidates[slot]] = 1
      for (const entry of crystalMeshes) entry.mesh.material = detailedCrystals[entry.tower] ? entry.original : entry.simplified
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
    return {
      group,
      updateForCamera,
      /** 底环帧驱动 uniforms：图层 useFrame 逐帧写入视口高度与时间 */
      frameUniforms: { ringFade: ringFadeUniforms, ringPulse: ringPulseUniforms } satisfies ChargingTowerFrameUniforms,
      dispose,
    }
  } catch (error) {
    dispose()
    throw error
  }
}
