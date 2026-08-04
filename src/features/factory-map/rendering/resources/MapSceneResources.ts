/**
 * MapSceneResources：地图渲染资源唯一 owner（SPEC §7、§10.3、§4.3、§6.6、§9.3）。
 *
 * 职责：
 * - 用 TASK-007 的 bindFactorySceneModel 对 FactorySceneModel 做主线程再校验并
 *   零拷贝绑定（§5.1）：校验失败返回 { ok: false, error: SceneBuildError }，
 *   不创建任何 Three 资源（不渲染部分地图，§11）；
 * - 装配 §7.5 合并策略的 7 个绘制批次：正向/反向路径带 2 个 Mesh、正向/反向
 *   箭头 2 个 InstancedMesh、节点圆点 / 站点圆环 / 站点朝向符号各 1 个
 *   InstancedMesh；箭头/圆点/圆环/朝向符号共享本模块创建的 4 份局部几何
 *   （几何算法见 scene/map/instanceGeometry.ts 纯函数模块）；
 * - 生命周期（§10.3 MapSceneResources 行）：SceneModel 替换或 MapLayer 卸载时
 *   逐一 dispose——路径 BufferGeometry、4 份实例 geometry、实例矩阵/颜色
 *   buffer（经绑定批次 dispose）与 7 个材质；dispose 幂等，dispose 后可重新
 *   setup（React StrictMode 重复挂载不产生重复 WebGL 资源）。
 *
 * 材质（§7.1）：全部 MeshStandardMaterial、roughness 0.8（地图标线统一地坪漆
 * 观感）、envMapIntensity 取 §13.3 固定值；颜色全部来自 config/visualTheme.ts
 * （§7）。§4.3 双保险第二道：每层材质 polygonOffset=true / factor=-1 / units
 * 按高度分层表逐层设置（y 偏移已在 Worker 构建期烘焙进顶点/矩阵）。
 * rings/directions 用 instanceColor 表达 work/charge/park 三色（Worker 已输出
 * 线性颜色），材质保持默认白色且不得启用 vertexColors（§7.3：几何体无 color
 * attribute 时启用会渲染为黑色）。
 *
 * 阴影（§6.6 注记）：地图元素 receiveShadow=true、castShadow=false。
 * 消费组件（scene/map 子层）以 <primitive> 挂载快照 mesh，不得释放借用的
 * geometry/material/buffer（§10.3：共享资源只能由唯一 owner 释放）。
 */

import {
  BufferAttribute,
  BufferGeometry,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
} from 'three'

import type { FactorySceneModel, GeometryBatchDto } from '../../application/factorySceneModel'
import { ENV_MAP_INTENSITY } from '../../config/qualityProfile'
import { NODE_DOT_R, STATION_RING_INNER_R, STATION_RING_OUTER_R } from '../../config/sceneMetrics'
import {
  CHEVRON_BACKWARD_COLOR,
  CHEVRON_FORWARD_COLOR,
  NODE_DOT_COLOR,
  PATH_BACKWARD_COLOR,
  PATH_FORWARD_COLOR,
} from '../../config/visualTheme'
import type { SceneBuildError } from '../../domain/errors'
import { bindFactorySceneModel } from '../core/bindFactorySceneModel'
import type { BoundColoredInstanceBatch, BoundInstanceBatch } from '../core/bindFactorySceneModel'
import {
  NODE_GEOMETRY_SEGMENTS,
  createChevronGeometryXZ,
  createDiskGeometryXZ,
  createRingGeometryXZ,
  createStationDirectionGeometryXZ,
} from '../scene/map/instanceGeometry'

// ---------------------------------------------------------------------------
// §4.3 高度分层表 polygonOffsetUnits（统一写法：polygonOffset=true / factor=-1）
// ---------------------------------------------------------------------------

/** 正向路径带（y=+0.004 已烘焙） */
const PATH_FORWARD_POLYGON_OFFSET_UNITS = -2
/** 正向路径箭头（y=+0.006 已烘焙） */
const ARROW_FORWARD_POLYGON_OFFSET_UNITS = -3
/** 反向路径带（y=+0.008 已烘焙） */
const PATH_BACKWARD_POLYGON_OFFSET_UNITS = -4
/** 反向路径箭头（y=+0.010 已烘焙） */
const ARROW_BACKWARD_POLYGON_OFFSET_UNITS = -5
/** 普通节点圆点（y=+0.012 已烘焙） */
const NODE_DOT_POLYGON_OFFSET_UNITS = -6
/** 站点圆环（y=+0.014 已烘焙） */
const STATION_RING_POLYGON_OFFSET_UNITS = -7
/** 站点朝向符号（y=+0.016 已烘焙） */
const STATION_DIRECTION_POLYGON_OFFSET_UNITS = -8

/** 地图标线材质 roughness（§7.1：0.8；路径/箭头/圆点/圆环/朝向符号统一地坪漆观感） */
const MAP_MARKING_ROUGHNESS = 0.8

// ---------------------------------------------------------------------------
// 公开契约
// ---------------------------------------------------------------------------

/** 地图快照：§7.5 合并策略的 7 个绘制批次（主 pass 7 draw call） */
export interface MapSceneSnapshot {
  /** 正向路径带（亮灰白漆 #C9CAC6） */
  readonly pathForwardMesh: Mesh
  /** 反向路径带（红 #E57373） */
  readonly pathBackwardMesh: Mesh
  /** 正向方向箭头 InstancedMesh（#83847F） */
  readonly arrowForwardMesh: InstancedMesh
  /** 反向方向箭头 InstancedMesh（#C05454） */
  readonly arrowBackwardMesh: InstancedMesh
  /** 普通节点圆点 InstancedMesh（#78909C） */
  readonly nodeDotMesh: InstancedMesh
  /** 站点圆环 InstancedMesh（instanceColor 表达 work/charge/park 三色） */
  readonly stationRingMesh: InstancedMesh
  /** 站点朝向符号 InstancedMesh（instanceColor 同所属圆环） */
  readonly stationDirectionMesh: InstancedMesh
}

/** setup 结果：绑定校验失败携带 SceneBuildError，不创建部分资源（§5.1、§11） */
export type MapSceneSetupResult =
  | { readonly ok: true; readonly snapshot: MapSceneSnapshot }
  | { readonly ok: false; readonly error: SceneBuildError }

export interface MapSceneResources {
  /**
   * 按 SceneModel 建立快照：先释放上一快照（SceneModel 替换语义），再经
   * bindFactorySceneModel 再校验并装配；校验失败返回错误且不创建任何资源。
   */
  setup(model: FactorySceneModel): MapSceneSetupResult
  /** 卸载：逐一 dispose 全部 geometry/实例 buffer/材质；幂等；之后可重新 setup */
  dispose(): void
  /** 当前快照（未 setup、setup 失败或已 dispose 时为 null） */
  readonly current: MapSceneSnapshot | null
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

interface Disposable {
  dispose(): void
}

/** §4.3 统一写法：polygonOffset=true / factor=-1 / units 按层取值 */
function createMarkingMaterial(color: string, polygonOffsetUnits: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    roughness: MAP_MARKING_ROUGHNESS,
    envMapIntensity: ENV_MAP_INTENSITY,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits,
  })
}

/** instanceColor 批次材质：保持默认白色（实例颜色独立生效），不启用 vertexColors（§7.3） */
function createColoredInstanceMaterial(polygonOffsetUnits: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    roughness: MAP_MARKING_ROUGHNESS,
    envMapIntensity: ENV_MAP_INTENSITY,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits,
  })
}

/** 局部几何批次 → BufferGeometry（实例共享几何，非 SceneModel transfer 内容） */
function toBufferGeometry(batch: GeometryBatchDto): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(batch.positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(batch.normals, 3))
  geometry.setIndex(new BufferAttribute(batch.indices, 1))
  return geometry
}

/** 地图元素阴影标记（§6.6 注记：receiveShadow=true、castShadow=false） */
function markMapElement(mesh: Mesh | InstancedMesh): void {
  mesh.receiveShadow = true
  mesh.castShadow = false
}

/** 实例网格装配：零拷贝接管绑定批次的实例矩阵 attribute */
function assembleInstancedMesh(
  batch: BoundInstanceBatch,
  geometry: BufferGeometry,
  material: MeshStandardMaterial,
): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, batch.instanceCount)
  mesh.instanceMatrix = batch.instanceMatrix
  markMapElement(mesh)
  return mesh
}

/** 带 instanceColor 的实例网格装配（站点圆环/朝向符号，§7.3/§7.4） */
function assembleColoredInstancedMesh(
  batch: BoundColoredInstanceBatch,
  geometry: BufferGeometry,
  material: MeshStandardMaterial,
): InstancedMesh {
  const mesh = assembleInstancedMesh(batch, geometry, material)
  mesh.instanceColor = batch.instanceColor
  return mesh
}

/** 创建地图资源 owner（§10.3：setup/dispose 幂等，StrictMode 重复挂载安全） */
export function createMapSceneResources(): MapSceneResources {
  let snapshot: MapSceneSnapshot | null = null
  let disposables: Disposable[] = []

  /** 逐一释放当前快照的全部资源；幂等 */
  const release = (): void => {
    for (const disposable of disposables) disposable.dispose()
    disposables = []
    snapshot = null
  }

  return {
    setup(model: FactorySceneModel): MapSceneSetupResult {
      // SceneModel 替换：先释放旧快照（§10.3），不保留旧资源
      release()

      // §5.1 主线程再校验 + 零拷贝绑定；失败不创建任何 Three 资源
      const bound = bindFactorySceneModel(model)
      if (!bound.ok) {
        return { ok: false, error: bound.error }
      }
      const { batches } = bound
      const owned: Disposable[] = [batches]

      // 实例共享局部几何（§7.2/§7.3/§7.4 固定形态，两个箭头批次共享同一 chevron）
      const chevronGeometry = toBufferGeometry(createChevronGeometryXZ())
      const diskGeometry = toBufferGeometry(createDiskGeometryXZ(NODE_GEOMETRY_SEGMENTS, NODE_DOT_R))
      const ringGeometry = toBufferGeometry(
        createRingGeometryXZ(NODE_GEOMETRY_SEGMENTS, STATION_RING_OUTER_R, STATION_RING_INNER_R),
      )
      const directionGeometry = toBufferGeometry(createStationDirectionGeometryXZ(STATION_RING_OUTER_R))
      owned.push(chevronGeometry, diskGeometry, ringGeometry, directionGeometry)

      // 材质：颜色全部来自 visualTheme（§7）；§4.3 逐层 polygonOffset 双保险
      const pathForwardMaterial = createMarkingMaterial(
        PATH_FORWARD_COLOR,
        PATH_FORWARD_POLYGON_OFFSET_UNITS,
      )
      const pathBackwardMaterial = createMarkingMaterial(
        PATH_BACKWARD_COLOR,
        PATH_BACKWARD_POLYGON_OFFSET_UNITS,
      )
      const arrowForwardMaterial = createMarkingMaterial(
        CHEVRON_FORWARD_COLOR,
        ARROW_FORWARD_POLYGON_OFFSET_UNITS,
      )
      const arrowBackwardMaterial = createMarkingMaterial(
        CHEVRON_BACKWARD_COLOR,
        ARROW_BACKWARD_POLYGON_OFFSET_UNITS,
      )
      const nodeDotMaterial = createMarkingMaterial(NODE_DOT_COLOR, NODE_DOT_POLYGON_OFFSET_UNITS)
      const stationRingMaterial = createColoredInstanceMaterial(STATION_RING_POLYGON_OFFSET_UNITS)
      const stationDirectionMaterial = createColoredInstanceMaterial(
        STATION_DIRECTION_POLYGON_OFFSET_UNITS,
      )
      owned.push(
        pathForwardMaterial,
        pathBackwardMaterial,
        arrowForwardMaterial,
        arrowBackwardMaterial,
        nodeDotMaterial,
        stationRingMaterial,
        stationDirectionMaterial,
      )

      // §7.5：2 个路径 Mesh + 5 个 InstancedMesh = 主 pass 7 draw call
      const pathForwardMesh = new Mesh(batches.paths.forward, pathForwardMaterial)
      markMapElement(pathForwardMesh)
      const pathBackwardMesh = new Mesh(batches.paths.backward, pathBackwardMaterial)
      markMapElement(pathBackwardMesh)
      const arrowForwardMesh = assembleInstancedMesh(
        batches.arrows.forward,
        chevronGeometry,
        arrowForwardMaterial,
      )
      const arrowBackwardMesh = assembleInstancedMesh(
        batches.arrows.backward,
        chevronGeometry,
        arrowBackwardMaterial,
      )
      const nodeDotMesh = assembleInstancedMesh(batches.nodes.dots, diskGeometry, nodeDotMaterial)
      const stationRingMesh = assembleColoredInstancedMesh(
        batches.nodes.rings,
        ringGeometry,
        stationRingMaterial,
      )
      const stationDirectionMesh = assembleColoredInstancedMesh(
        batches.nodes.directions,
        directionGeometry,
        stationDirectionMaterial,
      )

      disposables = owned
      snapshot = {
        pathForwardMesh,
        pathBackwardMesh,
        arrowForwardMesh,
        arrowBackwardMesh,
        nodeDotMesh,
        stationRingMesh,
        stationDirectionMesh,
      }
      return { ok: true, snapshot }
    },

    dispose(): void {
      release()
    },

    get current(): MapSceneSnapshot | null {
      return snapshot
    },
  }
}
