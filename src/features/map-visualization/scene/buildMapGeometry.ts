/**
 * 静态地图几何：物理路径去重、分级道路包络与节点实例。
 * 展示道路不改变逻辑边、真实采样或方向，地图运行时统一拥有并释放几何资源。
 */
import * as THREE from 'three'
import type { MapModel, MapEdge, EdgeType, NodeCategory } from '../model/types'
import {
  BEZIER_SAMPLE_SEGMENTS,
  sampleCubicBezier,
  type PlanePoint2,
} from '../model/edgeGeometry'
import type { WorldTransform } from '@/shared/spatial'
import { buildRoadNetwork, type RoadNetwork } from './roadTopology'
import { ROLE_MIN_SCENE_LEVEL } from './sceneDetail'
import { NodeMarkerLayout } from './nodeMarkerLayout'
import { buildRoadGeometry, type RoadGeometry } from './roadGeometry'
import { classifyRoadPaths, type RoadRoleOverrides, type RoadRole } from './roadPresentation'
import {
  NODE_COLORS,
  NODE_OUTER_RADIUS_M,
  NODE_REGULAR_SCALE,
  NODE_Y,
} from './mapAppearance'

/** 一条去重后的物理路径（几何与其覆盖的逻辑边集合） */
export interface PhysicalPath {
  /** 物理路径序号：按代表逻辑边的首次出现顺序稳定编号 */
  readonly index: number
  readonly edgeType: EdgeType
  /** 首次出现的代表逻辑边 ID（诊断与映射锚点） */
  readonly representativeEdgeId: string
  /** 几何与该路径重合的全部逻辑边 ID（正、反向都计入） */
  readonly logicalEdgeIds: readonly string[]
  /** 归一化方向下的平面采样点：LINE 2 个点，BEZIER 24+1 个点（米） */
  readonly points: readonly PlanePoint2[]
}

/** 物理路径去重结果（纯数据，不含 Three.js 对象） */
export interface PhysicalPathIndex {
  readonly physicalPaths: readonly PhysicalPath[]
  /** 逻辑边 ID → 物理路径 index（覆盖全部逻辑边，无遗漏） */
  readonly physicalPathIndexOfEdge: ReadonlyMap<string, number>
  /** 被去重掉的重复几何逻辑边数（逻辑边总数 − 物理路径数） */
  readonly duplicateEdgeCount: number
  /** 中心线段总数（LINE 每条 1 段、BEZIER 每条 24 段之和） */
  readonly centerSegmentCount: number
}

/** 逻辑边正向几何坐标序列（LINE 4 个数、BEZIER 8 个数） */
function edgeForwardCoords(edge: MapEdge): number[] {
  if (edge.edgeType === 'LINE') {
    return [edge.sx, edge.sy, edge.ex, edge.ey]
  }
  // BEZIER 控制点已由 validateMap 保证为非空有限数值
  return [
    edge.sx,
    edge.sy,
    edge.cx as number,
    edge.cy as number,
    edge.dx as number,
    edge.dy as number,
    edge.ex,
    edge.ey,
  ]
}

/**
 * 逻辑边反向几何坐标序列：按「点对」逆序（s→c→d→e 变为 e→d→c→s），
 * 不得使用扁平数组 reverse——那会把单个数字反转成错误坐标对。
 */
function edgeBackwardCoords(edge: MapEdge): number[] {
  if (edge.edgeType === 'LINE') {
    return [edge.ex, edge.ey, edge.sx, edge.sy]
  }
  return [
    edge.ex,
    edge.ey,
    edge.dx as number,
    edge.dy as number,
    edge.cx as number,
    edge.cy as number,
    edge.sx,
    edge.sy,
  ]
}

/**
 * 物理路径去重：按归一化几何签名合并正反向重合的逻辑边。
 * 签名取「正向坐标序列」与「逆向坐标序列」中字典序较小者的序列化字符串；
 * 字符串比较只用于选方向与判等，不解析回数值。
 */
export function dedupePhysicalPaths(mapModel: MapModel): PhysicalPathIndex {
  const physicalPaths: PhysicalPath[] = []
  const indexByKey = new Map<string, number>()
  const physicalPathIndexOfEdge = new Map<string, number>()
  let centerSegmentCount = 0

  for (const edge of mapModel.edgeList) {
    const forward = edgeForwardCoords(edge)
    const backward = edgeBackwardCoords(edge)
    const forwardKey = forward.join(',')
    const backwardKey = backward.join(',')
    // 归一化方向：两种读法中字典序较小者作为该几何的唯一签名
    const useForward = forwardKey <= backwardKey
    const key = useForward ? forwardKey : backwardKey

    const existingIndex = indexByKey.get(key)
    if (existingIndex !== undefined) {
      const existing = physicalPaths[existingIndex]
      // 复用既有物理路径：仅追加逻辑边映射，几何不重复入批
      physicalPaths[existingIndex] = {
        ...existing,
        logicalEdgeIds: Object.freeze([...existing.logicalEdgeIds, edge.id]),
      }
      physicalPathIndexOfEdge.set(edge.id, existingIndex)
      continue
    }

    const points = useForward
      ? sampleEdgePoints(edge)
      : sampleEdgePoints(edge).slice().reverse()
    const index = physicalPaths.length
    indexByKey.set(key, index)
    physicalPaths.push({
      index,
      edgeType: edge.edgeType,
      representativeEdgeId: edge.id,
      logicalEdgeIds: Object.freeze([edge.id]),
      points: Object.freeze(points),
    })
    physicalPathIndexOfEdge.set(edge.id, index)
    centerSegmentCount += points.length - 1
  }

  return {
    physicalPaths: Object.freeze(physicalPaths),
    physicalPathIndexOfEdge,
    duplicateEdgeCount: mapModel.edgeList.length - physicalPaths.length,
    centerSegmentCount,
  }
}

/** 逻辑边在自身方向下的平面采样点（LINE 两端点；BEZIER 24+1 个采样点） */
function sampleEdgePoints(edge: MapEdge): PlanePoint2[] {
  if (edge.edgeType === 'LINE') {
    return [
      { x: edge.sx, y: edge.sy },
      { x: edge.ex, y: edge.ey },
    ]
  }
  return sampleCubicBezier(
    edge.sx,
    edge.sy,
    edge.cx as number,
    edge.cy as number,
    edge.dx as number,
    edge.dy as number,
    edge.ex,
    edge.ey,
    BEZIER_SAMPLE_SEGMENTS,
  )
}

/**
 * 节点实例静态数据：列主序矩阵、RGB 颜色与最低可见场景等级。
 * 矩阵包含密集邻域的水平缩放，真实坐标及圆台高度保持原值。
 */
export interface NodeInstanceData {
  readonly count: number
  /**
   * 类别与原始 nodeList 一一对应，仅供图层按 type 合批不同轮廓和图标。
   * 不使用展示角色替代类别，工作站不会因为位于巷道中间而画成库区。
   */
  readonly categories: readonly NodeCategory[]
  /** 列主序 4×4 矩阵数组，长度 16×count；平移与 x/z 等比缩放 */
  readonly matrices: Float32Array
  /** RGB 颜色数组，长度 3×count（instanceColor 直读） */
  readonly colors: Float32Array
  /** 最低可见场景等级（P0-5.4）：实例属性 aMinLevel 直读，场景等级 ≥ 值可见 */
  readonly minLevels: Float32Array
}

/** 已构建的静态地图几何（GPU 资源由本对象拥有并释放） */
export interface MapGeometry extends RoadGeometry {
  /**
   * 物理路径的展示级别独立保存，便于诊断或按逻辑边覆盖。
   * 不写入 MapModel，也不用于调度通行能力判断。
   */
  readonly roadRoles: ReadonlyMap<number, RoadRole>
  /**
   * 节点静态实例数据按类别合批，最多五种业务类型加一个未知兜底批次。
   * 批次数不随节点总量增长，逻辑节点顺序与地图身份保持不变。
   */
  readonly nodeInstances: NodeInstanceData
  /** 物理路径去重明细（供诊断与后续图层复用） */
  readonly physical: PhysicalPathIndex
  /** 展示级道路网络（链与交叉节点；诊断与测试用） */
  readonly network: RoadNetwork
  /** 释放本对象创建的全部 GPU 几何；幂等，调用后对象不再可用 */
  dispose(): void
}

/**
 * 地图构建阶段保留拓扑诊断，并对全部物理路径生成路面，逐帧只消费静态合批。
 * 方向信息完整留在 physical.logicalEdgeIds 与只读 MapModel，不再生成箭头。
 */
export function buildMapGeometry(
  mapModel: MapModel,
  worldTransform: WorldTransform,
  roadRoleOverrides?: RoadRoleOverrides,
): MapGeometry {
  const physical = dedupePhysicalPaths(mapModel)
  const network = buildRoadNetwork(mapModel, physical)
  const roadRoles = classifyRoadPaths(mapModel, physical, network, roadRoleOverrides)
  const roads = buildRoadGeometry(mapModel, physical, network, roadRoles, worldTransform)
  const nodeInstances = buildNodeInstances(mapModel, worldTransform, new NodeMarkerLayout(mapModel, worldTransform))
  let disposed = false
  return {
    ...roads,
    roadRoles,
    nodeInstances,
    physical,
    network,
    dispose() {
      /**
       * 幂等释放全部道路批次；节点实例为普通数组，不拥有独立 GPU 几何。
       * 上下文恢复与地图原子替换继续复用原有生命周期。
       */
      if (disposed) return
      disposed = true
      roads.roadSurface.dispose()
      roads.roadBoundaries.dispose()
      roads.roadGuides.dispose()
      roads.roadJunctionLights.dispose()
    },
  }
}

/** 生成全部节点的实例矩阵、颜色与最低可见场景等级：顺序与 nodeList 一致 */
function buildNodeInstances(
  mapModel: MapModel,
  worldTransform: WorldTransform,
  markingLayout: NodeMarkerLayout,
): NodeInstanceData {
  const count = mapModel.nodeList.length
  const matrices = new Float32Array(count * 16)
  const colors = new Float32Array(count * 3)
  const minLevels = new Float32Array(count)
  const categories: NodeCategory[] = []
  const colorScratch = new THREE.Color()

  for (let i = 0; i < count; i += 1) {
    const node = mapModel.nodeList[i]
    const world = worldTransform.toWorldXZ(node.x, node.y)
    const m = i * 16
    /**
     * 仅压缩密集节点的水平半径；高度与业务坐标保持原值。
     * 实例矩阵是静态数据，包围球和拾取继续使用 Three.js 的实例变换。
     */
    const radius = markingLayout.nodes.get(node.id)?.radius ?? NODE_OUTER_RADIUS_M
    const scale = radius / NODE_OUTER_RADIUS_M * (node.category === 'node' ? NODE_REGULAR_SCALE : 1)
    matrices[m] = scale
    matrices[m + 5] = 1
    matrices[m + 10] = scale
    matrices[m + 12] = world.x
    matrices[m + 13] = NODE_Y
    matrices[m + 14] = world.z
    matrices[m + 15] = 1

    colorScratch.set(NODE_COLORS[node.category])
    categories.push(node.category)
    const c = i * 3
    colors[c] = colorScratch.r
    colors[c + 1] = colorScratch.g
    colors[c + 2] = colorScratch.b

    // P0-5.4：角色 → 最低可见场景等级（角色缺失回退 landmark = 全可见）
    const role = mapModel.nodeVisualRoles?.get(node.id) ?? 'landmark'
    minLevels[i] = ROLE_MIN_SCENE_LEVEL[role]
  }

  return { count, categories: Object.freeze(categories), matrices, colors, minLevels }
}
