/**
 * 地标语义图层（SPEC §2.1、§5.1、§6.5；TASK-005；P2-1 充电表达增强、
 * P2-2 停车凸起 slab）。
 *
 * 职责：把 buildLandmarkData 的纯数据一次性上载为静态合批 GPU 对象——
 *       - 停车凸起 slab（P2-2：紫色薄板抬升 4cm）与微光光晕（加法混合外沿）；
 *       - 充电桩立柱 InstancedMesh（青色，投射实时阴影 P0-8）与底部光环；
 *       - 充电呼吸灯 InstancedMesh（正弦亮度脉动，受 decorationsEnabled 开关）；
 *       - 充电闪电贴花 InstancedMesh（P2-1：桩身四面青色闪电，单格 Canvas
 *         图集，Canvas 不可用时整体降级为不创建）；
 *       - 名称四边形合批 Mesh（停车 P 字形等，图集纹理 + 距离淡出；仓库节点
 *         名称已按视觉差距分析 P0-5 整体移除，机制原样保留）。
 *       充电立柱/光环/贴花共享投影尺寸 LOD 淡出（P2-1/8.4：59 处充电元素在
 *       总览同步渐隐，不成排发光抢戏），光环另复合呼吸脉冲（与灯球同周期）。
 * 边界：实例/几何数据由 buildLandmarkData 提供，图集纹理由 Feature 根组件
 *       （单一所有者）注入，本组件只消费不释放图集；本组件创建的全部
 *       geometry/material/实例缓冲在卸载或数据更换时对称释放。
 * 关键不变量：
 * 1. 每类地标恰好一个 Draw Call（slab/光晕/立柱/光环/贴花/呼吸灯/名称各一
 *    个对象），实例差异全部由矩阵与实例颜色表达，静态上载一次后不再逐帧改
 *    写；
 * 2. 呼吸脉动与 LOD 淡出只写 uniforms（uTime/uPulseEnabled/uViewportHeightPx），
 *    不触碰实例缓冲、不进 React state——decorationsEnabled=false 时
 *    uPulseEnabled=0，呼吸灯与底环恒定全亮，其余地标不受影响；
 * 3. 图集为 null（创建失败降级）或名称 key 未入图集（容量隔离）时，名称
 *    Mesh 整体不创建——缺名称不缺地标；闪电贴花 Canvas 不可用时同样整体
 *    降级（缺贴花不缺充电桩），地图其余语义完整；
 * 4. 资源对称释放：useMemo 创建、effect 清理释放，StrictMode 双执行不泄漏。
 */
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import type { MapModel } from '../model/types'
import type { WorldTransform } from '@/shared/spatial'
import { buildLandmarkData, type LandmarkData } from '../scene/buildLandmarkData'
import {
  buildChargeBoltGeometry,
  createChargeBoltTexture,
} from '../scene/chargeBolt'
import {
  buildNameQuadGeometry,
  PARK_GLYPH_KEY,
  type MapNameAtlas,
  type NameQuadInput,
} from '../scene/mapNameAtlas'
import {
  createChargeFadeMaterial,
  createChargeFadePulseMaterial,
  createNameFadeMaterial,
  createPulseMaterial,
  type PulseUniforms,
  type ScreenSizeFadeUniforms,
} from '../scene/semanticMaterials'
import {
  CHARGE_FADE_END_PX,
  CHARGE_FADE_START_PX,
  CHARGE_LIGHT_COLOR,
  CHARGE_LIGHT_MIN_BRIGHTNESS,
  CHARGE_LIGHT_PERIOD_S,
  CHARGE_LIGHT_SIZE_M,
  CHARGE_PILE_COLOR,
  CHARGE_PILE_DEPTH_M,
  CHARGE_PILE_HEIGHT_M,
  CHARGE_PILE_WIDTH_M,
  CHARGE_RING_COLOR,
  CHARGE_RING_INNER_M,
  CHARGE_RING_OPACITY,
  CHARGE_RING_OUTER_M,
  CHARGE_RING_PULSE_MIN_BRIGHTNESS,
  LANDMARK_NAME_FADE_FAR_M,
  LANDMARK_NAME_FADE_NEAR_M,
  NAME_QUAD_Y,
  NODE_COLORS,
  PARK_GLYPH_HEIGHT_M,
  PARK_SLAB_HALO_LIFT_M,
  PARK_SLAB_HALO_OPACITY,
  PARK_SLAB_HEIGHT_M,
  PARK_SLAB_OPACITY,
} from '../scene/mapAppearance'

export interface LandmarksLayerProps {
  readonly mapModel: MapModel
  readonly worldTransform: WorldTransform
  /** 地图名称图集；null 表示名称降级不可用（地标其余部分不受影响） */
  readonly nameAtlas: MapNameAtlas | null
  /** 装饰动画能力开关：false 时呼吸灯恒定全亮（SPEC §6.5 预留） */
  readonly decorationsEnabled: boolean
}

/** 组件自建 GPU 资源集合：合批对象 + 帧 uniforms + 释放清单 */
interface LandmarkResources {
  /** 资源代序号：每次重建递增，作为 primitive 的 key 强制走卸载/挂载路径 */
  readonly id: number
  parkSlabs: THREE.InstancedMesh
  parkHalos: THREE.InstancedMesh
  piles: THREE.InstancedMesh
  rings: THREE.InstancedMesh
  /** 闪电贴花；Canvas 不可用（降级）时为 null */
  bolts: THREE.InstancedMesh | null
  lights: THREE.InstancedMesh
  /** 名称合批 Mesh；图集不可用时为 null */
  names: THREE.Mesh | null
  /** 充电元素 LOD 淡出 uniforms（桩/环/贴花各自一份，逐帧写视口高度） */
  fadeUniforms: ScreenSizeFadeUniforms[]
  /** 脉冲 uniforms（呼吸灯 + 底环），逐帧写时间与开关 */
  pulseUniforms: PulseUniforms[]
  /** 创建的全部 geometry/material（不含外部图集纹理），释放责任清单 */
  owned: { dispose(): void }[]
}

/** 资源代计数器：本模块内单调递增，保证 key 随资源重建而变化 */
let landmarkResourcesSeq = 0

export function LandmarksLayer({
  mapModel,
  worldTransform,
  nameAtlas,
  decorationsEnabled,
}: LandmarksLayerProps) {
  const data = useMemo(
    () => buildLandmarkData(mapModel, worldTransform),
    [mapModel, worldTransform],
  )
  const resources = useMemo(
    () => createLandmarkResources(data, nameAtlas, decorationsEnabled),
    [data, nameAtlas, decorationsEnabled],
  )
  useEffect(() => () => disposeLandmarkResources(resources), [resources])

  // 呼吸脉动与 LOD 淡出：每帧只写 uniforms；开关即时生效，不触碰实例缓冲
  const enabledRef = useRef(decorationsEnabled)
  enabledRef.current = decorationsEnabled
  useFrame(({ clock, size }) => {
    for (const fade of resources.fadeUniforms) {
      fade.uViewportHeightPx.value = size?.height ?? 0
    }
    const enabled = enabledRef.current ? 1 : 0
    for (const pulse of resources.pulseUniforms) {
      pulse.uTime.value = clock.elapsedTime
      pulse.uPulseEnabled.value = enabled
    }
  })

  return (
    <>
      {/* dispose={null}：全部对象由本组件 effect 显式释放，禁止 R3F 二次释放。
          key 随资源代变化：R3F 对已有 primitive 的 object 换新依赖「兄弟序列
          尾部」探测，与条件渲染子元素组合时重建会被静默丢弃（实测）；
          key 变化强制 React 走干净的卸载/挂载路径，旧对象必然离场。 */}
      <primitive key={`park-slabs-${resources.id}`} object={resources.parkSlabs} dispose={null} />
      <primitive key={`park-halos-${resources.id}`} object={resources.parkHalos} dispose={null} />
      <primitive key={`piles-${resources.id}`} object={resources.piles} dispose={null} />
      <primitive key={`rings-${resources.id}`} object={resources.rings} dispose={null} />
      {resources.bolts !== null ? (
        <primitive key={`bolts-${resources.id}`} object={resources.bolts} dispose={null} />
      ) : null}
      <primitive key={`lights-${resources.id}`} object={resources.lights} dispose={null} />
      {resources.names !== null ? (
        <primitive key={`names-${resources.id}`} object={resources.names} dispose={null} />
      ) : null}
    </>
  )
}

/** 上载静态实例数据并创建全部地标 GPU 对象（一次构建、静态不再改写） */
function createLandmarkResources(
  data: LandmarkData,
  atlas: MapNameAtlas | null,
  decorationsEnabled: boolean,
): LandmarkResources {
  const owned: { dispose(): void }[] = []
  const fadeUniforms: ScreenSizeFadeUniforms[] = []
  const pulseUniforms: PulseUniforms[] = []
  const id = ++landmarkResourcesSeq

  // —— 停车凸起 slab（P2-2）：单位盒底面烘焙在 y=0，矩阵给足迹/板厚；紫色 ——
  const slabGeometry = new THREE.BoxGeometry(1, 1, 1)
  slabGeometry.translate(0, 0.5, 0)
  owned.push(slabGeometry)
  const slabMaterial = new THREE.MeshBasicMaterial({
    color: NODE_COLORS.park,
    transparent: true,
    opacity: PARK_SLAB_OPACITY,
    depthWrite: false,
  })
  owned.push(slabMaterial)
  const parkSlabs = new THREE.InstancedMesh(slabGeometry, slabMaterial, Math.max(data.parkSlabCount, 0))
  parkSlabs.name = 'map-park-slabs'
  uploadStaticInstances(parkSlabs, data.parkSlabCount, data.parkSlabMatrices, null)
  owned.push(parkSlabs)

  // —— 停车微光光晕（P2-2）：slab 外沿一圈加法混合贴面，抬升到 slab 顶之上 ——
  const haloGeometry = new THREE.PlaneGeometry(1, 1)
  haloGeometry.rotateX(-Math.PI / 2)
  haloGeometry.translate(0, PARK_SLAB_HEIGHT_M + PARK_SLAB_HALO_LIFT_M, 0)
  owned.push(haloGeometry)
  const haloMaterial = new THREE.MeshBasicMaterial({
    color: NODE_COLORS.park,
    transparent: true,
    opacity: PARK_SLAB_HALO_OPACITY,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  owned.push(haloMaterial)
  const parkHalos = new THREE.InstancedMesh(haloGeometry, haloMaterial, Math.max(data.parkSlabCount, 0))
  parkHalos.name = 'map-park-halos'
  uploadStaticInstances(parkHalos, data.parkSlabCount, data.parkHaloMatrices, null)
  owned.push(parkHalos)

  // —— 充电桩立柱：几何底部对齐地面，实例矩阵仅平移；投射实时阴影（P0-8）；
  //     材质带投影尺寸 LOD 淡出（P2-1：总览 59 处立柱不成排抢戏） ——
  const pileGeometry = new THREE.BoxGeometry(
    CHARGE_PILE_WIDTH_M,
    CHARGE_PILE_HEIGHT_M,
    CHARGE_PILE_DEPTH_M,
  )
  pileGeometry.translate(0, CHARGE_PILE_HEIGHT_M / 2, 0)
  owned.push(pileGeometry)
  const pileMaterial = createChargeFadeMaterial({ color: CHARGE_PILE_COLOR })
  tuneChargeFade(pileMaterial.uniforms)
  fadeUniforms.push(pileMaterial.uniforms)
  owned.push(pileMaterial.material)
  const piles = new THREE.InstancedMesh(pileGeometry, pileMaterial.material, Math.max(data.chargeCount, 0))
  piles.name = 'map-charge-piles'
  piles.castShadow = true
  uploadStaticInstances(piles, data.chargeCount, data.chargeMatrices, null)
  owned.push(piles)

  // —— 充电桩底部光环：平贴地面圆环，透明青色；LOD 淡出 + 呼吸脉冲（P2-1） ——
  const ringGeometry = new THREE.RingGeometry(CHARGE_RING_INNER_M, CHARGE_RING_OUTER_M, 24)
  ringGeometry.rotateX(-Math.PI / 2)
  owned.push(ringGeometry)
  const ringMaterial = createChargeFadePulseMaterial(
    CHARGE_RING_COLOR,
    CHARGE_LIGHT_PERIOD_S,
    CHARGE_RING_PULSE_MIN_BRIGHTNESS,
  )
  ringMaterial.material.opacity = CHARGE_RING_OPACITY
  // 开关初值即刻生效（首帧前与 useFrame 写入同一 uniforms 对象）
  ringMaterial.uniforms.uPulseEnabled.value = decorationsEnabled ? 1 : 0
  ringMaterial.uniforms.uPulsePeriod.value = CHARGE_LIGHT_PERIOD_S
  ringMaterial.uniforms.uPulseMin.value = CHARGE_RING_PULSE_MIN_BRIGHTNESS
  tuneChargeFade(ringMaterial.uniforms)
  fadeUniforms.push(ringMaterial.uniforms)
  pulseUniforms.push(ringMaterial.uniforms)
  owned.push(ringMaterial.material)
  const rings = new THREE.InstancedMesh(ringGeometry, ringMaterial.material, Math.max(data.chargeCount, 0))
  rings.name = 'map-charge-rings'
  uploadStaticInstances(rings, data.chargeCount, data.chargeMatrices, null)
  owned.push(rings)

  // —— 桩身闪电贴花（P2-1）：单格 Canvas 图集 + 四面合并几何；renderOrder
  //    高于立柱（透明队列同距离时后绘制），Canvas 不可用时整体降级为 null ——
  let bolts: THREE.InstancedMesh | null = null
  const boltTexture = createChargeBoltTexture()
  if (boltTexture !== null) {
    const boltGeometry = buildChargeBoltGeometry()
    // 基础色白：实际颜色全部来自图集纹理（青色闪电 + 深描边）
    const boltMaterial = createChargeFadeMaterial({ map: boltTexture, color: '#ffffff' })
    boltMaterial.material.name = 'map-charge-bolt'
    tuneChargeFade(boltMaterial.uniforms)
    fadeUniforms.push(boltMaterial.uniforms)
    owned.push(boltGeometry, boltTexture, boltMaterial.material)
    bolts = new THREE.InstancedMesh(boltGeometry, boltMaterial.material, Math.max(data.chargeCount, 0))
    bolts.name = 'map-charge-bolts'
    bolts.renderOrder = 1
    uploadStaticInstances(bolts, data.chargeCount, data.chargeMatrices, null)
    owned.push(bolts)
  }

  // —— 呼吸灯：灯球位置烘焙进几何（桩顶），脉动只经 uniforms 驱动 ——
  const lightGeometry = new THREE.SphereGeometry(
    CHARGE_LIGHT_SIZE_M / 2,
    12,
    8,
  )
  lightGeometry.translate(0, CHARGE_PILE_HEIGHT_M + CHARGE_LIGHT_SIZE_M / 2, 0)
  owned.push(lightGeometry)
  const pulse = createPulseMaterial(CHARGE_LIGHT_COLOR)
  // 开关初值即刻生效（首帧前与 useFrame 写入同一 uniforms 对象）
  pulse.uniforms.uPulseEnabled.value = decorationsEnabled ? 1 : 0
  pulse.uniforms.uPulsePeriod.value = CHARGE_LIGHT_PERIOD_S
  pulse.uniforms.uPulseMin.value = CHARGE_LIGHT_MIN_BRIGHTNESS
  pulseUniforms.push(pulse.uniforms)
  owned.push(pulse.material)
  const lights = new THREE.InstancedMesh(lightGeometry, pulse.material, Math.max(data.chargeCount, 0))
  lights.name = 'map-charge-lights'
  uploadStaticInstances(lights, data.chargeCount, data.chargeMatrices, null)
  owned.push(lights)

  // —— 名称四边形：停车字形与图集单元 join 后静态合批（P0-5：仓库节点名称
  //    已整体移除——Reference 中不存在仓库名称文字，1185 个名称在中景形成
  //    黄色文字海；名称机制（图集/淡出）原样保留给其余地标名称）
  let names: THREE.Mesh | null = null
  if (atlas !== null) {
    const inputs: NameQuadInput[] = []
    for (const anchor of data.parkAnchors) {
      const cell = atlas.cells.get(PARK_GLYPH_KEY)
      if (cell === undefined) {
        continue
      }
      inputs.push({ x: anchor.x, z: anchor.z, cell, heightM: PARK_GLYPH_HEIGHT_M })
    }
    if (inputs.length > 0) {
      const namesGeometry = buildNameQuadGeometry(inputs, NAME_QUAD_Y)
      const namesMaterial = createNameFadeMaterial(
        atlas.texture,
        LANDMARK_NAME_FADE_NEAR_M,
        LANDMARK_NAME_FADE_FAR_M,
      )
      names = new THREE.Mesh(namesGeometry, namesMaterial)
      names.name = 'map-landmark-names'
      names.matrixAutoUpdate = false
      owned.push(namesGeometry, namesMaterial)
    }
  }

  return {
    id,
    parkSlabs,
    parkHalos,
    piles,
    rings,
    bolts,
    lights,
    names,
    fadeUniforms,
    pulseUniforms,
    owned,
  }
}

/** 写入充电 LOD 淡出参数：世界尺寸 = 立柱高度（桩/环/贴花同步隐现） */
function tuneChargeFade(uniforms: ScreenSizeFadeUniforms): void {
  uniforms.uWorldSizeM.value = CHARGE_PILE_HEIGHT_M
  uniforms.uFadeStartPx.value = CHARGE_FADE_START_PX
  uniforms.uFadeEndPx.value = CHARGE_FADE_END_PX
}

/** 一次性上载静态实例矩阵与（可选）实例颜色，之后不再逐帧改写 */
function uploadStaticInstances(
  mesh: THREE.InstancedMesh,
  count: number,
  matrices: Float32Array,
  colors: Float32Array | null,
): void {
  mesh.count = count
  if (count > 0) {
    mesh.instanceMatrix.array.set(matrices)
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    if (colors !== null) {
      const instanceColor = new THREE.InstancedBufferAttribute(colors, 3)
      instanceColor.setUsage(THREE.StaticDrawUsage)
      mesh.instanceColor = instanceColor
    }
    mesh.computeBoundingSphere()
  }
  mesh.matrixAutoUpdate = false
}

/** 对称释放本组件创建的全部 GPU 资源（几何/材质/实例缓冲；幂等） */
function disposeLandmarkResources(resources: LandmarkResources): void {
  for (const item of resources.owned) {
    item.dispose()
  }
}
