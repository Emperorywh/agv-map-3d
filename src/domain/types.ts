/**
 * domain 层纯类型（SPEC §4.1 / §4.2）。
 * 本文件只包含类型定义，无任何运行时依赖；
 * domain 层禁止 import three / react / config（SPEC §12）。
 */

// ---------------------------------------------------------------------------
// 规范化内部模型（SPEC §4.2）
// ---------------------------------------------------------------------------

/** 节点类型；elevator 仅预留（SPEC §4.2 / §6.3，本期不渲染） */
export type NodeKind = 'node' | 'work' | 'charge' | 'park' | 'elevator'

/**
 * 校准参数（SPEC §4.3）：地图平面（米）→ 世界坐标的变换参数。
 * 变换公式见 coordinates.ts（z 轴翻转唯一收口模块）：
 *   wx = s·(x·cosθ - y·sinθ) - ox
 *   wz = -[s·(x·sinθ + y·cosθ) - oy]
 */
export interface Calibration {
  /** 缩放系数（地图单位 → 米），normalize 默认输出 1 */
  scale: number
  /** 地图平面内旋转角（弧度），normalize 默认输出 0 */
  rotationRad: number
  /** 世界原点对应的地图平面 x 偏移（取地图包围盒中心） */
  offsetX: number
  /** 世界原点对应的地图平面 y 偏移（取地图包围盒中心） */
  offsetY: number
}

/** 地图平面上的点（单位：米，y 向上对应世界 -z） */
export interface MapPoint {
  x: number
  y: number
}

/**
 * 地图平面轴对齐包围盒（单位：米）。
 * SPEC §4.3 offset 口径：须涵盖节点、边折线与贝塞尔控制点（曲线含于控制多边形内，
 * 控制点可能超出细分折线）；建筑外壳尺寸（SPEC §5.2）与该 offset 同源，
 * 保证曲线不会贴墙。
 */
export interface MapBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * 折线（SPEC §4.2）：BEZIER 细分或 LINE 两点统一后的路径形态。
 * 携带累积弧长表，供渲染与模拟器（弧长参数化行驶，SPEC §7.2）共用。
 */
export interface Polyline {
  /** 折线点列（地图平面坐标），至少 2 个点 */
  points: MapPoint[]
  /**
   * 累积弧长表：与 points 等长、单调不减、首项为 0；
   * cumulativeLengths[i] = points[0..i] 的折线长度之和。
   */
  cumulativeLengths: number[]
  /** 总弧长（= cumulativeLengths 末项） */
  length: number
}

/** 规范化节点（SPEC §4.2），坐标为地图平面原始值（米） */
export interface NormalizedNode {
  id: string
  name: string
  kind: NodeKind
  x: number
  y: number
  /** 停放/作业朝向（弧度，0 = 地图 +x，逆时针为正）；数据为空时为 null */
  angle: number | null
}

/**
 * 规范化有向边（SPEC §4.2）。
 * geometry 已统一为折线（LINE 两点 / BEZIER 细分），下游不区分曲线直线。
 * 限速 / 加速度等字段实测每条边均存在、值可为 null（SPEC §7.2），null 由消费方用缺省常量兜底。
 */
export interface NormalizedEdge {
  id: string
  name: string
  /** 起点节点 id（源数据 snodeId） */
  from: string
  /** 终点节点 id（源数据 enodeId） */
  to: string
  geometry: Polyline
  /**
   * 进入边时的车头朝向角（弧度）。语义为车头朝向而非运动方向（SPEC §4.1 / §7.2）：
   * isBackEdge=true 时与运动方向相反，不得再叠加 180° 翻转。
   */
  sFacing: number
  /** 离开边时的车头朝向角（弧度）；与 sFacing 不等时沿弧长插值 */
  eFacing: number
  /** true = 该方向 AGV 倒车通过（SPEC §6.1） */
  isBackEdge: boolean
  cost: number
  maxSpeedLoad: number | null
  maxSpeedFree: number | null
  maxRotationSpeedLoad: number | null
  maxRotationSpeedFree: number | null
  maxAccelerationLoad: number | null
  maxAccelerationFree: number | null
  maxDecelerationLoad: number | null
  maxDecelerationFree: number | null
}

/** 走廊内一个行驶方向的属性（SPEC §6.1 / §7.2），对应一条有向边 */
export interface CorridorDirection {
  /** 该方向的有向边 id */
  edgeId: string
  /** 该方向行驶的起点 / 终点节点 id（= 有向边 from / to） */
  from: string
  to: string
  /**
   * true = 沿走廊统一几何 points 顺序行驶；
   * false = 反向行驶——模拟器按 SPEC §7.2 将折线反转复用，与渲染零偏差。
   */
  alongGeometry: boolean
  /** true = 该方向 AGV 倒车通过（源数据 isBackEdge） */
  isBack: boolean
}

/**
 * 走廊（SPEC §6.1）：按无序节点对聚合出的双向/单向通道。
 * 配对与统一几何由 corridors.ts 构建；normalize 阶段即完成聚合。
 */
export interface Corridor {
  id: string
  /** 无序节点对的两个端点（按 id 字典序排列保证确定性） */
  nodeA: string
  nodeB: string
  /** 该走廊包含的有向边 id（1~2 条；两条即双向），与 directions 一一对应 */
  edgeIds: string[]
  /**
   * 走廊统一几何（渲染与模拟共用）：取任一方向，配对边几何偏差超阈值时取较短者；
   * 方向与所选参照有向边一致（directions[].alongGeometry 标识各方向是否顺几何行驶）。
   */
  geometry: Polyline
  /** true = 双向（存在反向配对边，directions 两项）；false = 单向 */
  bidirectional: boolean
  /** 各行驶方向属性（1~2 项）：nodeA→nodeB 方向在前，nodeB→nodeA 在后 */
  directions: CorridorDirection[]
}

/** 规范化地图（SPEC §4.2）：与后端导出格式解耦的内部模型 */
export interface NormalizedMap {
  calibration: Calibration
  /**
   * 地图包围盒（SPEC §4.3 口径：含节点、边折线与贝塞尔控制点）；
   * calibration offset 取其中心，建筑外壳尺寸（SPEC §5.2）同源复用。
   */
  bounds: MapBounds
  /** 取自 data.floor；预留多层，本期恒为 1 */
  floor: number
  nodes: NormalizedNode[]
  edges: NormalizedEdge[]
  corridors: Corridor[]
}

// ---------------------------------------------------------------------------
// map.json 源数据结构（SPEC §4.1）
// 仅声明规范化所读取的字段；其余字段（actions / allowVehicleGroups 等）忽略。
// 源数据为不可信 IO，字段均按可缺失 / 可为 null 声明，由 normalize 校验。
// ---------------------------------------------------------------------------

/** 源节点（mapJson.nodes 元素） */
export interface RawMapNode {
  id?: unknown
  name?: unknown
  type?: unknown
  x?: unknown
  y?: unknown
  angle?: unknown
}

/** 源边（mapJson.edges 元素） */
export interface RawMapEdge {
  id?: unknown
  name?: unknown
  edgeType?: unknown
  sx?: unknown
  sy?: unknown
  ex?: unknown
  ey?: unknown
  cx?: unknown
  cy?: unknown
  dx?: unknown
  dy?: unknown
  snodeId?: unknown
  enodeId?: unknown
  sfacing?: unknown
  efacing?: unknown
  isBackEdge?: unknown
  cost?: unknown
  maxLoadSpeed?: unknown
  maxFreeSpeed?: unknown
  maxLoadRotationSpeed?: unknown
  maxFreeRotationSpeed?: unknown
  maxLoadAcceleration?: unknown
  maxFreeAcceleration?: unknown
  maxLoadDeceleration?: unknown
  maxFreeDeceleration?: unknown
}

/** mapJson 载荷（仅含 4 个数组，zones / nodeEdgeGroups 本期为空，忽略） */
export interface RawMapJson {
  nodes?: unknown
  edges?: unknown
}
