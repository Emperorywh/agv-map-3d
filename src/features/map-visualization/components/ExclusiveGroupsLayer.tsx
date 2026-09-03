/**
 * 独占区提示图层（SPEC §2.3、§5.1、§7.2；TASK-005；P1-7 视觉差距修订）。
 *
 * 职责：把 buildExclusiveGroupsGeometry 产出的「全分组合并蓝色外沿几何」与
 *       「成员路径凸包面填充几何」（P1-7）以低透明度材质挂入场景，并把分组
 *       名称锚点与图集单元 join 后合批为近景名称四边形（距离淡出：远距离
 *       隐藏、近距离显示，GPU 侧完成）。Reference 的独占区是「半透明蓝色
 *       面填充 + 亮色描边」：填充位于外沿之上、路面之下（烘焙高度分层）。
 * 边界：几何由本组件经 useMemo 构建并在卸载/视图更换时 dispose（创建者
 *       释放）；图集纹理由 Feature 根组件单一所有，本组件只消费。独占区只
 *       提供空间语义，不参与调度、不响应交互。
 * 关键不变量：
 * 1. 外沿与填充各恰好一个 Mesh（全部分组合并为一个静态 BufferGeometry，
 *    SPEC §2.3），名称恰好一个 Mesh；透明层不写深度，按烘焙高度分层；
 * 2. 名称按「组 id → 图集单元」join，未入图集的分组名称跳过（逐项隔离），
 *    无可用图集时名称 Mesh 整体不创建，外沿与填充不受影响；
 * 3. 视图原子替换（地图恢复）时 useMemo 以新输入重建、旧资源在 effect 清理
 *    中对称释放，任何一帧不引用已释放 GPU 对象。
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { MapModel } from '../model/types'
import type { WorldTransform } from '@/shared/spatial'
import type { PhysicalPathIndex } from '../scene/buildMapGeometry'
import { buildExclusiveGroupsGeometry } from '../scene/buildExclusiveGroupsGeometry'
import {
  buildNameQuadGeometry,
  type MapNameAtlas,
  type NameQuadInput,
} from '../scene/mapNameAtlas'
import { createNameFadeMaterial } from '../scene/semanticMaterials'
import {
  EXCLUSIVE_FILL_COLOR,
  EXCLUSIVE_FILL_OPACITY,
  EXCLUSIVE_OUTLINE_COLOR,
  EXCLUSIVE_OUTLINE_OPACITY,
  GROUP_NAME_FADE_FAR_M,
  GROUP_NAME_FADE_NEAR_M,
  GROUP_NAME_HEIGHT_M,
  NAME_QUAD_Y,
} from '../scene/mapAppearance'

export interface ExclusiveGroupsLayerProps {
  readonly mapModel: MapModel
  readonly worldTransform: WorldTransform
  /** 物理路径索引（MapGeometry.physical）：成员边 → 物理路径映射的来源 */
  readonly physical: PhysicalPathIndex
  /** 地图名称图集；null 表示名称降级不可用（外沿不受影响） */
  readonly nameAtlas: MapNameAtlas | null
}

interface ExclusiveResources {
  /** 资源代序号：每次重建递增，作为 primitive 的 key 强制走卸载/挂载路径 */
  readonly id: number
  outline: THREE.Mesh
  fill: THREE.Mesh
  names: THREE.Mesh | null
  /** 本组件创建、需在清理中释放的 geometry/material（几何经 build 释放） */
  owned: { dispose(): void }[]
  build: ReturnType<typeof buildExclusiveGroupsGeometry>
}

/** 资源代计数器：本模块内单调递增，保证 key 随资源重建而变化 */
let exclusiveResourcesSeq = 0

export function ExclusiveGroupsLayer({
  mapModel,
  worldTransform,
  physical,
  nameAtlas,
}: ExclusiveGroupsLayerProps) {
  const resources = useMemo(
    () => createExclusiveResources(mapModel, worldTransform, physical, nameAtlas),
    [mapModel, worldTransform, physical, nameAtlas],
  )
  useEffect(() => () => disposeExclusiveResources(resources), [resources])

  return (
    <>
      {/* dispose={null}：全部对象由本组件 effect 显式释放，禁止 R3F 二次释放。
          key 随资源代变化：R3F 对已有 primitive 的 object 换新依赖「兄弟序列
          尾部」探测，与条件子元素组合时重建会被静默丢弃（实测）；
          key 变化强制 React 走干净的卸载/挂载路径，旧对象必然离场。 */}
      <primitive key={`outline-${resources.id}`} object={resources.outline} dispose={null} />
      <primitive key={`fill-${resources.id}`} object={resources.fill} dispose={null} />
      {resources.names !== null ? (
        <primitive key={`names-${resources.id}`} object={resources.names} dispose={null} />
      ) : null}
    </>
  )
}

/** 构建外沿/填充几何 + 名称合批对象（一次构建、静态不再改写） */
function createExclusiveResources(
  mapModel: MapModel,
  worldTransform: WorldTransform,
  physical: PhysicalPathIndex,
  atlas: MapNameAtlas | null,
): ExclusiveResources {
  const id = ++exclusiveResourcesSeq
  const build = buildExclusiveGroupsGeometry(mapModel, worldTransform, physical)

  const outlineMaterial = new THREE.MeshBasicMaterial({
    color: EXCLUSIVE_OUTLINE_COLOR,
    transparent: true,
    opacity: EXCLUSIVE_OUTLINE_OPACITY,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const outline = new THREE.Mesh(build.outline, outlineMaterial)
  outline.name = 'map-exclusive-outline'
  outline.matrixAutoUpdate = false
  outline.renderOrder = 1

  // 面填充（P1-7）：半透明蓝色区域，烘焙高度在外沿之上、路面之下，后画
  // （renderOrder 更大）以正确叠在蓝色外沿上；路面不透明覆盖其上。
  const fillMaterial = new THREE.MeshBasicMaterial({
    color: EXCLUSIVE_FILL_COLOR,
    transparent: true,
    opacity: EXCLUSIVE_FILL_OPACITY,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const fill = new THREE.Mesh(build.fill, fillMaterial)
  fill.name = 'map-exclusive-fill'
  fill.matrixAutoUpdate = false
  fill.renderOrder = 2

  const owned: { dispose(): void }[] = [outlineMaterial, fillMaterial]

  // —— 分组名称：成员节点包围盒中心锚点 → 图集单元 → 静态合批四边形 ——
  let names: THREE.Mesh | null = null
  if (atlas !== null) {
    const inputs: NameQuadInput[] = []
    for (const anchor of build.nameAnchors) {
      const cell = atlas.cells.get(`group:${anchor.groupId}`)
      if (cell === undefined) {
        continue
      }
      inputs.push({ x: anchor.x, z: anchor.z, cell, heightM: GROUP_NAME_HEIGHT_M })
    }
    if (inputs.length > 0) {
      const namesGeometry = buildNameQuadGeometry(inputs, NAME_QUAD_Y)
      const namesMaterial = createNameFadeMaterial(
        atlas.texture,
        GROUP_NAME_FADE_NEAR_M,
        GROUP_NAME_FADE_FAR_M,
      )
      names = new THREE.Mesh(namesGeometry, namesMaterial)
      names.name = 'map-group-names'
      names.matrixAutoUpdate = false
      owned.push(namesGeometry, namesMaterial)
    }
  }

  return { id, outline, fill, names, owned, build }
}

/** 对称释放：外沿/填充几何（build 拥有）、名称几何与本组件全部材质（幂等） */
function disposeExclusiveResources(resources: ExclusiveResources): void {
  resources.build.dispose()
  for (const item of resources.owned) {
    item.dispose()
  }
}
