/**
 * 地标位置继续来自地图语义节点，停车图层与名称图集沿用原有实现。
 * 充电节点改为按材质合批的工业柜体，使用局部指示灯而不再绘制光环和闪电。
 * 几何、材质与实例缓冲由本组件统一释放，地图与上下文换代时重新创建。
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { MapModel } from '../model/types'
import type { WorldTransform } from '@/shared/spatial'
import { buildLandmarkData, type LandmarkData } from '../scene/buildLandmarkData'
import { createChargingCabinet, instanceFacility } from '@/shared/industrial/facilities'
import {
  buildNameQuadGeometry,
  PARK_GLYPH_KEY,
  type MapNameAtlas,
  type NameQuadInput,
} from '../scene/mapNameAtlas'
import {
  createNameFadeMaterial,
} from '../scene/semanticMaterials'
import {
  LANDMARK_NAME_FADE_FAR_M,
  LANDMARK_NAME_FADE_NEAR_M,
  NAME_QUAD_Y,
  NODE_COLORS,
  PARK_GLYPH_HEIGHT_M,
  PARK_GLYPH_OFFSET_Z_M,
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
  /** 保留既有能力接口；工业柜体指示灯恒定，不受装饰动画开关影响 */
  readonly decorationsEnabled: boolean
}

/** 组件自建 GPU 资源集合：合批对象 + 帧 uniforms + 释放清单 */
interface LandmarkResources {
  /** 资源代序号：每次重建递增，作为 primitive 的 key 强制走卸载/挂载路径 */
  readonly id: number
  parkSlabs: THREE.InstancedMesh
  parkHalos: THREE.InstancedMesh
  charging: ReturnType<typeof instanceFacility>
  /** 名称合批 Mesh；图集不可用时为 null */
  names: THREE.Mesh | null
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

  return (
    <>
      {/* dispose={null}：全部对象由本组件 effect 显式释放，禁止 R3F 二次释放。
          key 随资源代变化：R3F 对已有 primitive 的 object 换新依赖「兄弟序列
          尾部」探测，与条件渲染子元素组合时重建会被静默丢弃（实测）；
          key 变化强制 React 走干净的卸载/挂载路径，旧对象必然离场。 */}
      <primitive key={`park-slabs-${resources.id}`} object={resources.parkSlabs} dispose={null} />
      <primitive key={`park-halos-${resources.id}`} object={resources.parkHalos} dispose={null} />
      <primitive key={`charging-${resources.id}`} object={resources.charging.group} dispose={null} />
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
  void decorationsEnabled
  const owned: { dispose(): void }[] = []
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

  /**
   * 充电柜继续使用地图中已识别的充电节点位置，不改变设施业务分类。
   * 整批柜体共享工业材质和几何，仅局部指示灯发光，所有底座接触零米地面。
   */
  const cabinet = createChargingCabinet()
  const charging = instanceFacility(cabinet, data.chargeMatrices)
  charging.group.name = 'map-charge-cabinets'
  owned.push(charging, cabinet)

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
      inputs.push({ x: anchor.x, z: anchor.z + PARK_GLYPH_OFFSET_Z_M, cell, heightM: PARK_GLYPH_HEIGHT_M })
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
    charging,
    names,
    owned,
  }
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
