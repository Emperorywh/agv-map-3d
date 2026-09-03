/**
 * 仓储聚合图层（视觉对齐改造 P0-5.5）。
 *
 * 职责：把 buildWarehouseVisualModel 的纯数据一次性上载为静态 GPU 对象——
 *       - 仓储区域色块合批 Mesh：区域凸包 + 沿边外扩 + 扇形三角化（与独占
 *         区面填充共用 hull2d 数学），仓库黄极低透明度整块着色，全等级可
 *         见——全厂总览用「区域块」替代 1,185 个方垫的点阵地毯；
 *       - 货架行轮廓 InstancedMesh：有向矩形凸起 slab（单位盒 + 行矩阵的
 *         平移/旋转/非等比缩放），作业区起可见（createSceneGatedMaterial
 *         门控 minLevel=1），单个库位方垫仍在 LandmarksLayer（近景可见）。
 *       两类对象各一个 Draw Call；实例与几何全部静态上载，不逐帧改写。
 * 边界：聚类数据由本组件经 useMemo 从 mapModel 构建并与图层同生命周期；
 *       场景等级 uniform 由 SceneDetailController 共享下发（只读引用），本
 *       组件创建的全部 geometry/material 在卸载或数据更换时对称释放。
 * 关键不变量：
 * 1. 区域色块与货架行是纯静态贴花：不进 React state、无逐帧写入；显隐完
 *    全由 GPU 侧场景等级门控（uSceneLevel）表达；
 * 2. 聚类纯 CPU 一次性构建：地图加载或替换时随视图重建，不在帧循环内；
 * 3. 资源对称释放：useMemo 创建、effect 清理释放，StrictMode 双执行不泄漏。
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { MapModel } from '../model/types'
import type { WorldTransform } from '@/shared/spatial'
import { buildWarehouseVisualModel, type WarehouseVisualModel } from '../scene/warehouseVisualModel'
import { appendConvexHullFill } from '../scene/hull2d'
import { createSceneGatedMaterial } from '../scene/semanticMaterials'
import {
  WAREHOUSE_RACK_COLOR,
  WAREHOUSE_RACK_HEIGHT_M,
  WAREHOUSE_RACK_OPACITY,
  WAREHOUSE_ZONE_FILL_COLOR,
  WAREHOUSE_ZONE_FILL_OPACITY,
  WAREHOUSE_ZONE_FILL_Y,
} from '../scene/mapAppearance'
import type { SceneDetailController } from '../scene/sceneDetailController'

export interface WarehouseRacksLayerProps {
  readonly mapModel: MapModel
  readonly worldTransform: WorldTransform
  /** 场景细节控制器；null 时行轮廓材质使用自建等级 uniform（恒为总览） */
  readonly sceneDetail: SceneDetailController | null
}

/** 组件自建 GPU 资源集合 */
interface WarehouseResources {
  zoneFill: THREE.Mesh
  rackRows: THREE.InstancedMesh
  owned: { dispose(): void }[]
}

export function WarehouseRacksLayer({
  mapModel,
  worldTransform,
  sceneDetail,
}: WarehouseRacksLayerProps) {
  const data = useMemo(
    () => buildWarehouseVisualModel(mapModel, worldTransform),
    [mapModel, worldTransform],
  )
  const resources = useMemo(
    () => createWarehouseResources(data, sceneDetail?.uniforms.uSceneLevel),
    [data, sceneDetail],
  )
  useEffect(() => () => disposeWarehouseResources(resources), [resources])

  return (
    <>
      {/* dispose={null}：对象由本组件 effect 显式释放，禁止 R3F 二次释放 */}
      <primitive object={resources.zoneFill} dispose={null} />
      <primitive object={resources.rackRows} dispose={null} />
    </>
  )
}

function createWarehouseResources(
  data: WarehouseVisualModel,
  sceneLevelUniform: { value: number } | undefined,
): WarehouseResources {
  const owned: { dispose(): void }[] = []

  // —— 区域色块：全部 zone 凸包合并为一个静态 Mesh（全等级可见——色块本身
  //    就是总览语义；透明度极低不抢戏） ——
  const fillPositions: number[] = []
  const fillIndices: number[] = []
  for (const zone of data.zones) {
    appendConvexHullFill(
      fillPositions,
      fillIndices,
      zone.hull,
      ZONE_FILL_PADDING_M,
      WAREHOUSE_ZONE_FILL_Y,
    )
  }
  const fillGeometry = new THREE.BufferGeometry()
  fillGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(fillPositions, 3),
  )
  fillGeometry.setIndex(fillIndices)
  fillGeometry.computeBoundingSphere()
  owned.push(fillGeometry)
  const fillMaterial = new THREE.MeshBasicMaterial({
    color: WAREHOUSE_ZONE_FILL_COLOR,
    transparent: true,
    opacity: WAREHOUSE_ZONE_FILL_OPACITY,
    depthWrite: false,
  })
  owned.push(fillMaterial)
  const zoneFill = new THREE.Mesh(fillGeometry, fillMaterial)
  zoneFill.name = 'map-warehouse-zones'
  zoneFill.matrixAutoUpdate = false

  // —— 货架行轮廓：有向矩形凸起 slab，一个 InstancedMesh（作业区起可见） ——
  const rowGeometry = new THREE.BoxGeometry(1, 1, 1)
  rowGeometry.translate(0, 0.5, 0)
  owned.push(rowGeometry)
  const rowMaterial = createSceneGatedMaterial({
    color: WAREHOUSE_RACK_COLOR,
    opacity: WAREHOUSE_RACK_OPACITY,
    minLevel: 1,
    sceneLevelUniform: sceneLevelUniform ?? { value: 0 },
  })
  owned.push(rowMaterial.material)
  const rackRows = new THREE.InstancedMesh(
    rowGeometry,
    rowMaterial.material,
    Math.max(data.rowCount, 0),
  )
  rackRows.name = 'map-warehouse-racks'
  uploadRowInstances(rackRows, data)
  owned.push(rackRows)

  return { zoneFill, rackRows, owned }
}

/** 区域色块沿边外扩（米）：盖住边缘节点的方垫，块状语义更完整 */
const ZONE_FILL_PADDING_M = 1

/** 把全部货架行的有向矩形写入实例矩阵（列主序：平移 + 绕 y 旋转 + 非等比缩放） */
function uploadRowInstances(
  mesh: THREE.InstancedMesh,
  data: WarehouseVisualModel,
): void {
  let index = 0
  const scratchRotation = new THREE.Matrix4()
  const scratchScale = new THREE.Matrix4()
  const scratchTranslation = new THREE.Matrix4()
  for (const zone of data.zones) {
    for (const row of zone.rows) {
      scratchRotation.makeRotationY(-row.angle)
      scratchScale.makeScale(row.lengthM, WAREHOUSE_RACK_HEIGHT_M, row.widthM)
      scratchTranslation.makeTranslation(row.centerX, 0, row.centerZ)
      mesh.setMatrixAt(index, scratchTranslation.multiply(scratchRotation.multiply(scratchScale)))
      index += 1
    }
  }
  mesh.count = index
  if (index > 0) {
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    mesh.computeBoundingSphere()
  }
  mesh.matrixAutoUpdate = false
}

function disposeWarehouseResources(resources: WarehouseResources): void {
  for (const item of resources.owned) {
    item.dispose()
  }
}
