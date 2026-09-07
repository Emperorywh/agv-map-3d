/**
 * 地标位置继续来自地图语义节点，停车底板保留，P 字标交由节点几何统一绘制。
 * 充电设施直接使用完整 GLB，保留透明水晶、自发光分区和真实装配层级。
 * 塔体始终完整显示，不再按屏幕尺寸淡出或覆写模型材质。
 * 几何、材质与实例缓冲由本组件统一释放，地图与上下文换代时重新创建。
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { MapModel } from '../model/types'
import type { WorldTransform } from '@/shared/spatial'
import { buildLandmarkData, type LandmarkData } from '../scene/buildLandmarkData'
import { ChargingTowersLayer } from './ChargingTowersLayer'
import type { MapNameAtlas } from '../scene/mapNameAtlas'
import {
  NODE_COLORS,
  PARK_SLAB_HALO_LIFT_M,
  PARK_SLAB_HALO_OPACITY,
  PARK_SLAB_HEIGHT_M,
  PARK_SLAB_OPACITY,
} from '../scene/mapAppearance'

export interface LandmarksLayerProps {
  readonly mapModel: MapModel
  readonly worldTransform: WorldTransform
  /**
   * 保留地图名称资源接口；停车 P 已改为节点原生几何，不依赖图集。
   * 图集缺失时，停车与充电的语义标识仍然完整可见。
   */
  readonly nameAtlas: MapNameAtlas | null
}

/** 停车层自建 GPU 资源集合：合批对象与释放清单 */
interface LandmarkResources {
  /** 资源代序号：每次重建递增，作为 primitive 的 key 强制走卸载/挂载路径 */
  readonly id: number
  parkSlabs: THREE.InstancedMesh
  parkHalos: THREE.InstancedMesh
  /** 创建的全部 geometry/material（不含外部图集纹理），释放责任清单 */
  owned: { dispose(): void }[]
}

/** 资源代计数器：本模块内单调递增，保证 key 随资源重建而变化 */
let landmarkResourcesSeq = 0

export function LandmarksLayer({
  mapModel,
  worldTransform,
}: LandmarksLayerProps) {
  const data = useMemo(
    () => buildLandmarkData(mapModel, worldTransform),
    [mapModel, worldTransform],
  )
  const resources = useMemo(
    () => createLandmarkResources(data),
    [data],
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
      <ChargingTowersLayer matrices={data.chargeMatrices} />
    </>
  )
}

/**
 * 上载停车静态实例数据并创建对应 GPU 对象，几何仅构建一次。
 * 充电塔由独立异步图层加载，停车标记不依赖模型请求完成。
 */
function createLandmarkResources(
  data: LandmarkData,
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

  return {
    id,
    parkSlabs,
    parkHalos,
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
