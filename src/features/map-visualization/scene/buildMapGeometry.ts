/**
 * 物理路径去重、路径几何与节点实例静态数据（SPEC §2.2、§5.1；TASK-004；
 * 道路标线表达：黄色中心线 + 方向箭头，不绘制路面与道路边界）。
 *
 * 职责：
 * 1. dedupePhysicalPaths：把有向逻辑边按「正/反向几何归一后相同」的签名去重，
 *    生成物理路径集合（当前地图 9,265 条逻辑边 → 5,068 条物理路径），并保留
 *    逻辑边 → 物理路径的完整映射（方向、限速与拓扑语义仍留在逻辑边上）；
 * 2. buildMapGeometry：在世界坐标烘焙两份合批静态几何——
 *    a. pathCenterLines：沿每条物理路径连接两个节点的黄色连续中心实线；
 *    b. pathDirectionArrows：按逻辑方向与局部空间避让绘制的自适应箭头，
 *       逐顶点烘焙颜色——默认暖白，isBackEdge=true 的方向为红色；
 *    另生成全部节点的实例矩阵、颜色与「最低可见场景等级」（P0-5.4）。
 * 边界：输入必须来自 createMapModel 的只读 MapModel（已校验、有限坐标）；
 *       本模块不进 React、不做拓扑寻路；图层高度等外观常量来自 mapAppearance。
 * 关键不变量：
 * 1. 归一化签名只由几何坐标决定：BEZIER 反向 = 端点与控制点整体逆序；同一
 *    节点对之间几何不同的平行路径不会被合并（不得按节点对去重，SPEC §2.2）；
 * 2. BEZIER 固定采样 BEZIER_SAMPLE_SEGMENTS=24 段（全应用唯一离散化口径，
 *    与逻辑边物理长度共用 sampleCubicBezier）；
 * 3. 物理路径只绘制一条中心实线，但方向按逻辑边去重保留；同一几何上的
 *    正反向逻辑边优先在 30% 与 70% 处成对布局，空间不足时缩小或整组省略；
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
import { PathMarkingLayout, type PathArrowDirectionSpec, type PathArrowPlacement } from './pathMarkingLayout'
import {
  NODE_COLORS,
  NODE_OUTER_RADIUS_M,
  NODE_Y,
  PATH_CENTER_LINE_WIDTH_M,
  PATH_CENTER_LINE_Y,
  PATH_DIRECTION_ARROW_BACK_COLOR,
  PATH_DIRECTION_ARROW_COLOR,
  PATH_DIRECTION_ARROW_HEAD_HALF_WIDTH_M,
  PATH_DIRECTION_ARROW_HEAD_LENGTH_M,
  PATH_DIRECTION_ARROW_LENGTH_M,
  PATH_DIRECTION_ARROW_SHAFT_HALF_WIDTH_M,
  PATH_DIRECTION_ARROW_Y,
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
  /** 列主序 4×4 矩阵数组，长度 16×count；平移与 x/z 等比缩放 */
  readonly matrices: Float32Array
  /** RGB 颜色数组，长度 3×count（instanceColor 直读） */
  readonly colors: Float32Array
  /** 最低可见场景等级（P0-5.4）：实例属性 aMinLevel 直读，场景等级 ≥ 值可见 */
  readonly minLevels: Float32Array
}

/** 已构建的静态地图几何（GPU 资源由本对象拥有并释放） */
export interface MapGeometry {
  /** 节点间黄色连续中心实线（三角形合批，静态） */
  readonly pathCenterLines: THREE.BufferGeometry
  /** 避让节点与邻近标记的暖白方向箭头，附带屏幕尺寸淡出属性（静态合批） */
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
 * 道路只以标线表达：黄色中心实线沿物理路径连接节点，方向箭头表达逻辑边
 * 方向；不绘制路面、路缘与路口补面。道路网络仍按展示级拓扑构建，供诊断
 * 与测试使用。
 */
export function buildMapGeometry(
  mapModel: MapModel,
  worldTransform: WorldTransform,
): MapGeometry {
  const physical = dedupePhysicalPaths(mapModel)
  const network = buildRoadNetwork(mapModel, physical)
  /**
   * 节点实例与箭头布局共用同一份显示半径，防止标记避让口径与可见轮廓脱节。
   * 空间索引仅在此次构建内存活，结果作为静态矩阵和顶点属性上载。
   */
  const markingLayout = new PathMarkingLayout(mapModel, worldTransform)
  const nodeInstances = buildNodeInstances(mapModel, worldTransform, markingLayout)

  const centerLines = new StripAccumulator()
  const directionArrows = new ArrowAccumulator()

  buildPathMarkings(
    mapModel,
    physical,
    worldTransform,
    centerLines,
    directionArrows,
    markingLayout,
  )

  const pathCenterLines = centerLines.toGeometry()
  const pathDirectionArrows = directionArrows.toGeometry()

  let disposed = false
  return {
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

/**
 * 箭头附带中心与半长方向向量，供 GPU 按实际屏幕投影长度淡出。
 * 每枚箭头的顶点重复相同属性，缩放相机时无需重新生成几何。
 * 顶点色承载箭头颜色（默认暖白 / 反向边红色），同一材质保持单批次绘制。
 */
class ArrowAccumulator extends StripAccumulator {
  readonly centers: number[] = []
  readonly spans: number[] = []
  readonly partnerCenters: number[] = []
  readonly partnerSpans: number[] = []
  readonly colors: number[] = []

  override toGeometry(): THREE.BufferGeometry {
    const geometry = super.toGeometry()
    geometry.setAttribute('aArrowCenter', new THREE.Float32BufferAttribute(this.centers, 3))
    geometry.setAttribute('aArrowSpan', new THREE.Float32BufferAttribute(this.spans, 3))
    geometry.setAttribute('aArrowPartnerCenter', new THREE.Float32BufferAttribute(this.partnerCenters, 3))
    geometry.setAttribute('aArrowPartnerSpan', new THREE.Float32BufferAttribute(this.partnerSpans, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3))
    return geometry
  }
}

const NO_CAPS: PolylineStripCaps = { capStart: false, capEnd: false }

/** 归一化物理路径上的逻辑行进方向：1 为 points 首端到末端，-1 为反向 */
type PhysicalPathDirection = 1 | -1

/**
 * 构建真实道路标线：中心实线按物理路径去重绘制，保证两个节点之间只有一条
 * 连续黄色连接；箭头优先处理空间受限的短路径，并按局部空间调整尺寸与位置。
 * 两个逻辑方向成组保留或省略，不能把双向道路显示成单向。
 */
function buildPathMarkings(
  mapModel: MapModel,
  physical: PhysicalPathIndex,
  worldTransform: WorldTransform,
  centerLines: StripAccumulator,
  directionArrows: ArrowAccumulator,
  markingLayout: PathMarkingLayout,
): void {
  const paths = physical.physicalPaths.map((path) => {
    const points = path.points.map((point) =>
      worldTransform.toWorldXZ(point.x, point.y),
    )
    let length = 0
    for (let i = 1; i < points.length; i += 1) {
      length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z)
    }
    return { path, points, length }
  }).sort((a, b) => a.length - b.length || a.path.index - b.path.index)

  for (const { path, points: worldPoints } of paths) {

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

    const placements = markingLayout.placeArrows(
      worldPoints,
      collectPhysicalPathDirections(mapModel, path),
    )
    for (let i = 0; i < placements.length; i += 1) {
      const placement = placements[i]
      emitDirectionArrow(
        directionArrows,
        placement.center,
        placement.forward,
        placement.scale,
        placements[1 - i] ?? placement,
        placement.backEdge,
      )
    }
  }
}

/**
 * 从物理路径覆盖的逻辑边恢复方向集合及其颜色语义。几何归一化可能把代表边
 * 反转，因此朝向不能依赖 isBackEdge，改用逻辑边起点与物理路径首点的坐标
 * 关系判定；isBackEdge 只用于把该方向的箭头染成红色（任一覆盖边为反向边
 * 即视为反向方向）。重复的同向边只保留一个方向标记，避免箭头在完全相同
 * 的位置叠加。
 */
function collectPhysicalPathDirections(
  mapModel: MapModel,
  path: PhysicalPath,
): readonly PathArrowDirectionSpec[] {
  const CoordEpsilon = 1e-6
  const first = path.points[0]
  const backEdgeByDirection = new Map<PhysicalPathDirection, boolean>()
  for (const edgeId of path.logicalEdgeIds) {
    const edge = mapModel.edges.get(edgeId)
    if (edge === undefined) {
      continue
    }
    const startsAtFirst =
      Math.abs(edge.sx - first.x) < CoordEpsilon &&
      Math.abs(edge.sy - first.y) < CoordEpsilon
    const direction: PhysicalPathDirection = startsAtFirst ? 1 : -1
    backEdgeByDirection.set(
      direction,
      (backEdgeByDirection.get(direction) ?? false) || edge.isBackEdge,
    )
  }
  return [...backEdgeByDirection].map(([direction, backEdge]) => ({ direction, backEdge }))
}

/**
 * 绘制一枚实体道路风格的扁平箭头。局部坐标以 +y 为前进方向，箭杆保持
 * 纤细，箭头横向展开后压在黄色中心线上，在密集短路段中仍能辨认方向。
 * 轮廓在箭杆与箭头交界处是凹多边形，必须分别三角化矩形箭杆和三角箭头；
 * 禁止使用三角扇，否则扇面会跨过凹角并把单向箭头错误填充成对称菱形。
 */
const DEFAULT_ARROW_RGB = new THREE.Color(PATH_DIRECTION_ARROW_COLOR)
const BACK_ARROW_RGB = new THREE.Color(PATH_DIRECTION_ARROW_BACK_COLOR)

function emitDirectionArrow(
  sink: ArrowAccumulator,
  center: WorldXZ,
  forward: WorldXZ,
  scale: number,
  partner: PathArrowPlacement,
  backEdge: boolean,
): void {
  /** 顶点色在构建期烘焙：默认暖白，反向边（isBackEdge=true）红色警示 */
  const arrowRgb = backEdge ? BACK_ARROW_RGB : DEFAULT_ARROW_RGB
  /**
   * 长度、箭杆与箭头宽度同步缩放，短边不会出现宽度不变的胖箭头。
   * 中心与半长向量写入同批顶点属性，供远景细节淡出使用。
   */
  const halfLength = PATH_DIRECTION_ARROW_LENGTH_M * scale / 2
  const shaft = PATH_DIRECTION_ARROW_SHAFT_HALF_WIDTH_M * scale
  const head = PATH_DIRECTION_ARROW_HEAD_HALF_WIDTH_M * scale
  const headStart = halfLength - PATH_DIRECTION_ARROW_HEAD_LENGTH_M * scale
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
    sink.centers.push(center.x, PATH_DIRECTION_ARROW_Y, center.z)
    sink.spans.push(forward.x * halfLength, 0, forward.z * halfLength)
    sink.colors.push(arrowRgb.r, arrowRgb.g, arrowRgb.b)
    /**
     * 双向箭头同时保存对方的投影参考，两枚使用相同的最小投影长度淡出。
     * 单向路径以自身为参考，避免在斜视或远近变化时把双向边误显成单向。
     */
    sink.partnerCenters.push(partner.center.x, PATH_DIRECTION_ARROW_Y, partner.center.z)
    sink.partnerSpans.push(partner.forward.x * halfLength, 0, partner.forward.z * halfLength)
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
 * 补偿斜接长度（钳制 3×halfWidth 防止近回折处的退化放大）。
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
  markingLayout: PathMarkingLayout,
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
    /**
     * 仅压缩密集节点的水平半径；高度与业务坐标保持原值。
     * 实例矩阵是静态数据，包围球和拾取继续使用 Three.js 的实例变换。
     */
    const radius = markingLayout.nodes.get(node.id)?.radius ?? NODE_OUTER_RADIUS_M
    const scale = radius / NODE_OUTER_RADIUS_M
    matrices[m] = scale
    matrices[m + 5] = 1
    matrices[m + 10] = scale
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
