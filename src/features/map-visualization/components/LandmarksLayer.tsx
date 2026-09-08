/**
 * 地标位置继续来自地图语义节点：停车凸起 slab + 微光光晕（P2-2），白色 P
 * 字标经名称图集合批四边形绘制（图集缺失时优雅降级为仅 slab）；充电设施
 * 直接使用完整 GLB，保留透明水晶、自发光分区和真实装配层级。
 * 塔体始终完整显示，不再按屏幕尺寸淡出或覆写模型材质。
 * 几何、材质与实例缓冲由本组件统一释放，地图与上下文换代时重新创建。
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { MapModel } from '../model/types'
import type { WorldTransform } from '@/shared/spatial'
import { buildLandmarkData, type LandmarkData } from '../scene/buildLandmarkData'
import { ChargingTowersLayer } from './ChargingTowersLayer'
import { PARK_GLYPH_KEY, buildNameQuadGeometry, type MapNameAtlas } from '../scene/mapNameAtlas'
import { createNameFadeMaterial } from '../scene/semanticMaterials'
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
  /**
   * 名称图集（停车 P 字形单元）：由 Feature 单一持有，本组件只消费。
   * 图集缺失（无 Canvas 环境降级）时 P 字形不可见，slab 与光晕语义仍完整。
   */
  readonly nameAtlas: MapNameAtlas | null
}

/** 停车层自建 GPU 资源集合：合批对象与释放清单 */
interface LandmarkResources {
  /** 资源代序号：每次重建递增，作为 primitive 的 key 强制走卸载/挂载路径 */
  readonly id: number
  parkSlabs: THREE.InstancedMesh
  parkHalos: THREE.InstancedMesh
  /** 停车 P 字形合批四边形；图集缺失或无 park 节点时为 null */
  parkGlyphs: THREE.Mesh | null
  /** 创建的全部 geometry/material（不含外部图集纹理），释放责任清单 */
  owned: { dispose(): void }[]
}

/** 资源代计数器：本模块内单调递增，保证 key 随资源重建而变化 */
let landmarkResourcesSeq = 0

export function LandmarksLayer({
  mapModel,
  worldTransform,
  nameAtlas,
}: LandmarksLayerProps) {
  const data = useMemo(
    () => buildLandmarkData(mapModel, worldTransform),
    [mapModel, worldTransform],
  )
  const resources = useMemo(
    () => createLandmarkResources(data, nameAtlas),
    [data, nameAtlas],
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
      {resources.parkGlyphs !== null ? (
        <primitive key={`park-glyphs-${resources.id}`} object={resources.parkGlyphs} dispose={null} />
      ) : null}
      <ChargingTowersLayer matrices={data.chargeMatrices} />
    </>
  )
}

/**
 * 上载停车静态实例数据并创建对应 GPU 对象，几何仅构建一次。
 * P 字形四边形依赖图集单元格（缺单元格 = 不渲染，绝不悬空引用 UV 区域）；
 * 充电塔由独立异步图层加载，停车标记不依赖模型请求完成。
 */
function createLandmarkResources(
  data: LandmarkData,
  nameAtlas: MapNameAtlas | null,
): LandmarkResources {
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

  // —— 停车白色 P 字形（P2-2/8.5）：名称图集单元格烘焙为贴地合批四边形，
  // 沿 +z 偏移让 P 完整落在 slab 前半幅，距离淡出（近全显、远全隐）由材质
  // 注入完成。图集纹理归 Feature 所有，这里只释放几何与材质。 ——
  const glyphCell = nameAtlas?.cells.get(PARK_GLYPH_KEY)
  let parkGlyphs: THREE.Mesh | null = null
  if (nameAtlas !== null && glyphCell !== undefined && data.parkAnchors.length > 0) {
    const glyphGeometry = buildNameQuadGeometry(
      data.parkAnchors.map((anchor) => ({
        x: anchor.x,
        z: anchor.z + PARK_GLYPH_OFFSET_Z_M,
        cell: glyphCell,
        heightM: PARK_GLYPH_HEIGHT_M,
      })),
      NAME_QUAD_Y,
    )
    owned.push(glyphGeometry)
    const glyphMaterial = createNameFadeMaterial(
      nameAtlas.texture,
      LANDMARK_NAME_FADE_NEAR_M,
      LANDMARK_NAME_FADE_FAR_M,
    )
    owned.push(glyphMaterial)
    parkGlyphs = new THREE.Mesh(glyphGeometry, glyphMaterial)
    parkGlyphs.name = 'map-park-glyphs'
    // 晚于 slab/光晕混合绘制；深度测试保持开启（quad 高于贴花顶端）
    parkGlyphs.renderOrder = 6
    parkGlyphs.raycast = () => {}
  }

  return {
    id,
    parkSlabs,
    parkHalos,
    parkGlyphs,
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
