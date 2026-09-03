/**
 * 物理路径去重、路径几何与节点实例静态数据（SPEC §2.2、§5.1；TASK-004；
 * 实体道路俯视表达：沥青路面 + 双侧路缘 + 黄色中心线 + 方向箭头）。
 *
 * 职责：
 * 1. dedupePhysicalPaths：把有向逻辑边按「正/反向几何归一后相同」的签名去重，
 *    生成物理路径集合（当前地图 9,265 条逻辑边 → 5,068 条物理路径），并保留
 *    逻辑边 → 物理路径的完整映射（方向、限速与拓扑语义仍留在逻辑边上）；
 * 2. buildMapGeometry：在世界坐标烘焙五份合批静态几何——
 *    a. pathsSurface：链式路面条带 + 断头端圆帽 + 路口补面圆盘；
 *    b. pathEdgeCores：浅色路缘压边条带（道路内部重叠段被空间索引裁掉，
 *       路口只保留联合外缘弧、断头端以半圆弧包边）；
 *    c. pathEdgeHalos：路缘下方较宽的混凝土路肩条带；
 *    d. pathCenterLines：沿每条物理路径连接两个节点的黄色连续中心实线；
 *    e. pathDirectionArrows：按逻辑边方向在各自起点 30% 弧长处绘制的箭头；
 *    另生成全部节点的实例矩阵、颜色与「最低可见场景等级」（P0-5.4）。
 * 边界：输入必须来自 createMapModel 的只读 MapModel（已校验、有限坐标）；
 *       本模块不进 React、不做拓扑寻路；图层高度等外观常量来自 mapAppearance。
 * 关键不变量：
 * 1. 归一化签名只由几何坐标决定：BEZIER 反向 = 端点与控制点整体逆序；同一
 *    节点对之间几何不同的平行路径不会被合并（不得按节点对去重，SPEC §2.2）；
 * 2. BEZIER 固定采样 BEZIER_SAMPLE_SEGMENTS=24 段（全应用唯一离散化口径，
 *    与逻辑边物理长度共用 sampleCubicBezier）；
 * 3. 物理路径只绘制一条中心实线，但方向按逻辑边去重保留；同一几何上的
 *    正反向逻辑边分别在归一化路径的 30% 与 70% 处生成相反箭头；
 * 4. 节点实例的 minLevels = ROLE_MIN_SCENE_LEVEL[visualRole]（角色缺失回退
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
  JUNCTION_PAD_SCALE,
  JUNCTION_PAD_SEGMENTS,
  NODE_COLORS,
  NODE_Y,
  PATH_CENTER_LINE_WIDTH_M,
  PATH_CENTER_LINE_Y,
  PATH_DIRECTION_ARROW_HEAD_HALF_WIDTH_M,
  PATH_DIRECTION_ARROW_HEAD_LENGTH_M,
  PATH_DIRECTION_ARROW_LENGTH_M,
  PATH_DIRECTION_ARROW_POSITION_RATIO,
  PATH_DIRECTION_ARROW_SHAFT_HALF_WIDTH_M,
  PATH_DIRECTION_ARROW_Y,
  PATH_EDGE_HALO_WIDTH_M,
  PATH_EDGE_HALO_Y,
  PATH_EDGE_WIDTH_M,
  PATH_EDGE_Y,
  PATH_END_ARC_SEGMENTS,
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

/** 已构建的静态地图几何（GPU 资源由本对象拥有并释放） */
export interface MapGeometry {
  /** 路面条带（链式 + 断头端帽 + 路口补面，三角形合批，静态） */
  readonly pathsSurface: THREE.BufferGeometry
  /** 浅色路缘压边（含裁剪后的路口外缘弧与断头端弧，三角形合批，静态） */
  readonly pathEdgeCores: THREE.BufferGeometry
  /** 混凝土路肩基座条带（三角形合批，静态） */
  readonly pathEdgeHalos: THREE.BufferGeometry
  /** 节点间黄色连续中心实线（三角形合批，静态） */
  readonly pathCenterLines: THREE.BufferGeometry
  /** 各逻辑方向起点 30% 弧长处的黄色方向箭头（三角形合批，静态） */
  readonly pathDirectionArrows: THREE.BufferGeometry
  /** 节点实例矩阵/颜色/场景等级（图层据此创建唯一 InstancedMesh） */
  readonly nodeInstances: NodeInstanceData
  /** 物理路径去重明细（供诊断与后续图层复用） */
  readonly physical: PhysicalPathIndex
  /** 展示级道路网络（链与交叉节点；诊断与测试用） */
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
 * 半路宽没入补面。路缘候选轮廓经过道路联合覆盖裁剪：路口只留下外缘弧，
 * 断头端以半圆弧包边，形成连续且不在交叉区域内部重复的实体道路边界。
 */
export function buildMapGeometry(
  mapModel: MapModel,
  worldTransform: WorldTransform,
): MapGeometry {
  const physical = dedupePhysicalPaths(mapModel)
  const network = buildRoadNetwork(mapModel, physical)
  const nodeInstances = buildNodeInstances(mapModel, worldTransform)

  const surface = new StripAccumulator()
  const edgeCores = new StripAccumulator()
  const edgeHalos = new StripAccumulator()
  const centerLines = new StripAccumulator()
  const directionArrows = new StripAccumulator()

  buildRoadSurfaceAndEdges(network, worldTransform, surface, edgeCores, edgeHalos)
  buildPathMarkings(
    mapModel,
    physical,
    worldTransform,
    centerLines,
    directionArrows,
  )

  const pathsSurface = surface.toGeometry()
  const pathEdgeCores = edgeCores.toGeometry()
  const pathEdgeHalos = edgeHalos.toGeometry()
  const pathCenterLines = centerLines.toGeometry()
  const pathDirectionArrows = directionArrows.toGeometry()

  let disposed = false
  return {
    pathsSurface,
    pathEdgeCores,
    pathEdgeHalos,
    pathCenterLines,
    pathDirectionArrows,
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
      pathEdgeCores.dispose()
      pathEdgeHalos.dispose()
      pathCenterLines.dispose()
      pathDirectionArrows.dispose()
    },
  }
}

/** 世界坐标地面点（只含 x/z；高度由各构建器统一烘焙） */
interface WorldXZ {
  readonly x: number
  readonly z: number
}

/** 三角形合批几何累加器：位置 + 索引流，收尾产出 BufferGeometry */
class StripAccumulator {
  readonly positions: number[] = []
  readonly indices: number[] = []

  toGeometry(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(this.positions, 3),
    )
    geometry.setIndex(this.indices)
    geometry.computeBoundingSphere()
    return geometry
  }
}

/** 链级几何参数（路面、路肩与路缘共用一份世界坐标折线和路口判定） */
interface ChainBuildContext {
  readonly halfWidth: number
  readonly junctionPadRadius: number
}

/**
 * 路面与两侧边界：逐链构建路面条带（端部延伸没入路口补面/断头端圆帽）、
 * 路肩基座与浅色路缘（路口端截除至候选圆环、断头端接半圆弧），最后补路口
 * 圆盘，并按道路联合覆盖关系裁出真正可见的路口外缘弧。
 */
function buildRoadSurfaceAndEdges(
  network: RoadNetwork,
  worldTransform: WorldTransform,
  surface: StripAccumulator,
  edgeCores: StripAccumulator,
  edgeHalos: StripAccumulator,
): void {
  const ctx: ChainBuildContext = {
    halfWidth: PATH_SURFACE_WIDTH_M / 2,
    junctionPadRadius: (PATH_SURFACE_WIDTH_M / 2) * JUNCTION_PAD_SCALE,
  }
  const junctionNodeIds = new Set(network.junctions.map((j) => j.nodeId))
  /**
   * 所有道路中心线先进入空间索引。后续路缘候选段只要落入另一段路面或路口
   * 补面内部就会被裁掉，最终显示的是道路联合区域的可见外缘，而不是每条
   * 逻辑支路各自闭合的轮廓。
   */
  const worldChains = network.chains.map((chain) => ({
    chain,
    points: chain.points.map((p) => worldTransform.toWorldXZ(p.x, p.y)),
  }))
  const coverage = createRoadSurfaceCoverage(
    network,
    worldTransform,
    worldChains.map(({ points }) => points),
    ctx,
  )

  for (const { chain, points: worldPoints } of worldChains) {
    const junctionStart = junctionNodeIds.has(chain.startNodeId)
    const junctionEnd = junctionNodeIds.has(chain.endNodeId)

    // 路面：交叉端沿末段延伸半路宽，平切口没入路口补面
    const stripPoints = extendPolylineEnds(
      worldPoints,
      junctionStart ? ctx.halfWidth : 0,
      junctionEnd ? ctx.halfWidth : 0,
    )
    appendPolylineStrip(
      surface,
      stripPoints,
      ctx.halfWidth,
      PATH_SURFACE_Y,
      { capStart: !junctionStart, capEnd: !junctionEnd },
    )

    appendChainEdges(
      ctx,
      worldPoints,
      junctionStart,
      junctionEnd,
      coverage,
      edgeCores,
      edgeHalos,
    )
  }

  /**
   * 路口补面仍完整保留；圆形路缘先作为候选轮廓，与相邻道路重叠的弧段会被
   * coverage 裁掉，只留下 T 字口、十字口外侧的转角弧，避免节点处出现大量
   * 相互套叠的封闭圆圈。
   */
  for (const junction of network.junctions) {
    const world = worldTransform.toWorldXZ(junction.x, junction.y)
    appendDisc(surface, world.x, world.z, ctx.junctionPadRadius, PATH_SURFACE_Y, JUNCTION_PAD_SEGMENTS)
    const ring: WorldXZ[] = []
    for (let k = 0; k <= JUNCTION_PAD_SEGMENTS; k += 1) {
      const angle = (k / JUNCTION_PAD_SEGMENTS) * Math.PI * 2
      ring.push({
        x: world.x + Math.cos(angle) * ctx.junctionPadRadius,
        z: world.z + Math.sin(angle) * ctx.junctionPadRadius,
      })
    }
    appendVisibleEdgePolyline(ring, coverage, edgeCores, edgeHalos)
  }
}

/**
 * 一条链两侧的实体路缘：先按路口端截除（截距使边界终点恰好落在路口圆环
 * 上），再用与路面同源的斜接骨架展开 ±halfWidth 得到左右边界折线，分别
 * 按浅色压边/路肩半宽生成条带；断头端以半圆弧连接左右边界端点、包住圆帽。
 */
function appendChainEdges(
  ctx: ChainBuildContext,
  worldPoints: readonly WorldXZ[],
  junctionStart: boolean,
  junctionEnd: boolean,
  coverage: RoadSurfaceCoverage,
  edgeCores: StripAccumulator,
  edgeHalos: StripAccumulator,
): void {
  // 截距 = √(环半径² − 半路宽²)：边界端点与环上点的距离恰为环半径
  const trimAt = (isJunction: boolean): number => {
    if (!isJunction) {
      return 0
    }
    const r = ctx.junctionPadRadius
    return Math.sqrt(Math.max(r * r - ctx.halfWidth * ctx.halfWidth, 0))
  }
  const trimmed = trimPolylineByArc(worldPoints, trimAt(junctionStart), trimAt(junctionEnd))
  if (trimmed === null || trimmed.length < 2) {
    return
  }

  const { joints, jointOffsetX, jointOffsetZ } = stripJointFrames(trimmed, ctx.halfWidth)
  if (joints.length < 2) {
    return
  }
  const left: WorldXZ[] = []
  const right: WorldXZ[] = []
  for (let j = 0; j < joints.length; j += 1) {
    left.push({ x: joints[j].x + jointOffsetX[j], z: joints[j].z + jointOffsetZ[j] })
    right.push({ x: joints[j].x - jointOffsetX[j], z: joints[j].z - jointOffsetZ[j] })
  }

  for (const boundary of [left, right]) {
    appendVisibleEdgePolyline(boundary, coverage, edgeCores, edgeHalos)
  }

  // 断头端半圆弧：绕链端点从左边界转到右边界（经过向外方向），包住圆帽
  if (!junctionStart) {
    const outward = outwardDirection(trimmed, false)
    if (outward !== null) {
      const n = firstSegmentLeftNormal(trimmed)
      appendVisibleEndArc(joints[0], n, outward, ctx.halfWidth, coverage, edgeCores, edgeHalos)
    }
  }
  if (!junctionEnd) {
    const outward = outwardDirection(trimmed, true)
    if (outward !== null) {
      const n = lastSegmentLeftNormal(trimmed)
      const end = joints[joints.length - 1]
      appendVisibleEndArc(end, n, outward, ctx.halfWidth, coverage, edgeCores, edgeHalos)
    }
  }
}

const NO_CAPS: PolylineStripCaps = { capStart: false, capEnd: false }

/** 首段左法线（单位）：断头端起点弧的基准方向 */
function firstSegmentLeftNormal(points: readonly WorldXZ[]): WorldXZ {
  const a = points[0]
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i].x - a.x
    const dz = points[i].z - a.z
    const length = Math.hypot(dx, dz)
    if (length > 0) {
      return { x: -dz / length, z: dx / length }
    }
  }
  return { x: 0, z: 0 }
}

/** 末段左法线（单位）：断头端终点弧的基准方向 */
function lastSegmentLeftNormal(points: readonly WorldXZ[]): WorldXZ {
  const b = points[points.length - 1]
  for (let i = points.length - 2; i >= 0; i -= 1) {
    const dx = b.x - points[i].x
    const dz = b.z - points[i].z
    const length = Math.hypot(dx, dz)
    if (length > 0) {
      return { x: -dz / length, z: dx / length }
    }
  }
  return { x: 0, z: 0 }
}

/**
 * 断头端半圆同样先生成中心轮廓，再经过道路覆盖裁剪；当两个断头端在空间上
 * 靠得很近时，位于联合路面内部的半圆不会重复显现。
 */
function appendVisibleEndArc(
  center: WorldXZ,
  normal: WorldXZ,
  outward: WorldXZ,
  radius: number,
  coverage: RoadSurfaceCoverage,
  edgeCores: StripAccumulator,
  edgeHalos: StripAccumulator,
): void {
  const segments = PATH_END_ARC_SEGMENTS
  const arc: WorldXZ[] = []
  for (let k = 0; k <= segments; k += 1) {
    const theta = (k / segments) * Math.PI
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    const vx = normal.x * cos + outward.x * sin
    const vz = normal.z * cos + outward.z * sin
    arc.push({ x: center.x + vx * radius, z: center.z + vz * radius })
  }
  appendVisibleEdgePolyline(arc, coverage, edgeCores, edgeHalos)
}

/** 道路联合区域查询：用于从候选路缘中剔除落在内部的片段 */
interface RoadSurfaceCoverage {
  isCovered(x: number, z: number): boolean
}

interface CoverageSegment {
  readonly a: WorldXZ
  readonly b: WorldXZ
}

/**
 * 建立道路中心段与路口圆盘的均匀网格索引。候选边位于自身道路外缘，查询半径
 * 会向内收一个路缘宽度，因此不会误删自身；被另一条道路覆盖时才判定为内部。
 */
function createRoadSurfaceCoverage(
  network: RoadNetwork,
  worldTransform: WorldTransform,
  chains: readonly (readonly WorldXZ[])[],
  ctx: ChainBuildContext,
): RoadSurfaceCoverage {
  const inset = Math.max(PATH_EDGE_WIDTH_M * 0.9, 0.04)
  const roadRadius = Math.max(ctx.halfWidth - inset, 0)
  const junctionRadius = Math.max(ctx.junctionPadRadius - inset, 0)
  const cellSize = Math.max(ctx.junctionPadRadius, 0.25)
  const segmentBuckets = new Map<string, CoverageSegment[]>()
  const junctionBuckets = new Map<string, WorldXZ[]>()
  const cellKey = (x: number, z: number): string =>
    `${Math.floor(x / cellSize)},${Math.floor(z / cellSize)}`
  const addSegment = (segment: CoverageSegment): void => {
    const minX = Math.floor((Math.min(segment.a.x, segment.b.x) - roadRadius) / cellSize)
    const maxX = Math.floor((Math.max(segment.a.x, segment.b.x) + roadRadius) / cellSize)
    const minZ = Math.floor((Math.min(segment.a.z, segment.b.z) - roadRadius) / cellSize)
    const maxZ = Math.floor((Math.max(segment.a.z, segment.b.z) + roadRadius) / cellSize)
    for (let gx = minX; gx <= maxX; gx += 1) {
      for (let gz = minZ; gz <= maxZ; gz += 1) {
        const key = `${gx},${gz}`
        const bucket = segmentBuckets.get(key)
        if (bucket === undefined) {
          segmentBuckets.set(key, [segment])
        } else {
          bucket.push(segment)
        }
      }
    }
  }
  for (const points of chains) {
    for (let i = 1; i < points.length; i += 1) {
      addSegment({ a: points[i - 1], b: points[i] })
    }
  }
  for (const junction of network.junctions) {
    const point = worldTransform.toWorldXZ(junction.x, junction.y)
    const minX = Math.floor((point.x - junctionRadius) / cellSize)
    const maxX = Math.floor((point.x + junctionRadius) / cellSize)
    const minZ = Math.floor((point.z - junctionRadius) / cellSize)
    const maxZ = Math.floor((point.z + junctionRadius) / cellSize)
    for (let gx = minX; gx <= maxX; gx += 1) {
      for (let gz = minZ; gz <= maxZ; gz += 1) {
        const key = `${gx},${gz}`
        const bucket = junctionBuckets.get(key)
        if (bucket === undefined) {
          junctionBuckets.set(key, [point])
        } else {
          bucket.push(point)
        }
      }
    }
  }
  const roadRadiusSq = roadRadius * roadRadius
  const junctionRadiusSq = junctionRadius * junctionRadius
  return {
    isCovered(x: number, z: number): boolean {
      const key = cellKey(x, z)
      for (const segment of segmentBuckets.get(key) ?? []) {
        if (pointSegmentDistanceSq(x, z, segment.a, segment.b) < roadRadiusSq) {
          return true
        }
      }
      for (const junction of junctionBuckets.get(key) ?? []) {
        const dx = x - junction.x
        const dz = z - junction.z
        if (dx * dx + dz * dz < junctionRadiusSq) {
          return true
        }
      }
      return false
    },
  }
}

/**
 * 点到线段的平方距离；使用平方口径避免路缘裁剪的高频查询反复开平方。
 */
function pointSegmentDistanceSq(
  x: number,
  z: number,
  a: WorldXZ,
  b: WorldXZ,
): number {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const lengthSq = dx * dx + dz * dz
  if (lengthSq <= 1e-12) {
    return (x - a.x) ** 2 + (z - a.z) ** 2
  }
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq))
  const px = a.x + dx * t
  const pz = a.z + dz * t
  return (x - px) ** 2 + (z - pz) ** 2
}

/**
 * 把候选路缘按约 0.16m 的步长切片，只合批未落入道路内部的连续片段。浅色
 * 压边与路肩复用同一批可见片段，保证两层轮廓完全贴合且没有内部交叉线。
 */
function appendVisibleEdgePolyline(
  points: readonly WorldXZ[],
  coverage: RoadSurfaceCoverage,
  edgeCores: StripAccumulator,
  edgeHalos: StripAccumulator,
): void {
  const sampleStepM = 0.16
  let run: WorldXZ[] = []
  const flush = (): void => {
    if (run.length >= 2) {
      appendPolylineStrip(edgeCores, run, PATH_EDGE_WIDTH_M / 2, PATH_EDGE_Y, NO_CAPS)
      appendPolylineStrip(edgeHalos, run, PATH_EDGE_HALO_WIDTH_M / 2, PATH_EDGE_HALO_Y, NO_CAPS)
    }
    run = []
  }
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]
    const b = points[i]
    const length = Math.hypot(b.x - a.x, b.z - a.z)
    const slices = Math.max(1, Math.ceil(length / sampleStepM))
    for (let slice = 0; slice < slices; slice += 1) {
      const t0 = slice / slices
      const t1 = (slice + 1) / slices
      const p0 = { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 }
      const p1 = { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 }
      const covered = coverage.isCovered((p0.x + p1.x) / 2, (p0.z + p1.z) / 2)
      if (covered) {
        flush()
      } else {
        if (run.length === 0) {
          run.push(p0)
        }
        run.push(p1)
      }
    }
  }
  flush()
}

/** 归一化物理路径上的逻辑行进方向：1 为 points 首端到末端，-1 为反向 */
type PhysicalPathDirection = 1 | -1

interface PolylineDirectionSample {
  readonly point: WorldXZ
  /** 按物理路径归一化顺序计算的单位切线 */
  readonly tangent: WorldXZ
}

/**
 * 构建真实道路标线：中心实线按物理路径去重绘制，保证两个节点之间只有一条
 * 连续黄色连接；箭头则恢复同一物理路径承载的全部不同逻辑方向，使双向边在
 * 各自起点量起的 30% 弧长处得到两个相反标记。
 */
function buildPathMarkings(
  mapModel: MapModel,
  physical: PhysicalPathIndex,
  worldTransform: WorldTransform,
  centerLines: StripAccumulator,
  directionArrows: StripAccumulator,
): void {
  for (const path of physical.physicalPaths) {
    const worldPoints = path.points.map((point) =>
      worldTransform.toWorldXZ(point.x, point.y),
    )

    /**
     * 中心线端点不做圆帽外扩，严格停在两个节点中心；节点图层位于其上方，
     * 会像实体道路中的站点覆盖一样自然遮住标线末端。
     */
    appendPolylineStrip(
      centerLines,
      worldPoints,
      PATH_CENTER_LINE_WIDTH_M / 2,
      PATH_CENTER_LINE_Y,
      NO_CAPS,
    )

    for (const direction of collectPhysicalPathDirections(mapModel, path)) {
      const ratio = direction === 1
        ? PATH_DIRECTION_ARROW_POSITION_RATIO
        : 1 - PATH_DIRECTION_ARROW_POSITION_RATIO
      const sample = samplePolylineDirection(worldPoints, ratio)
      if (sample === null) {
        continue
      }
      emitDirectionArrow(
        directionArrows,
        sample.point,
        {
          x: sample.tangent.x * direction,
          z: sample.tangent.z * direction,
        },
      )
    }
  }
}

/**
 * 从物理路径覆盖的逻辑边恢复方向集合。几何归一化可能把代表边反转，因此
 * 不能依赖 isBackEdge；改用逻辑边起点与物理路径首点的坐标关系判定。重复的
 * 同向边只保留一个方向标记，避免箭头在完全相同的位置叠加。
 */
function collectPhysicalPathDirections(
  mapModel: MapModel,
  path: PhysicalPath,
): readonly PhysicalPathDirection[] {
  const CoordEpsilon = 1e-6
  const first = path.points[0]
  const directions = new Set<PhysicalPathDirection>()
  for (const edgeId of path.logicalEdgeIds) {
    const edge = mapModel.edges.get(edgeId)
    if (edge === undefined) {
      continue
    }
    const startsAtFirst =
      Math.abs(edge.sx - first.x) < CoordEpsilon &&
      Math.abs(edge.sy - first.y) < CoordEpsilon
    directions.add(startsAtFirst ? 1 : -1)
  }
  return [...directions]
}

/**
 * 按真实折线弧长采样位置与切线。贝塞尔路径已经按统一的 24 段离散，因此
 * 这里的 30% 是可见道路长度的 30%，不会因控制点分布不均而偏向曲线某一端。
 */
function samplePolylineDirection(
  points: readonly WorldXZ[],
  ratio: number,
): PolylineDirectionSample | null {
  if (points.length < 2) {
    return null
  }
  const cumulative: number[] = [0]
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(
      cumulative[index - 1] +
        Math.hypot(
          points[index].x - points[index - 1].x,
          points[index].z - points[index - 1].z,
        ),
    )
  }
  const total = cumulative[cumulative.length - 1]
  if (total <= 1e-6) {
    return null
  }
  const targetArc = total * Math.min(Math.max(ratio, 0), 1)
  for (let index = 0; index < points.length - 1; index += 1) {
    const segmentLength = cumulative[index + 1] - cumulative[index]
    if (segmentLength <= 1e-6 || targetArc > cumulative[index + 1]) {
      continue
    }
    const t = (targetArc - cumulative[index]) / segmentLength
    return {
      point: {
        x: points[index].x + (points[index + 1].x - points[index].x) * t,
        z: points[index].z + (points[index + 1].z - points[index].z) * t,
      },
      tangent: {
        x: (points[index + 1].x - points[index].x) / segmentLength,
        z: (points[index + 1].z - points[index].z) / segmentLength,
      },
    }
  }
  return null
}

/**
 * 绘制一枚实体道路风格的扁平箭头。局部坐标以 +y 为前进方向，箭杆保持
 * 纤细，箭头横向展开后压在黄色中心线上，在密集短路段中仍能辨认方向。
 * 轮廓在箭杆与箭头交界处是凹多边形，必须分别三角化矩形箭杆和三角箭头；
 * 禁止使用三角扇，否则扇面会跨过凹角并把单向箭头错误填充成对称菱形。
 */
function emitDirectionArrow(
  sink: StripAccumulator,
  center: WorldXZ,
  forward: WorldXZ,
): void {
  const halfLength = PATH_DIRECTION_ARROW_LENGTH_M / 2
  const shaft = PATH_DIRECTION_ARROW_SHAFT_HALF_WIDTH_M
  const head = PATH_DIRECTION_ARROW_HEAD_HALF_WIDTH_M
  const headStart = halfLength - PATH_DIRECTION_ARROW_HEAD_LENGTH_M
  const outline: readonly (readonly [number, number])[] = [
    [-shaft, -halfLength],
    [shaft, -halfLength],
    [shaft, headStart],
    [head, headStart],
    [0, halfLength],
    [-head, headStart],
    [-shaft, headStart],
  ]
  const lateralX = forward.z
  const lateralZ = -forward.x
  const base = sink.positions.length / 3
  for (const [lateral, longitudinal] of outline) {
    sink.positions.push(
      center.x + lateralX * lateral + forward.x * longitudinal,
      PATH_DIRECTION_ARROW_Y,
      center.z + lateralZ * lateral + forward.z * longitudinal,
    )
  }
  /**
   * 顶点 0/1/2/6 组成箭杆矩形，3/4/5 组成朝向唯一的箭头三角形；两部分
   * 在 headStart 横截面相接，既没有空隙，也不会越过轮廓凹角产生多余填充。
   */
  sink.indices.push(
    base, base + 1, base + 2,
    base, base + 2, base + 6,
    base + 3, base + 4, base + 5,
  )
}

/**
 * 沿首末段方向把折线两端各延伸指定长度（米）：返回新数组，原数组不变。
 * 延伸点与相邻段共线，条带在该端只是变长；首末段退化（零长度）时不延伸。
 */
function extendPolylineEnds(
  worldPoints: readonly WorldXZ[],
  extendStartM: number,
  extendEndM: number,
): readonly WorldXZ[] {
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
 * 折线端部的向外延伸方向：fromEnd=false 取首个与端点不重合的点指向链内
 * 的方向；fromEnd=true 取末端的对应方向。全部点与端点重合时返回 null。
 */
function outwardDirection(
  points: readonly WorldXZ[],
  fromEnd: boolean,
): WorldXZ | null {
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

/**
 * 按弧长截除折线两端：返回 [from, total − end] 弧长窗口内的顶点序列
 * （窗口端点为插值点）；窗口退化（长度 < 1e-4）时返回 null。
 */
function trimPolylineByArc(
  points: readonly WorldXZ[],
  trimStartM: number,
  trimEndM: number,
): WorldXZ[] | null {
  const cumulative: number[] = [0]
  for (let i = 1; i < points.length; i += 1) {
    cumulative.push(
      cumulative[i - 1] +
        Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z),
    )
  }
  const total = cumulative[cumulative.length - 1]
  const from = Math.min(Math.max(trimStartM, 0), total)
  const to = Math.min(Math.max(total - trimEndM, from), total)
  if (to - from < 1e-4) {
    return null
  }
  const result: WorldXZ[] = [pointAtArc(points, cumulative, from)]
  for (let i = 1; i < points.length - 1; i += 1) {
    if (cumulative[i] > from && cumulative[i] < to) {
      result.push(points[i])
    }
  }
  result.push(pointAtArc(points, cumulative, to))
  return result
}

/** 弧长处的插值点（cumulative 与 points 同长；超出总长时取末点） */
function pointAtArc(
  points: readonly WorldXZ[],
  cumulative: readonly number[],
  arc: number,
): WorldXZ {
  for (let i = 0; i < cumulative.length - 1; i += 1) {
    const segLength = cumulative[i + 1] - cumulative[i]
    if (arc <= cumulative[i + 1] && segLength > 0) {
      const t = (arc - cumulative[i]) / segLength
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        z: points[i].z + (points[i + 1].z - points[i].z) * t,
      }
    }
  }
  return points[points.length - 1]
}

/** 追加一个贴地圆盘（三角扇）：路口补面使用 */
function appendDisc(
  sink: StripAccumulator,
  centerX: number,
  centerZ: number,
  radius: number,
  y: number,
  segments: number,
): void {
  const center = sink.positions.length / 3
  sink.positions.push(centerX, y, centerZ)
  for (let k = 0; k < segments; k += 1) {
    const angle = (k / segments) * Math.PI * 2
    sink.positions.push(
      centerX + Math.cos(angle) * radius,
      y,
      centerZ + Math.sin(angle) * radius,
    )
  }
  for (let k = 0; k < segments; k += 1) {
    sink.indices.push(center, center + 1 + k, center + 1 + ((k + 1) % segments))
  }
}

/** 条带端帽选项：起点/终点是否补半径 = 半路宽的圆片（盖住断头端） */
interface PolylineStripCaps {
  readonly capStart: boolean
  readonly capEnd: boolean
}

/** 折线的斜接骨架：关节点与每个关节的展开偏移（斜接长度补偿后） */
interface StripJointFrames {
  readonly joints: readonly WorldXZ[]
  readonly jointOffsetX: readonly number[]
  readonly jointOffsetZ: readonly number[]
}

/**
 * 计算折线条带的斜接骨架：关节展开方向取相邻段法线平均，并按 1/cos(半角)
 * 补偿斜接长度（钳制 3×halfWidth 防止近回折处的退化放大）。路面条带与
 * 路肩及路缘条带共用同一骨架，保证两层实体边界精确贴合路面边缘。
 */
function stripJointFrames(
  worldPoints: readonly WorldXZ[],
  halfWidth: number,
): StripJointFrames {
  // 有效段方向（跳过零长度段）：dir = normalize(b - a)，左法线 = (-dz, dx)
  const dirX: number[] = []
  const dirZ: number[] = []
  const joints: WorldXZ[] = []
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
 * 把世界坐标折线按 halfWidth 展开为共享顶点条带并追加进累加器。
 * 关节顶点取相邻段法线的平均方向，并按 1/cos(半角) 补偿斜接长度（钳制到
 * 3×halfWidth 防止近回折处的退化放大）——同一路径的弯道无逐段接缝毛边。
 * capStart/capEnd 为真时在首末端点补圆片端帽。零长度段被跳过；
 * 全部顶点烘焙同一高度 y。
 */
function appendPolylineStrip(
  sink: StripAccumulator,
  worldPoints: readonly WorldXZ[],
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
  const base = sink.positions.length / 3
  for (let j = 0; j < joints.length; j += 1) {
    sink.positions.push(
      joints[j].x + jointOffsetX[j], y, joints[j].z + jointOffsetZ[j],
      joints[j].x - jointOffsetX[j], y, joints[j].z - jointOffsetZ[j],
    )
  }
  for (let s = 0; s < segmentCount; s += 1) {
    const a = base + s * 2
    const b = base + s * 2 + 2
    sink.indices.push(a, a + 1, b + 1, a, b + 1, b)
  }

  const appendCap = (centerIndex: number): void => {
    // 端帽圆盘中心 = 路径端点本身（关节边缘顶点偏在 ±halfWidth 一侧，不可复用）
    const capCenter = sink.positions.length / 3
    sink.positions.push(joints[centerIndex].x, y, joints[centerIndex].z)
    const ringStart = capCenter + 1
    const SEGMENTS = 16
    for (let k = 0; k < SEGMENTS; k += 1) {
      const angle = (k / SEGMENTS) * Math.PI * 2
      sink.positions.push(
        joints[centerIndex].x + Math.cos(angle) * halfWidth,
        y,
        joints[centerIndex].z + Math.sin(angle) * halfWidth,
      )
    }
    for (let k = 0; k < SEGMENTS; k += 1) {
      sink.indices.push(capCenter, ringStart + k, ringStart + (k + 1) % SEGMENTS)
    }
  }
  if (caps.capStart) {
    appendCap(0)
  }
  if (caps.capEnd) {
    appendCap(joints.length - 1)
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
