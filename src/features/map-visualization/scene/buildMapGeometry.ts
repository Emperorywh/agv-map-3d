/**
 * 物理路径去重与静态地图几何（SPEC §2.2、§5.1；TASK-004；视觉对齐 P0-5.3
 * 道路拓扑重建、P0-5.4 节点角色烘焙）。
 *
 * 职责：
 * 1. dedupePhysicalPaths：把有向逻辑边按「正/反向几何归一后相同」的签名去重，
 *    生成物理路径集合（当前地图 9,265 条逻辑边 → 5,068 条物理路径），并保留
 *    逻辑边 → 物理路径的完整映射（方向、限速与拓扑语义仍留在逻辑边上）；
 * 2. buildRoadNetwork（P0-5.3）：在物理路径之上重建展示级道路网络——穿越
 *    二度节点合并连续链、识别交叉节点，见 roadTopology.ts；
 * 3. buildMapGeometry：在世界坐标下把道路网络离散化为静态合批几何——每条
 *    链一条连续路面条带、只在断头端（一度节点）补圆帽、每个交叉节点一个
 *    路口圆盘补面（P0-5.3），中线虚线在链端与路口补面范围内截除；并生成
 *    全部节点的实例矩阵、颜色与「最低可见场景等级」（P0-5.4，供场景 LOD
 *    在 GPU 侧按角色显隐）。
 * 边界：输入必须来自 createMapModel 的只读 MapModel（已校验、有限坐标）；
 *       本模块不创建 Mesh/材质、不进 React、不做拓扑寻路；图层高度等外观
 *       常量来自 mapAppearance。
 * 关键不变量：
 * 1. 归一化签名只由几何坐标决定：BEZIER 反向 = 端点与控制点整体逆序；同一
 *    节点对之间几何不同的平行路径不会被合并（不得按节点对去重，SPEC §2.2）；
 * 2. BEZIER 固定采样 BEZIER_SAMPLE_SEGMENTS=24 段（全应用唯一离散化口径，
 *    与逻辑边物理长度共用 sampleCubicBezier）；链合并只拼接采样点，不改变
 *    任何路径的离散化；
 * 3. 每条物理路径恰好进入一条链（roadTopology 不变量），路面几何不再在
 *    二度节点处出现端帽叠片；交叉节点只补一个圆盘，路口内部无重复虚线；
 * 4. 静态几何顶点全部位于世界坐标并已烘焙图层高度（见 mapAppearance 阶梯），
 *    图层组件以零位移原样上载；本模块创建的 BufferGeometry 由返回值上的
 *    dispose() 明确释放（资源所有权：创建者释放）；
 * 5. 路面条带为共享顶点 polyline strip：关节顶点 = 相邻段平均法线 + 斜接
 *    长度补偿（钳制 3× 半宽）；链的交叉端沿末段方向延伸半路宽，使平切口
 *    没入路口补面之下，任何来向的道路与补面之间不出现楔形缺口；
 * 6. 节点实例的 minLevels = ROLE_MIN_SCENE_LEVEL[visualRole]（角色缺失回退
 *    landmark=全可见），矩阵与颜色仍与 nodeList 顺序一致。
 */
import * as THREE from 'three'
import type { MapModel, MapEdge, EdgeType } from '../model/types'
import {
  BEZIER_SAMPLE_SEGMENTS,
  sampleCubicBezier,
  type PlanePoint2,
} from '../model/edgeGeometry'
import type { WorldTransform } from '@/shared/spatial'
import { buildRoadNetwork, type RoadNetwork } from './roadTopology'
import { ROLE_MIN_SCENE_LEVEL } from './sceneDetail'
import {
  CENTERLINE_DASH_OFF_M,
  CENTERLINE_DASH_ON_M,
  JUNCTION_PAD_SCALE,
  JUNCTION_PAD_SEGMENTS,
  NODE_COLORS,
  NODE_Y,
  PATH_CENTERLINE_Y,
  PATH_SURFACE_WIDTH_M,
  PATH_SURFACE_Y,
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

/** 节点实例静态数据：列主序平移矩阵、RGB 颜色与最低可见场景等级 */
export interface NodeInstanceData {
  readonly count: number
  /** 列主序 4×4 矩阵数组，长度 16×count；仅含平移（站点为正圆，无朝向） */
  readonly matrices: Float32Array
  /** RGB 颜色数组，长度 3×count（instanceColor 直读） */
  readonly colors: Float32Array
  /** 最低可见场景等级（P0-5.4）：实例属性 aMinLevel 直读，场景等级 ≥ 值可见 */
  readonly minLevels: Float32Array
}

/** 已构建的静态地图几何与节点实例数据（GPU 资源由本对象拥有并释放） */
export interface MapGeometry {
  /** 物理路径路面条带（三角形合批，静态） */
  readonly pathsSurface: THREE.BufferGeometry
  /** 物理路径中线虚线（LineSegments 合批，静态） */
  readonly pathsCenterline: THREE.BufferGeometry
  /** 节点实例矩阵/颜色/场景等级（图层据此创建唯一 InstancedMesh） */
  readonly nodeInstances: NodeInstanceData
  /** 物理路径去重明细（供诊断与后续图层复用） */
  readonly physical: PhysicalPathIndex
  /** 展示级道路网络（P0-5.3：链与交叉节点；诊断与测试用） */
  readonly network: RoadNetwork
  /** 释放本对象创建的全部 GPU 几何；幂等，调用后对象不再可用 */
  dispose(): void
}

/**
 * 构建世界坐标静态地图几何。
 * 世界坐标由统一 WorldTransform 变换（原点为地图包围盒中心，已一次定型），
 * 图层高度由 mapAppearance 阶梯直接烘焙进顶点。
 *
 * 道路拓扑（P0-5.3）：链式条带替代逐物理路径条带——二度节点处道路连续、
 * 无端帽叠片；断头端（一度节点）补半径 = 半路宽的圆帽；交叉节点（度数 ≥3）
 * 各补一个半径 = JUNCTION_PAD_SCALE × 半路宽的圆盘补面，链端沿末段延伸
 * 半路宽没入补面，消除花瓣/鼓包/楔形缺口。虚线中线在链端向内截除（断头
 * 端截半路宽、交叉端截补面半径），路口内部不再出现重复虚线。
 */
export function buildMapGeometry(
  mapModel: MapModel,
  worldTransform: WorldTransform,
): MapGeometry {
  const physical = dedupePhysicalPaths(mapModel)
  const network = buildRoadNetwork(mapModel, physical)

  const surfacePositions: number[] = []
  const surfaceIndices: number[] = []
  const centerlinePositions: number[] = []
  const halfWidth = PATH_SURFACE_WIDTH_M / 2
  const junctionPadRadius = halfWidth * JUNCTION_PAD_SCALE

  const junctionNodeIds = new Set(network.junctions.map((j) => j.nodeId))
  const isJunctionNode = (nodeId: string): boolean => junctionNodeIds.has(nodeId)

  for (const chain of network.chains) {
    const worldPoints = chain.points.map((p) => worldTransform.toWorldXZ(p.x, p.y))
    const junctionStart = isJunctionNode(chain.startNodeId)
    const junctionEnd = isJunctionNode(chain.endNodeId)

    // 交叉端沿末段延伸半路宽：平切口没入路口补面（P0-5.3 不变量 5）
    const stripPoints = extendPolylineEnds(
      worldPoints,
      junctionStart ? halfWidth : 0,
      junctionEnd ? halfWidth : 0,
    )
    appendPolylineStrip(
      surfacePositions,
      surfaceIndices,
      stripPoints,
      halfWidth,
      PATH_SURFACE_Y,
      { capStart: !junctionStart, capEnd: !junctionEnd },
    )

    // 虚线中线：断头端截半路宽（圆帽范围无线），交叉端截补面半径
    appendDashedCenterline(
      centerlinePositions,
      worldPoints,
      junctionStart ? junctionPadRadius : halfWidth,
      junctionEnd ? junctionPadRadius : halfWidth,
    )
  }

  // 路口补面：每个交叉节点一个圆盘（P0-5.3 不变量 3）
  for (const junction of network.junctions) {
    const world = worldTransform.toWorldXZ(junction.x, junction.y)
    appendDisc(
      surfacePositions,
      surfaceIndices,
      world.x,
      world.z,
      junctionPadRadius,
      PATH_SURFACE_Y,
      JUNCTION_PAD_SEGMENTS,
    )
  }

  const pathsSurface = new THREE.BufferGeometry()
  pathsSurface.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(surfacePositions, 3),
  )
  pathsSurface.setIndex(surfaceIndices)
  pathsSurface.computeBoundingSphere()

  const pathsCenterline = new THREE.BufferGeometry()
  pathsCenterline.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(centerlinePositions, 3),
  )
  pathsCenterline.computeBoundingSphere()

  const nodeInstances = buildNodeInstances(mapModel, worldTransform)

  let disposed = false
  return {
    pathsSurface,
    pathsCenterline,
    nodeInstances,
    physical,
    network,
    dispose() {
      // 幂等释放：重复调用不得抛错（StrictMode 卸载与原子替换都会触发）
      if (disposed) {
        return
      }
      disposed = true
      pathsSurface.dispose()
      pathsCenterline.dispose()
    },
  }
}

/**
 * 沿首末段方向把折线两端各延伸指定长度（米）：返回新数组，原数组不变。
 * 延伸点与相邻段共线，条带在该端只是变长；首末段退化（零长度）时不延伸。
 */
function extendPolylineEnds(
  worldPoints: readonly { readonly x: number; readonly z: number }[],
  extendStartM: number,
  extendEndM: number,
): readonly { readonly x: number; readonly z: number }[] {
  if (extendStartM === 0 && extendEndM === 0) {
    return worldPoints
  }
  const points = [...worldPoints]
  if (extendStartM > 0) {
    const first = outwardDirection(points, false)
    if (first !== null) {
      points[0] = {
        x: points[0].x - first.x * extendStartM,
        z: points[0].z - first.z * extendStartM,
      }
    }
  }
  if (extendEndM > 0) {
    const last = outwardDirection(points, true)
    if (last !== null) {
      points[points.length - 1] = {
        x: points[points.length - 1].x + last.x * extendEndM,
        z: points[points.length - 1].z + last.z * extendEndM,
      }
    }
  }
  return points
}

/**
 * 折线端部的向外延伸方向：fromStart=false 取首个与端点不重合的点指向链内
 * 的方向；fromStart=true 取末端的对应方向。全部点与端点重合时返回 null。
 */
function outwardDirection(
  points: readonly { readonly x: number; readonly z: number }[],
  fromEnd: boolean,
): { readonly x: number; readonly z: number } | null {
  const n = points.length
  if (n < 2) {
    return null
  }
  if (!fromEnd) {
    const p0 = points[0]
    for (let i = 1; i < n; i += 1) {
      const dx = points[i].x - p0.x
      const dz = points[i].z - p0.z
      const length = Math.hypot(dx, dz)
      if (length > 0) {
        return { x: dx / length, z: dz / length }
      }
    }
    return null
  }
  const pn = points[n - 1]
  for (let i = n - 2; i >= 0; i -= 1) {
    const dx = pn.x - points[i].x
    const dz = pn.z - points[i].z
    const length = Math.hypot(dx, dz)
    if (length > 0) {
      return { x: dx / length, z: dz / length }
    }
  }
  return null
}

/** 追加一个贴地圆盘（三角扇）：路口补面使用 */
function appendDisc(
  positions: number[],
  indices: number[],
  centerX: number,
  centerZ: number,
  radius: number,
  y: number,
  segments: number,
): void {
  const center = positions.length / 3
  positions.push(centerX, y, centerZ)
  for (let k = 0; k < segments; k += 1) {
    const angle = (k / segments) * Math.PI * 2
    positions.push(
      centerX + Math.cos(angle) * radius,
      y,
      centerZ + Math.sin(angle) * radius,
    )
  }
  for (let k = 0; k < segments; k += 1) {
    indices.push(center, center + 1 + k, center + 1 + ((k + 1) % segments))
  }
}

/** 条带端帽选项：起点/终点是否补半径 = 半路宽的圆片（盖住断头端） */
export interface PolylineStripCaps {
  readonly capStart: boolean
  readonly capEnd: boolean
}

/** 折线的斜接骨架：关节点与每个关节的展开偏移（斜接长度补偿后） */
interface StripJointFrames {
  readonly joints: readonly { readonly x: number; readonly z: number }[]
  readonly jointOffsetX: readonly number[]
  readonly jointOffsetZ: readonly number[]
}

/**
 * 计算折线条带的斜接骨架：关节展开方向取相邻段法线平均，并按 1/cos(半角)
 * 补偿斜接长度（钳制 3×halfWidth 防止近回折处的退化放大）。路面条带与
 * 路缘边线条带（P1-4）共用同一骨架，保证边线精确贴合路面边缘。
 */
function stripJointFrames(
  worldPoints: readonly { readonly x: number; readonly z: number }[],
  halfWidth: number,
): StripJointFrames {
  // 有效段方向（跳过零长度段）：dir = normalize(b - a)，左法线 = (-dz, dx)
  const dirX: number[] = []
  const dirZ: number[] = []
  const joints: { x: number; z: number }[] = []
  for (let i = 1; i < worldPoints.length; i += 1) {
    const a = worldPoints[i - 1]
    const b = worldPoints[i]
    const dx = b.x - a.x
    const dz = b.z - a.z
    const length = Math.hypot(dx, dz)
    if (length === 0) {
      continue
    }
    if (joints.length === 0) {
      joints.push(a)
    }
    joints.push(b)
    dirX.push(dx / length)
    dirZ.push(dz / length)
  }

  /** 关节展开偏移：首末关节用相邻段法线，内部关节用平均法线 + 斜接补偿 */
  const jointOffsetX: number[] = []
  const jointOffsetZ: number[] = []
  const MAX_MITER_SCALE = 3
  for (let j = 0; j < joints.length; j += 1) {
    let nx: number
    let nz: number
    if (j === 0) {
      nx = -dirZ[0]
      nz = dirX[0]
    } else if (j === joints.length - 1) {
      nx = -dirZ[dirZ.length - 1]
      nz = dirX[dirX.length - 1]
    } else {
      // 平均相邻两段的左法线；近回折（dot ≤ 0）时退化为单侧法线
      const ax = -dirZ[j - 1]
      const az = dirX[j - 1]
      const bx = -dirZ[j]
      const bz = dirX[j]
      nx = ax + bx
      nz = az + bz
      const len = Math.hypot(nx, nz)
      if (len > 1e-6 && (ax * bx + az * bz) > 0) {
        nx /= len
        nz /= len
      } else {
        nx = ax
        nz = az
      }
    }
    // 斜接长度补偿：偏移沿平均法线，需除以与段法线夹角的余弦才能到达 halfWidth
    const first = j === 0 ? 0 : j - 1
    const cosHalf = Math.max(nx * -dirZ[first] + nz * dirX[first], 1 / MAX_MITER_SCALE)
    const miter = halfWidth / cosHalf
    jointOffsetX.push(nx * miter)
    jointOffsetZ.push(nz * miter)
  }
  return { joints, jointOffsetX, jointOffsetZ }
}

/**
 * 把世界坐标折线按 halfWidth 展开为共享顶点条带并追加进位置/索引累积数组。
 * 关节顶点取相邻段法线的平均方向，并按 1/cos(半角) 补偿斜接长度（钳制到
 * 3×halfWidth 防止近回折处的退化放大）——同一路径的弯道无逐段接缝毛边。
 * capStart/capEnd 为真时在首末端点补圆片端帽（三角扇）。零长度段被跳过；
 * 全部顶点烘焙同一高度 y。独占区外沿条带（buildExclusiveGroupsGeometry）
 * 复用同一展开，保证路面与蓝色外沿在弯道/路口的覆盖关系一致。
 */
export function appendPolylineStrip(
  positions: number[],
  indices: number[],
  worldPoints: readonly { readonly x: number; readonly z: number }[],
  halfWidth: number,
  y: number,
  caps: PolylineStripCaps,
): void {
  const { joints, jointOffsetX, jointOffsetZ } = stripJointFrames(worldPoints, halfWidth)
  if (joints.length === 0) {
    return
  }
  const segmentCount = joints.length - 1

  // 关节顶点对：偶数位 = 中心 + 偏移，奇数位 = 中心 − 偏移；段四边形共享关节对
  const base = positions.length / 3
  for (let j = 0; j < joints.length; j += 1) {
    positions.push(
      joints[j].x + jointOffsetX[j], y, joints[j].z + jointOffsetZ[j],
      joints[j].x - jointOffsetX[j], y, joints[j].z - jointOffsetZ[j],
    )
  }
  for (let s = 0; s < segmentCount; s += 1) {
    const a = base + s * 2
    const b = base + s * 2 + 2
    indices.push(a, a + 1, b + 1, a, b + 1, b)
  }

  const appendCap = (centerIndex: number): void => {
    // 端帽圆盘中心 = 路径端点本身（关节边缘顶点偏在 ±halfWidth 一侧，不可复用）
    const capCenter = positions.length / 3
    positions.push(joints[centerIndex].x, y, joints[centerIndex].z)
    const ringStart = capCenter + 1
    const SEGMENTS = 16
    for (let k = 0; k < SEGMENTS; k += 1) {
      const angle = (k / SEGMENTS) * Math.PI * 2
      positions.push(
        joints[centerIndex].x + Math.cos(angle) * halfWidth,
        y,
        joints[centerIndex].z + Math.sin(angle) * halfWidth,
      )
    }
    for (let k = 0; k < SEGMENTS; k += 1) {
      indices.push(capCenter, ringStart + k, ringStart + (k + 1) % SEGMENTS)
    }
  }
  if (caps.capStart) {
    appendCap(0)
  }
  if (caps.capEnd) {
    appendCap(joints.length - 1)
  }
}

/**
 * 虚线中线（P1-4；P0-5.3 增加端部截除）：按弧长把折线切成「DASH_ON 实段 +
 * DASH_OFF 空段」，相位跨关节连续（弯道处虚线不断裂重启）；[trimStartM,
 * 总长 − trimEndM] 弧长范围之外的相位照常推进但不产生顶点——断头端圆帽与
 * 路口补面范围内不出现虚线。零长度段跳过；全部顶点烘焙同一高度 y，输出为
 * LineSegments 的成对端点序列。
 */
function appendDashedCenterline(
  positions: number[],
  worldPoints: readonly { readonly x: number; readonly z: number }[],
  trimStartM: number,
  trimEndM: number,
): void {
  const period = CENTERLINE_DASH_ON_M + CENTERLINE_DASH_OFF_M
  let totalLength = 0
  for (let i = 1; i < worldPoints.length; i += 1) {
    totalLength += Math.hypot(
      worldPoints[i].x - worldPoints[i - 1].x,
      worldPoints[i].z - worldPoints[i - 1].z,
    )
  }
  const keepFrom = Math.min(trimStartM, totalLength)
  const keepTo = Math.max(totalLength - trimEndM, keepFrom)

  let arcLength = 0
  let phase = 0
  for (let i = 1; i < worldPoints.length; i += 1) {
    const a = worldPoints[i - 1]
    const b = worldPoints[i]
    const dx = b.x - a.x
    const dz = b.z - a.z
    const length = Math.hypot(dx, dz)
    // 零长度段不产生几何（校验层保证长度为正，此处兜底防退化）
    if (length === 0) {
      continue
    }
    const ux = dx / length
    const uz = dz / length
    let t = 0
    while (t < length) {
      const inDash = phase < CENTERLINE_DASH_ON_M
      const remainingPhase = inDash ? CENTERLINE_DASH_ON_M - phase : period - phase
      const step = Math.min(remainingPhase, length - t)
      if (inDash) {
        // 端部截除：实段与可见弧长窗口求交，交叠部分才产生顶点
        const from = Math.max(arcLength + t, keepFrom)
        const to = Math.min(arcLength + t + step, keepTo)
        if (to > from) {
          positions.push(
            a.x + ux * (from - arcLength), PATH_CENTERLINE_Y, a.z + uz * (from - arcLength),
            a.x + ux * (to - arcLength), PATH_CENTERLINE_Y, a.z + uz * (to - arcLength),
          )
        }
      }
      t += step
      phase = (phase + step) % period
    }
    arcLength += length
  }
}

/** 生成全部节点的实例矩阵、颜色与最低可见场景等级：顺序与 nodeList 一致 */
function buildNodeInstances(
  mapModel: MapModel,
  worldTransform: WorldTransform,
): NodeInstanceData {
  const count = mapModel.nodeList.length
  const matrices = new Float32Array(count * 16)
  const colors = new Float32Array(count * 3)
  const minLevels = new Float32Array(count)
  const colorScratch = new THREE.Color()

  for (let i = 0; i < count; i += 1) {
    const node = mapModel.nodeList[i]
    const world = worldTransform.toWorldXZ(node.x, node.y)
    const m = i * 16
    // 列主序单位矩阵，仅平移（节点是正圆站点，不使用可能为 null 的 angle）
    matrices[m] = 1
    matrices[m + 5] = 1
    matrices[m + 10] = 1
    matrices[m + 12] = world.x
    matrices[m + 13] = NODE_Y
    matrices[m + 14] = world.z
    matrices[m + 15] = 1

    colorScratch.set(NODE_COLORS[node.category])
    const c = i * 3
    colors[c] = colorScratch.r
    colors[c + 1] = colorScratch.g
    colors[c + 2] = colorScratch.b

    // P0-5.4：角色 → 最低可见场景等级（角色缺失回退 landmark = 全可见）
    const role = mapModel.nodeVisualRoles?.get(node.id) ?? 'landmark'
    minLevels[i] = ROLE_MIN_SCENE_LEVEL[role]
  }

  return { count, matrices, colors, minLevels }
}
