/**
 * 地图原始 JSON 类型与只读 MapModel（SPEC §2.1～§2.3、§12.2；TASK-003）。
 *
 * 职责：定义 map.json 的原始元素形态（字段以 unknown 进入，由 validateMap
 *       逐项裁决）以及校验后、冻结的只读模型类型：节点、逻辑边、独占区分组、
 *       弱连通分量、场景包围盒与各类索引。
 * 边界：只声明数据合同，不含解析、校验或派生逻辑；不引用 Three.js 类型。
 * 关键不变量：
 * 1. 节点与边的 ID 是不透明字符串：全链路禁止转数字、禁止假设其格式；
 * 2. 逻辑边实际字段名为 edgeType（'LINE' | 'BEZIER'）；LINE 的控制点字段
 *    恒为 null，BEZIER 的控制点必填——两个方向都不允许第三种形态；
 * 3. MapModel 一经创建不可变：所有条目与数组被冻结，索引以 ReadonlyMap
 *    暴露，构建期可变容器不进入公开 API；世界原点与 sceneBounds 在创建时
 *    一次定型，不随任何后续事件改变。
 */

/** 原始地图元素：字段全部按 unknown 读取，由 validateMap 裁决 */
export type RawMapElement = Record<string, unknown>

/** 原始 map.json 顶层结构（zones 当前为空数组，缺失或空时直接跳过） */
export interface RawMapJson {
  mapId?: unknown
  nodes?: unknown
  edges?: unknown
  zones?: unknown
  nodeEdgeGroups?: unknown
}

/** 逻辑边几何类型（实际字段名为 edgeType，SPEC §2.2） */
export type EdgeType = 'LINE' | 'BEZIER'

/**
 * 节点类别：五种已知业务类型 + 未知兜底，直接对应原始 type 字段。
 * 普通 node 是合法导航节点，不应误报为未知类型或混用未知标识。
 * 未知类型节点保留在地图中（category='unknown'），渲染层使用灰色通用站点，
 * 并产生一次采样数据告警，不阻断地图（SPEC §2.1）。
 */
export type NodeCategory = 'node' | 'work' | 'warehouse' | 'charge' | 'park' | 'unknown'

/** 已知节点类型集合（validateMap 以此判定 category） */
export const KNOWN_NODE_TYPES: ReadonlySet<string> = new Set([
  'node',
  'work',
  'warehouse',
  'charge',
  'park',
])

/**
 * 节点展示语义角色（视觉对齐改造 P0-5.4 的派生字段）。
 * 原始 type/category 只描述业务数据，不直接决定视觉权重；本角色在不修改
 * 调度数据的前提下为监控场景提供显隐与权重依据：
 * - route-control：纯导航控制点，监控场景默认只在车辆近景显示；
 * - junction：道路交叉节点（按邻居度数 ≥3 派生）；
 * - work-station：真实作业工位；
 * - storage-slot：仓储库位，近景按需显示（中景由仓储聚合轮廓接管）；
 * - charge / park：充电设施 / 停车点；
 * - landmark：独立视觉地标（当前数据无此形态，预留）。
 */
export type NodeVisualRole =
  | 'route-control'
  | 'junction'
  | 'work-station'
  | 'storage-slot'
  | 'charge'
  | 'park'
  | 'landmark'

/** 校验后的地图节点（坐标与 ID 已保证有效；angle 允许为 null） */
export interface MapNode {
  readonly id: string
  /** 显示名；原始数据缺失时回退为 id */
  readonly name: string
  /** 原始 type 字符串（未知类型原样保留，供诊断与兜底渲染） */
  readonly type: string
  /**
   * 归一类别：已知五类之一或 unknown。
   * 渲染样式以该类别为准，不使用节点名称或道路邻居数猜测业务类型。
   */
  readonly category: NodeCategory
  readonly mapId: string
  readonly x: number
  readonly y: number
  /** 节点朝向（弧度）；当前数据全为 null，渲染器不得依赖其存在 */
  readonly angle: number | null
}

/** 校验后的有向逻辑边（保留全部拓扑语义；物理长度为派生只读值） */
export interface MapEdge {
  readonly id: string
  readonly mapId: string
  readonly edgeType: EdgeType
  readonly sx: number
  readonly sy: number
  readonly ex: number
  readonly ey: number
  /** BEZIER 控制点；LINE 恒为 null（SPEC §2.2 允许的 null） */
  readonly cx: number | null
  readonly cy: number | null
  readonly dx: number | null
  readonly dy: number | null
  /** 引用已通过校验的节点 ID（悬空引用的边在校验阶段被逐项剔除） */
  readonly snodeId: string
  readonly enodeId: string
  /** 业务方向属性；渲染去重不得以其为唯一依据（SPEC §2.2） */
  readonly isBackEdge: boolean
  /** 代价与限速：缺失或非法时为 null，调用方必须回退（如物理长度） */
  readonly cost: number | null
  readonly maxLoadSpeed: number | null
  readonly maxFreeSpeed: number | null
  /**
   * 逻辑边物理长度：LINE 为端点直线距离；BEZIER 为固定 24 段采样折线长度。
   * 供寻路代价回退与几何构建复用，单位与地图坐标一致（米）。
   */
  readonly length: number
}

/** 校验后的独占区分组（成员引用已逐项过滤，无效引用不阻断分组本身） */
export interface MapGroup {
  readonly id: string
  /** 显示名；原始数据缺失时回退为 id */
  readonly name: string
  readonly memberNodeIds: readonly string[]
  readonly memberEdgeIds: readonly string[]
}

/** 弱连通分量（节点数降序编号；每个分量都可用于 Mock 的比例分配与寻充） */
export interface MapComponent {
  /** 分量序号：按节点数降序 0..n-1（同尺寸按最小节点插入序稳定排序） */
  readonly index: number
  readonly nodeIds: readonly string[]
  /** 本分量内的 charge 节点 ID（§9.2 低电量寻充的查询索引） */
  readonly chargeNodeIds: readonly string[]
  /** 本分量包含的有向逻辑边数量（Mock 按比例分配车辆用） */
  readonly edgeCount: number
}

/** 世界坐标场景包围盒（由节点经世界变换后的 AABB 派生；创建时一次定型） */
export interface SceneBounds {
  readonly minWorldX: number
  readonly maxWorldX: number
  readonly minWorldZ: number
  readonly maxWorldZ: number
  readonly centerWorldX: number
  readonly centerWorldZ: number
  /**
   * 包围盒对角线用于布局余量、场景细节和远裁剪估算。
   * 相机缩远上限独立按厂房视锥覆盖计算。
   */
  readonly diagonal: number
}

/**
 * 只读地图模型：map-visualization 对后续场景与 Mock 暴露的最小公共 API。
 * 顺序列表（nodeList 等）保持输入顺序（过滤后），索引 Map 用于 O(1) 查询；
 * 两者内容一致，消费方按需选用，不得假设其中一方可变。
 */
export interface MapModel {
  /** 全图唯一 mapId（顶层缺省时由第一个有效节点派生） */
  readonly mapId: string
  readonly nodeList: readonly MapNode[]
  readonly edgeList: readonly MapEdge[]
  readonly groupList: readonly MapGroup[]
  readonly nodes: ReadonlyMap<string, MapNode>
  readonly edges: ReadonlyMap<string, MapEdge>
  readonly groups: ReadonlyMap<string, MapGroup>
  /** 有向出边索引：nodeId → 以该节点为起点的逻辑边 ID（无出边为空数组） */
  readonly outEdgeIds: ReadonlyMap<string, readonly string[]>
  /** nodeId → 展示语义角色（全节点覆盖；派生只读，见 NodeVisualRole 注释） */
  readonly nodeVisualRoles: ReadonlyMap<string, NodeVisualRole>
  /** 弱连通分量（节点数降序；孤立节点构成单节点分量） */
  readonly components: readonly MapComponent[]
  /** nodeId → 所属分量 index（全节点覆盖） */
  readonly componentIndexOfNode: ReadonlyMap<string, number>
  readonly sceneBounds: SceneBounds
}

/** 逐项隔离产生的数据异常（由调用方写入结构化诊断通道，不阻断建模） */
export type MapAnomalyCode =
  | 'MAP_NODE_INVALID'
  | 'MAP_NODE_DUPLICATE_ID'
  | 'MAP_NODE_UNKNOWN_TYPE'
  | 'MAP_EDGE_INVALID'
  | 'MAP_EDGE_DANGLING_REF'
  | 'MAP_GROUP_INVALID'
  | 'MAP_GROUP_MEMBER_INVALID'
  | 'MAP_MAPID_CONFLICT'

export interface MapAnomaly {
  readonly code: MapAnomalyCode
  readonly level: 'warn' | 'error'
  readonly message: string
  readonly context: Readonly<Record<string, unknown>>
}

/** validateMap 的输出：已过滤、已冻结的元素与逐项异常记录 */
export interface ValidatedMapData {
  readonly mapId: string
  readonly nodes: readonly MapNode[]
  readonly edges: readonly MapEdge[]
  readonly groups: readonly MapGroup[]
  readonly anomalies: readonly MapAnomaly[]
}
