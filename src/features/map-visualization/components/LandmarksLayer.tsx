/**
 * 地标语义图层（SPEC §2.1、§5.1、§6.5；TASK-005）。
 *
 * 职责：把 buildLandmarkData 的纯数据一次性上载为静态合批 GPU 对象——
 *       - 地面标识方垫 InstancedMesh（仓库浅黄 + 停车紫，实例颜色区分）；
 *       - 充电桩立柱 InstancedMesh（青色）与底部光环 InstancedMesh；
 *       - 充电呼吸灯 InstancedMesh（正弦亮度脉动，受 decorationsEnabled 开关）；
 *       - 名称四边形合批 Mesh（仓库名称 + 停车 P 字形，图集纹理 + 距离淡出）。
 * 边界：实例/几何数据由 buildLandmarkData 提供，图集纹理由 Feature 根组件
 *       （单一所有者）注入，本组件只消费不释放图集；本组件创建的全部
 *       geometry/material/实例缓冲在卸载或数据更换时对称释放。
 * 关键不变量：
 * 1. 每类地标恰好一个 Draw Call（方垫/立柱/光环/呼吸灯/名称各一个对象），
 *    实例差异全部由矩阵与实例颜色表达，静态上载一次后不再逐帧改写；
 * 2. 呼吸脉动只写 uniforms（uTime/uPulseEnabled），不触碰实例缓冲、不进
 *    React state——decorationsEnabled=false 时 uPulseEnabled=0，呼吸灯恒定
 *    全亮，其余地标不受影响；
 * 3. 图集为 null（创建失败降级）或名称 key 未入图集（容量隔离）时，名称
 *    Mesh 整体不创建——缺名称不缺地标，地图其余语义完整；
 * 4. 资源对称释放：useMemo 创建、effect 清理释放，StrictMode 双执行不泄漏。
 */
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import type { MapModel } from '../model/types'
import type { WorldTransform } from '@/shared/spatial'
import { buildLandmarkData, type LandmarkData } from '../scene/buildLandmarkData'
import {
  buildNameQuadGeometry,
  PARK_GLYPH_KEY,
  type MapNameAtlas,
  type NameQuadInput,
} from '../scene/mapNameAtlas'
import { createNameFadeMaterial, createPulseMaterial, type PulseUniforms } from '../scene/semanticMaterials'
import {
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
  LANDMARK_PAD_OPACITY,
  NAME_QUAD_Y,
  PARK_GLYPH_HEIGHT_M,
  WAREHOUSE_NAME_FADE_FAR_M,
  WAREHOUSE_NAME_FADE_NEAR_M,
  WAREHOUSE_NAME_HEIGHT_M,
} from '../scene/mapAppearance'

export interface LandmarksLayerProps {
  readonly mapModel: MapModel
  readonly worldTransform: WorldTransform
  /** 地图名称图集；null 表示名称降级不可用（地标其余部分不受影响） */
  readonly nameAtlas: MapNameAtlas | null
  /** 装饰动画能力开关：false 时呼吸灯恒定全亮（SPEC §6.5 预留） */
  readonly decorationsEnabled: boolean
}

/** 组件自建 GPU 资源集合：五个合批对象 + 呼吸 uniforms + 释放清单 */
interface LandmarkResources {
  /** 资源代序号：每次重建递增，作为 primitive 的 key 强制走卸载/挂载路径 */
  readonly id: number
  pads: THREE.InstancedMesh
  piles: THREE.InstancedMesh
  rings: THREE.InstancedMesh
  lights: THREE.InstancedMesh
  /** 名称合批 Mesh；图集不可用时为 null */
  names: THREE.Mesh | null
  pulseUniforms: PulseUniforms
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

  // 呼吸脉动：每帧只写 uniforms；开关即时生效，不触碰实例缓冲与 React state
  const enabledRef = useRef(decorationsEnabled)
  enabledRef.current = decorationsEnabled
  useFrame(({ clock }) => {
    resources.pulseUniforms.uTime.value = clock.elapsedTime
    resources.pulseUniforms.uPulseEnabled.value = enabledRef.current ? 1 : 0
  })

  return (
    <>
      {/* dispose={null}：全部对象由本组件 effect 显式释放，禁止 R3F 二次释放。
          key 随资源代变化：R3F 对已有 primitive 的 object 换新依赖「兄弟序列
          尾部」探测，与条件渲染子元素组合时重建会被静默丢弃（实测）；
          key 变化强制 React 走干净的卸载/挂载路径，旧对象必然离场。 */}
      <primitive key={`pads-${resources.id}`} object={resources.pads} dispose={null} />
      <primitive key={`piles-${resources.id}`} object={resources.piles} dispose={null} />
      <primitive key={`rings-${resources.id}`} object={resources.rings} dispose={null} />
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
  const id = ++landmarkResourcesSeq

  // —— 地面标识方垫：一个 InstancedMesh，仓库/停车以实例颜色区分 ——
  const padGeometry = new THREE.PlaneGeometry(1, 1)
  padGeometry.rotateX(-Math.PI / 2)
  owned.push(padGeometry)
  const padMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: LANDMARK_PAD_OPACITY,
    depthWrite: false,
  })
  owned.push(padMaterial)
  const pads = new THREE.InstancedMesh(padGeometry, padMaterial, Math.max(data.padCount, 0))
  pads.name = 'map-landmark-pads'
  uploadStaticInstances(pads, data.padCount, data.padMatrices, data.padColors)
  owned.push(pads)

  // —— 充电桩立柱：几何底部对齐地面，实例矩阵仅平移 ——
  const pileGeometry = new THREE.BoxGeometry(
    CHARGE_PILE_WIDTH_M,
    CHARGE_PILE_HEIGHT_M,
    CHARGE_PILE_DEPTH_M,
  )
  pileGeometry.translate(0, CHARGE_PILE_HEIGHT_M / 2, 0)
  owned.push(pileGeometry)
  const pileMaterial = new THREE.MeshBasicMaterial({ color: CHARGE_PILE_COLOR })
  owned.push(pileMaterial)
  const piles = new THREE.InstancedMesh(pileGeometry, pileMaterial, Math.max(data.chargeCount, 0))
  piles.name = 'map-charge-piles'
  uploadStaticInstances(piles, data.chargeCount, data.chargeMatrices, null)
  owned.push(piles)

  // —— 充电桩底部光环：平贴地面圆环，透明青色 ——
  const ringGeometry = new THREE.RingGeometry(CHARGE_RING_INNER_M, CHARGE_RING_OUTER_M, 24)
  ringGeometry.rotateX(-Math.PI / 2)
  owned.push(ringGeometry)
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: CHARGE_RING_COLOR,
    transparent: true,
    opacity: CHARGE_RING_OPACITY,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  owned.push(ringMaterial)
  const rings = new THREE.InstancedMesh(ringGeometry, ringMaterial, Math.max(data.chargeCount, 0))
  rings.name = 'map-charge-rings'
  uploadStaticInstances(rings, data.chargeCount, data.chargeMatrices, null)
  owned.push(rings)

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
  owned.push(pulse.material)
  const lights = new THREE.InstancedMesh(lightGeometry, pulse.material, Math.max(data.chargeCount, 0))
  lights.name = 'map-charge-lights'
  uploadStaticInstances(lights, data.chargeCount, data.chargeMatrices, null)
  owned.push(lights)

  // —— 名称四边形：仓库锚点 + 停车字形与图集单元 join 后静态合批 ——
  let names: THREE.Mesh | null = null
  if (atlas !== null) {
    const inputs: NameQuadInput[] = []
    for (const anchor of data.warehouseNameAnchors) {
      const cell = atlas.cells.get(`node:${anchor.nodeId}`)
      if (cell === undefined) {
        continue
      }
      inputs.push({ x: anchor.x, z: anchor.z, cell, heightM: WAREHOUSE_NAME_HEIGHT_M })
    }
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
        WAREHOUSE_NAME_FADE_NEAR_M,
        WAREHOUSE_NAME_FADE_FAR_M,
      )
      names = new THREE.Mesh(namesGeometry, namesMaterial)
      names.name = 'map-landmark-names'
      names.matrixAutoUpdate = false
      owned.push(namesGeometry, namesMaterial)
    }
  }

  return { id, pads, piles, rings, lights, names, pulseUniforms: pulse.uniforms, owned }
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
