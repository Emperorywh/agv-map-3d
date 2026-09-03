/**
 * 物理路径去重、路径几何与节点实例静态数据（SPEC §2.2、§5.1；TASK-004；
 * 路网原型复刻：暗色路面 + 发光蓝边 + 黄色方向箭头）。
 *
 * 职责：
 * 1. dedupePhysicalPaths：把有向逻辑边按「正/反向几何归一后相同」的签名去重，
 *    生成物理路径集合（当前地图 9,265 条逻辑边 → 5,068 条物理路径），并保留
 *    逻辑边 → 物理路径的完整映射（方向、限速与拓扑语义仍留在逻辑边上）；
 * 2. buildMapGeometry：在世界坐标烘焙四份合批静态几何——
 *    a. pathsSurface：链式路面条带 + 断头端圆帽 + 路口补面圆盘；
 *    b. pathEdgeCores：路缘蓝边细芯条带（路口端以同补面半径的圆环收口、
 *       断头端以半圆弧包边），形成原型图的「发光蓝边」轮廓；
 *    c. pathEdgeHalos：蓝边外侧的加法混合晕圈条带（同骨架、更宽、更低），
 *       模拟灯管贴地微光；
 *    d. pathArrows：黄色方向箭头多边形，沿每条物理路径按逻辑边行进方向
 *       （优先非回边）等弧长布置，方向展示与数据一致；
 *    另生成全部节点的实例矩阵、颜色与「最低可见场景等级」（P0-5.4）。
 * 边界：输入必须来自 createMapModel 的只读 MapModel（已校验、有限坐标）；
 *       本模块不进 React、不做拓扑寻路；图层高度等外观常量来自 mapAppearance。
 * 关键不变量：
 * 1. 归一化签名只由几何坐标决定：BEZIER 反向 = 端点与控制点整体逆序；同一
 *    节点对之间几何不同的平行路径不会被合并（不得按节点对去重，SPEC §2.2）；
 * 2. BEZIER 固定采样 BEZIER_SAMPLE_SEGMENTS=24 段（全应用唯一离散化口径，
 *    与逻辑边物理长度共用 sampleCubicBezier）；
 * 3. 箭头方向是业务语义：物理路径采样点可能被归一化反向（与代表逻辑边方向
 *    相反），必须先用首点与所选逻辑边起点坐标比对定向，再烘焙顶点；
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
  PATH_ARROW_END_MARGIN_M,
  PATH_ARROW_HEAD_HALF_WIDTH_M,
  PATH_ARROW_HEAD_LENGTH_M,
  PATH_ARROW_LENGTH_M,
  PATH_ARROW_SHAFT_HALF_WIDTH_M,
  PATH_ARROW_SPACING_M,
  PATH_ARROW_Y,
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
  /** 路缘蓝边细芯条带（含路口圆环与断头端弧，三角形合批，静态） */
  readonly pathEdgeCores: THREE.BufferGeometry
  /** 蓝边晕圈条带（加法混合，三角形合批，静态） */
  readonly pathEdgeHalos: THREE.BufferGeometry
  /** 黄色方向箭头多边形（三角形合批，静态） */
  readonly pathArrows: THREE.BufferGeometry
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
 * 半路宽没入补面。蓝边与补面同轮廓：路口端以同半径圆环收口，断头端以
 * 半圆弧包边，蓝边是路网唯一的描边语言（替代旧的虚线中线）。
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
  const arrows = new StripAccumulator()

  buildRoadSurfaceAndEdges(network, worldTransform, surface, edgeCores, edgeHalos)
  buildPathArrows(mapModel, physical, network, worldTransform, arrows)

  const pathsSurface = surface.toGeometry()
  const pathEdgeCores = edgeCores.toGeometry()
  const pathEdgeHalos = edgeHalos.toGeometry()
  const pathArrows = arrows.toGeometry()

  let disposed = false
  return {
    pathsSurface,
    pathEdgeCores,
    pathEdgeHalos,
    pathArrows,
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
      pathArrows.dispose()
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

/** 链级几何参数（路面/蓝边/晕圈共用一份世界坐标折线与路口判定） */
interface ChainBuildContext {
  readonly halfWidth: number
  readonly junctionPadRadius: number
}

/**
 * 路面与蓝边：逐链构建路面条带（端部延伸没入路口补面/断头端圆帽）、两侧
 * 路缘蓝边细芯与晕圈条带（路口端截除至圆环、断头端接半圆弧），最后补路口
 * 圆盘与圆环蓝边。
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

  for (const chain of network.chains) {
    const worldPoints = chain.points.map((p) => worldTransform.toWorldXZ(p.x, p.y))
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

    appendChainEdges(ctx, worldPoints, junctionStart, junctionEnd, edgeCores, edgeHalos)
  }

  // 路口补面圆盘 + 同半径圆环蓝边：路口以一圈完整的环收口
  for (const junction of network.junctions) {
    const world = worldTransform.toWorldXZ(junction.x, junction.y)
    appendDisc(surface, world.x, world.z, ctx.junctionPadRadius, PATH_SURFACE_Y, JUNCTION_PAD_SEGMENTS)
    appendRing(edgeCores, world.x, world.z, ctx.junctionPadRadius, PATH_EDGE_WIDTH_M / 2, PATH_EDGE_Y, JUNCTION_PAD_SEGMENTS)
    appendRing(edgeHalos, world.x, world.z, ctx.junctionPadRadius, PATH_EDGE_HALO_WIDTH_M / 2, PATH_EDGE_HALO_Y, JUNCTION_PAD_SEGMENTS)
  }
}

/**
 * 一条链两侧的路缘蓝边：先按路口端截除（截距使边界终点恰好落在路口圆环
 * 上），再用与路面同源的斜接骨架展开 ±halfWidth 得到左右边界折线，分别
 * 按细芯/晕圈半宽生成条带；断头端以半圆弧连接左右边界端点、包住路面圆帽。
 */
function appendChainEdges(
  ctx: ChainBuildContext,
  worldPoints: readonly WorldXZ[],
  junctionStart: boolean,
  junctionEnd: boolean,
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
    appendPolylineStrip(edgeCores, boundary, PATH_EDGE_WIDTH_M / 2, PATH_EDGE_Y, NO_CAPS)
    appendPolylineStrip(edgeHalos, boundary, PATH_EDGE_HALO_WIDTH_M / 2, PATH_EDGE_HALO_Y, NO_CAPS)
  }

  // 断头端半圆弧：绕链端点从左边界转到右边界（经过向外方向），包住圆帽
  if (!junctionStart) {
    const outward = outwardDirection(trimmed, false)
    if (outward !== null) {
      const n = firstSegmentLeftNormal(trimmed)
      appendEndArc(edgeCores, joints[0], n, outward, ctx.halfWidth, PATH_EDGE_WIDTH_M / 2, PATH_EDGE_Y)
      appendEndArc(edgeHalos, joints[0], n, outward, ctx.halfWidth, PATH_EDGE_HALO_WIDTH_M / 2, PATH_EDGE_HALO_Y)
    }
  }
  if (!junctionEnd) {
    const outward = outwardDirection(trimmed, true)
    if (outward !== null) {
      const n = lastSegmentLeftNormal(trimmed)
      const end = joints[joints.length - 1]
      appendEndArc(edgeCores, end, n, outward, ctx.halfWidth, PATH_EDGE_WIDTH_M / 2, PATH_EDGE_Y)
      appendEndArc(edgeHalos, end, n, outward, ctx.halfWidth, PATH_EDGE_HALO_WIDTH_M / 2, PATH_EDGE_HALO_Y)
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
 * 半圆弧条带：圆心在链端点，方向 v(θ) = n·cosθ + u·sinθ（θ: 0→π），从
 * 「端点 + n·radius」（左边界端点）经向外方向转到「端点 − n·radius」（右
 * 边界端点）。条带内外两圈取 radius ∓ halfWidth，索引连续成带。
 */
function appendEndArc(
  sink: StripAccumulator,
  center: WorldXZ,
  normal: WorldXZ,
  outward: WorldXZ,
  radius: number,
  halfWidth: number,
  y: number,
): void {
  const segments = PATH_END_ARC_SEGMENTS
  const base = sink.positions.length / 3
  for (let ring = 0; ring < 2; ring += 1) {
    const r = ring === 0 ? radius - halfWidth : radius + halfWidth
    for (let k = 0; k <= segments; k += 1) {
      const theta = (k / segments) * Math.PI
      const cos = Math.cos(theta)
      const sin = Math.sin(theta)
      const vx = normal.x * cos + outward.x * sin
      const vz = normal.z * cos + outward.z * sin
      sink.positions.push(center.x + vx * r, y, center.z + vz * r)
    }
  }
  appendBandIndices(sink, base, segments)
}

/** 双圈环带（k: 0..segments 两圈顶点）的矩形条带索引 */
function appendBandIndices(sink: StripAccumulator, base: number, segments: number): void {
  const stride = segments + 1
  for (let k = 0; k < segments; k += 1) {
    const a = base + k
    const b = a + stride
    sink.indices.push(a, b, b + 1, a, b + 1, a + 1)
  }
}

/** 同心圆环条带（路口蓝边）：半径 ∓ halfWidth 两圈，整圆闭合 */
function appendRing(
  sink: StripAccumulator,
  centerX: number,
  centerZ: number,
  radius: number,
  halfWidth: number,
  y: number,
  segments: number,
): void {
  const base = sink.positions.length / 3
  for (let ring = 0; ring < 2; ring += 1) {
    const r = ring === 0 ? radius - halfWidth : radius + halfWidth
    for (let k = 0; k <= segments; k += 1) {
      const angle = (k / segments) * Math.PI * 2
      sink.positions.push(
        centerX + Math.cos(angle) * r,
        y,
        centerZ + Math.sin(angle) * r,
      )
    }
  }
  appendBandIndices(sink, base, segments)
}

/**
 * 黄色方向箭头：逐物理路径放置。方向源优先「非回边」（isBackEdge=false，
 * 双向对里的正向边 / 单向正边），全部为回边时回退代表边；物理路径采样点
 * 可能被归一化反向，用首点与所选逻辑边起点比对定向。箭头沿切线方向、按
 * 弧长等距布置，短路径整体缩小，端部留出路口环与断头端弧的退距；路口补
 * 面范围内不放箭头（路口只保留圆环蓝边，避免多路径箭头在路口叠成团）。
 */
function buildPathArrows(
  mapModel: MapModel,
  physical: PhysicalPathIndex,
  network: RoadNetwork,
  worldTransform: WorldTransform,
  arrows: StripAccumulator,
): void {
  const junctionPadRadius = (PATH_SURFACE_WIDTH_M / 2) * JUNCTION_PAD_SCALE
  const padLookup = createJunctionPadLookup(network, worldTransform, junctionPadRadius)
  for (const path of physical.physicalPaths) {
    const edge = resolveArrowSourceEdge(mapModel, path)
    if (edge === null) {
      continue
    }
    const first = path.points[0]
    const planeOrderMatchesEdge =
      Math.abs(first.x - edge.sx) < 1e-6 && Math.abs(first.y - edge.sy) < 1e-6
    const plane = planeOrderMatchesEdge ? path.points : [...path.points].reverse()
    const world = plane.map((p) => worldTransform.toWorldXZ(p.x, p.y))
    emitArrowsAlongPolyline(arrows, world, (x, z) => padLookup.isInside(x, z))
  }
}

/**
 * 路口补面范围的网格哈希：格子边长 = 补面半径，命中查询只查所在格与
 * 8 邻格（任意点至多落入 4 个半径圆的邻格并集），避免逐对比较全量路口。
 */
function createJunctionPadLookup(
  network: RoadNetwork,
  worldTransform: WorldTransform,
  radius: number,
): { isInside(x: number, z: number): boolean } {
  const cell = radius
  const buckets = new Map<string, WorldXZ[]>()
  for (const junction of network.junctions) {
    const world = worldTransform.toWorldXZ(junction.x, junction.y)
    const key = `${Math.floor(world.x / cell)},${Math.floor(world.z / cell)}`
    const bucket = buckets.get(key)
    if (bucket === undefined) {
      buckets.set(key, [world])
    } else {
      bucket.push(world)
    }
  }
  const radiusSq = radius * radius
  return {
    isInside(x: number, z: number): boolean {
      const cx = Math.floor(x / cell)
      const cz = Math.floor(z / cell)
      for (let gx = cx - 1; gx <= cx + 1; gx += 1) {
        for (let gz = cz - 1; gz <= cz + 1; gz += 1) {
          const bucket = buckets.get(`${gx},${gz}`)
          if (bucket === undefined) {
            continue
          }
          for (const j of bucket) {
            const dx = x - j.x
            const dz = z - j.z
            if (dx * dx + dz * dz <= radiusSq) {
              return true
            }
          }
        }
      }
      return false
    },
  }
}

/**
 * 箭头方向源逻辑边：优先任一非回边（数据规律：双向对恰好一正一反，单向
 * 路多为正边），否则回退首个可解析的逻辑边；全部缺失时返回 null（跳过）。
 */
function resolveArrowSourceEdge(
  mapModel: MapModel,
  path: PhysicalPath,
): MapEdge | null {
  let fallback: MapEdge | null = null
  for (const id of path.logicalEdgeIds) {
    const edge = mapModel.edges.get(id)
    if (edge === undefined) {
      continue
    }
    if (fallback === null) {
      fallback = edge
    }
    if (!edge.isBackEdge) {
      return edge
    }
  }
  return fallback
}

/** 把箭头按弧长布置到折线上：端部退距内不放，可用长度不足时整体缩小 */
function emitArrowsAlongPolyline(
  sink: StripAccumulator,
  points: readonly WorldXZ[],
  isExcluded: (x: number, z: number) => boolean,
): void {
  const cumulative: number[] = [0]
  for (let i = 1; i < points.length; i += 1) {
    cumulative.push(
      cumulative[i - 1] +
        Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z),
    )
  }
  const total = cumulative[cumulative.length - 1]
  const usable = total - 2 * PATH_ARROW_END_MARGIN_M
  const minUsable = 0.25
  if (usable < minUsable) {
    return
  }
  const scale = Math.min(1, usable / PATH_ARROW_LENGTH_M)
  const halfLength = (PATH_ARROW_LENGTH_M * scale) / 2
  const lo = PATH_ARROW_END_MARGIN_M + halfLength
  const hi = total - lo
  if (hi < lo) {
    return
  }
  // 单枚时居中，多枚时从区间中点起步按间距推进（两侧留白对称）
  const phase = Math.min(PATH_ARROW_SPACING_M / 2, (hi - lo) / 2)
  for (let p = lo + phase; p <= hi + 1e-6; p += PATH_ARROW_SPACING_M) {
    const seg = segmentAtArc(cumulative, p)
    if (seg === null) {
      return
    }
    const a = points[seg]
    const b = points[seg + 1]
    const segLength = cumulative[seg + 1] - cumulative[seg]
    if (segLength <= 0) {
      continue
    }
    const t = (p - cumulative[seg]) / segLength
    const cx = a.x + (b.x - a.x) * t
    const cz = a.z + (b.z - a.z) * t
    if (isExcluded(cx, cz)) {
      continue
    }
    emitArrow(
      sink,
      cx,
      cz,
      (b.x - a.x) / segLength,
      (b.z - a.z) / segLength,
      scale,
    )
  }
}

/** 弧长所在段索引（points 与 cumulative 同长；越界返回 null） */
function segmentAtArc(cumulative: readonly number[], arc: number): number | null {
  for (let i = 0; i < cumulative.length - 1; i += 1) {
    if (arc <= cumulative[i + 1] || i === cumulative.length - 2) {
      return i
    }
  }
  return null
}

/**
 * 一枚黄色方向箭头：局部轮廓（指向 +y，杆 + 三角头，7 个凸多边形顶点）
 * 经「中心平移 + 切线朝向 + 整体缩放」烘焙进世界坐标，扇形三角化。
 */
function emitArrow(
  sink: StripAccumulator,
  centerX: number,
  centerZ: number,
  forwardX: number,
  forwardZ: number,
  scale: number,
): void {
  const length = PATH_ARROW_LENGTH_M
  const shaft = PATH_ARROW_SHAFT_HALF_WIDTH_M
  const head = PATH_ARROW_HEAD_HALF_WIDTH_M
  const headLen = PATH_ARROW_HEAD_LENGTH_M
  const half = length / 2
  const outline: readonly (readonly [number, number])[] = [
    [-shaft, -half],
    [shaft, -half],
    [shaft, half - headLen],
    [head, half - headLen],
    [0, half],
    [-head, half - headLen],
    [-shaft, half - headLen],
  ]
  // 局部 (横向 x, 前向 y) → 世界：横向取前向的垂直向量
  const lateralX = forwardZ
  const lateralZ = -forwardX
  const base = sink.positions.length / 3
  for (const [lx, ly] of outline) {
    sink.positions.push(
      centerX + lateralX * lx * scale + forwardX * ly * scale,
      PATH_ARROW_Y,
      centerZ + lateralZ * lx * scale + forwardZ * ly * scale,
    )
  }
  for (let k = 1; k < outline.length - 1; k += 1) {
    sink.indices.push(base, base + k, base + k + 1)
  }
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
 * 路缘蓝边条带共用同一骨架，保证蓝边精确贴合路面边缘。
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
