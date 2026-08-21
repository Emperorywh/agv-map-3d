/**
 * AGV 模拟器（SPEC §7.1 / §7.2）：任务流状态机 + 电量模型 + 走廊弧长运动学。
 *
 * - 状态机：IDLE / TO_PICK / LOADING / TO_DROP / UNLOADING / TO_CHARGE / CHARGING；
 *   对外状态集合为 空闲 / 去取货 / 载货中 / 去充电 / 充电中 / 装卸中（LOADING 与
 *   UNLOADING 统称装卸中），状态色映射见 config/theme.ts 的 agvStatusColors；
 * - 运动学：沿走廊统一几何（同一 Polyline 对象）弧长参数化行驶，反向行驶时折线
 *   反转复用，与渲染 ribbon 零偏差；朝向语义遵守实测结论——sfacing/efacing 为车头
 *   朝向，back 边上与运动方向相反是 sfacing 语义的自然推论，严禁再叠加 180° 翻转；
 * - 确定性：不读真实时钟与帧率，由调用方以固定步长驱动 stepSimulator(state, dt)；
 *   随机性全部来自可注入种子的 mulberry32，同一种子行为完全可复现（SPEC §15.5）。
 *
 * domain 层纯 TS：不 import three / react / config（SPEC §12）；速度 / 电量 / 时长
 * 等常量均以参数注入（应用层取值集中于 config/constants.ts）。
 */

import { headingToWorldYaw, mapToWorld } from './coordinates'
import type { WorldPoint } from './coordinates'
import { buildRouteGraph, findNearestRoute, findRoute } from './graph'
import type { GraphWeightMode, Route, RouteGraph } from './graph'
import { samplePolylineAt } from './polyline'
import type { MapPoint, NormalizedEdge, NormalizedMap, NormalizedNode, Polyline } from './types'

// ---------------------------------------------------------------------------
// 缺省常量（domain 层兜底值；应用层由 config/constants.ts 注入同名配置）
// ---------------------------------------------------------------------------

/** 模拟器随机种子缺省值（SPEC §15.5 种子常量，调试时可固定） */
export const DEFAULT_SIM_SEED = 20260821
/** 默认模拟 AGV 数量（SPEC §7.1 默认 20 台，上限按 100 设计） */
export const DEFAULT_AGV_COUNT = 20
/** 装卸停留时长缺省值（秒，SPEC §7.1 停留 N 秒） */
export const DEFAULT_LOAD_UNLOAD_SECONDS = 3
/** IDLE 决策重试间隔缺省值（秒）：无空闲充电位 / 规划失败后的重试冷却 */
export const DEFAULT_IDLE_RETRY_SECONDS = 1
/** 低电量阈值缺省值（百分比） */
export const DEFAULT_BATTERY_LOW_THRESHOLD = 20
/** 行驶耗电缺省值（百分比 / 米） */
export const DEFAULT_BATTERY_DRAIN_PER_METER = 0.05
/** 充电恢复缺省值（百分比 / 秒） */
export const DEFAULT_BATTERY_CHARGE_PER_SECOND = 2
/** 边限速 / 加速度 / 角速度字段为 null 时的缺省值（SPEC §7.2 缺省兜底） */
export const DEFAULT_MAX_SPEED = 2
export const DEFAULT_ACCELERATION = 0.8
export const DEFAULT_DECELERATION = 1.2
export const DEFAULT_ROTATION_SPEED = Math.PI / 2
/** 倒车速度相对正向的系数缺省值（SPEC §7.2 倒车速度低于正向） */
export const DEFAULT_BACK_SPEED_FACTOR = 0.5

// ---------------------------------------------------------------------------
// 状态与快照类型
// ---------------------------------------------------------------------------

/** 模拟器内部状态机状态（SPEC §7.1） */
export type AgvInternalState =
  | 'IDLE'
  | 'TO_PICK'
  | 'LOADING'
  | 'TO_DROP'
  | 'UNLOADING'
  | 'TO_CHARGE'
  | 'CHARGING'

/**
 * 对外状态集合（SPEC §7.1）：空闲 / 去取货 / 载货中 / 去充电 / 充电中 / 装卸中。
 * 键名与 config/theme.ts 的 agvStatusColors 一一对应（domain 不 import config，
 * 键名一致性由 simulator.test.ts 断言）。
 */
export type AgvStatus = 'idle' | 'toPick' | 'hauling' | 'toCharge' | 'charging' | 'loading'

const EXTERNAL_STATUS_BY_INTERNAL: Record<AgvInternalState, AgvStatus> = {
  IDLE: 'idle',
  TO_PICK: 'toPick',
  TO_DROP: 'hauling',
  TO_CHARGE: 'toCharge',
  CHARGING: 'charging',
  LOADING: 'loading',
  UNLOADING: 'loading',
}

/** 内部状态 → 对外状态（LOADING / UNLOADING 统称装卸中） */
export function toExternalStatus(state: AgvInternalState): AgvStatus {
  return EXTERNAL_STATUS_BY_INTERNAL[state]
}

/** 单台 AGV 的对外快照（供 TASK-010 渲染与 TASK-013/014 面板读取；每次调用新建对象） */
export interface AgvSnapshot {
  /** AGV 编号（0 起，按创建顺序） */
  id: number
  /** 对外状态（SPEC §7.1 状态集合） */
  status: AgvStatus
  /** 电量百分比（模拟值，0~100） */
  battery: number
  /** 当前行驶所在有向边 id；停靠时为 null */
  edgeId: string | null
  /** 当前停靠节点 id；行驶中为 null（途经节点视为在边上） */
  nodeId: string | null
  /** 当前任务描述（演示用，如“取货 W12”）；空闲时为 null */
  task: string | null
  /** 世界坐标（经 coordinates.ts 统一转换，y 恒为 0） */
  position: WorldPoint
  /** 世界 yaw（three rotation.y，经 headingToWorldYaw 换算） */
  yaw: number
}

/** 模拟器配置（全部由调用方注入；缺省值取本模块 DEFAULT_*） */
export interface SimulatorOptions {
  /** 随机种子（mulberry32），缺省 DEFAULT_SIM_SEED */
  seed?: number
  /** AGV 台数，缺省 DEFAULT_AGV_COUNT（20，上限按 100 设计） */
  agvCount?: number
  /** 装卸停留时长（秒） */
  loadUnloadSeconds?: number
  /** IDLE 决策重试间隔（秒） */
  idleRetrySeconds?: number
  /** 低电量阈值（百分比） */
  batteryLowThreshold?: number
  /** 行驶耗电（百分比 / 米） */
  batteryDrainPerMeter?: number
  /** 充电恢复（百分比 / 秒） */
  batteryChargePerSecond?: number
  /** 边限速字段 null 时的缺省速度（m/s） */
  defaultMaxSpeed?: number
  /** 边加速度字段 null 时的缺省加速度（m/s²） */
  defaultAcceleration?: number
  /** 边减速度字段 null 时的缺省减速度（m/s²） */
  defaultDeceleration?: number
  /** 边旋转速度字段 null 时的缺省角速度（rad/s） */
  defaultRotationSpeed?: number
  /** 倒车速度相对正向的系数 */
  backSpeedFactor?: number
  /** 路径规划权重模式（SPEC §7.1 常量切换） */
  graphWeightMode?: GraphWeightMode
}

interface ResolvedSimulatorConfig {
  seed: number
  agvCount: number
  loadUnloadSeconds: number
  idleRetrySeconds: number
  batteryLowThreshold: number
  batteryDrainPerMeter: number
  batteryChargePerSecond: number
  defaultMaxSpeed: number
  defaultAcceleration: number
  defaultDeceleration: number
  defaultRotationSpeed: number
  backSpeedFactor: number
  graphWeightMode: GraphWeightMode
}

/** 一条行驶腿（有向边 + 走廊统一几何）的解析缓存 */
interface LegInfo {
  /** 有向边（限速 / 朝向 / isBackEdge 等按行驶方向取用） */
  edge: NormalizedEdge
  /** 走廊统一几何（与渲染共用的同一 Polyline 对象，SPEC §7.2 零偏差） */
  geometry: Polyline
  /** true = 沿几何 points 顺序行驶；false = 反向行驶（弧长递减，即折线反转复用） */
  alongGeometry: boolean
  /** true = 该方向倒车通过（车头与运动方向相反，由 sfacing 语义自然得出） */
  isBack: boolean
}

/** 单台 AGV 的模拟内部状态（纯数据，stepSimulator 原地更新） */
export interface AgvSimState {
  id: number
  /** 内部状态机状态 */
  state: AgvInternalState
  /** 电量百分比（0~100） */
  battery: number
  /** 地图平面车头朝向（弧度，0 = 地图 +x，逆时针为正；车头语义见 SPEC §7.2） */
  heading: number
  /** 停靠所在节点 id；行驶中为 null */
  nodeId: string | null
  /** 当前路径的有向边 id 序列（行驶顺序）；非行驶状态为 null */
  routeEdgeIds: string[] | null
  /** 当前腿在 routeEdgeIds 中的下标 */
  routeIndex: number
  /** 当前腿上已行驶的弧长（米，沿行驶方向计量） */
  legDistance: number
  /** 当前速度（m/s） */
  speed: number
  /** 当前腿入边朝向是否已对齐（节点处朝向突变时先原地旋转，SPEC §7.2） */
  legAligned: boolean
  /** 装卸停留剩余时间（秒，LOADING / UNLOADING 有效） */
  dwellRemaining: number
  /** IDLE 决策冷却剩余时间（秒） */
  retryRemaining: number
  /** 当前任务：取货 / 卸货 / 充电目标节点 id（无任务时为 null） */
  pickNodeId: string | null
  dropNodeId: string | null
  chargeNodeId: string | null
}

/** 模拟器全量状态（纯数据容器；createSimulator 创建，stepSimulator 原地更新） */
export interface SimulatorState {
  readonly config: ResolvedSimulatorConfig
  /** 路径规划图（构建期固化权重模式） */
  readonly graph: RouteGraph
  /** mulberry32 当前状态（每抽一次随机数前进一步，保证种子可复现） */
  rngState: number
  /** 累计模拟时间（秒，仅由 step 步长累加，不读真实时钟） */
  time: number
  /** 模拟器异常告警计数（SPEC §10：如找不到可达充电位，AGV 回 IDLE 并计数） */
  alertCount: number
  readonly agvs: AgvSimState[]
  /** 充电位占用互斥表：charge 节点 id → 占用 AGV id */
  readonly chargeOccupancy: Map<string, number>
  /** 节点查表 */
  readonly nodeById: ReadonlyMap<string, NormalizedNode>
  /** 有向边 → 行驶腿（走廊统一几何）查表 */
  readonly legByEdgeId: ReadonlyMap<string, LegInfo>
  /** work / charge 节点 id 列表（地图顺序，任务与充电候选） */
  readonly workNodeIds: readonly string[]
  readonly chargeNodeIds: readonly string[]
  /** 世界坐标换算校准（snapshot 输出世界坐标 / yaw 用，坐标转换唯一收口 coordinates.ts） */
  readonly calibration: NormalizedMap['calibration']
}

// ---------------------------------------------------------------------------
// 创建
// ---------------------------------------------------------------------------

/** 创建模拟器：构建规划图、种子随机初始摆放（park 互斥，不足顺延 work），初始均 IDLE 满电 */
export function createSimulator(map: NormalizedMap, options?: SimulatorOptions): SimulatorState {
  const config = resolveOptions(options)

  const nodeById = new Map<string, NormalizedNode>()
  for (const node of map.nodes) {
    nodeById.set(node.id, node)
  }
  const edgeById = new Map<string, NormalizedEdge>()
  for (const edge of map.edges) {
    edgeById.set(edge.id, edge)
  }
  const legByEdgeId = new Map<string, LegInfo>()
  for (const corridor of map.corridors) {
    for (const direction of corridor.directions) {
      const edge = edgeById.get(direction.edgeId)
      if (edge === undefined) {
        continue
      }
      legByEdgeId.set(direction.edgeId, {
        edge,
        geometry: corridor.geometry,
        alongGeometry: direction.alongGeometry,
        isBack: direction.isBack,
      })
    }
  }

  const state: SimulatorState = {
    config,
    graph: buildRouteGraph(map.edges, {
      weightMode: config.graphWeightMode,
      defaultSpeed: config.defaultMaxSpeed,
    }),
    rngState: config.seed | 0,
    time: 0,
    alertCount: 0,
    agvs: [],
    chargeOccupancy: new Map(),
    nodeById,
    legByEdgeId,
    workNodeIds: map.nodes.filter((node) => node.kind === 'work').map((node) => node.id),
    chargeNodeIds: map.nodes.filter((node) => node.kind === 'charge').map((node) => node.id),
    calibration: map.calibration,
  }

  // 初始摆放（SPEC §7.1）：种子随机打乱顺序依次占用 park 节点（每节点至多一台），
  // 不足时顺延 work 节点（同样互斥）；park 仅 64 < 100 上限，溢出落 work 为设计内行为。
  const shuffledPark = shuffled(
    map.nodes.filter((node) => node.kind === 'park').map((node) => node.id),
    state,
  )
  const shuffledWork = shuffled(state.workNodeIds, state)
  for (let i = 0; i < config.agvCount; i++) {
    const nodeId = i < shuffledPark.length ? shuffledPark[i] : shuffledWork[i - shuffledPark.length]
    const node = nodeId === undefined ? undefined : nodeById.get(nodeId)
    if (node === undefined) {
      // park + work 全部占满仍放不下（设计规模内不出现）：跳过该台并告警计数（SPEC §10）
      state.alertCount++
      console.warn(
        `[simulator] park/work 节点不足，AGV ${i} 无法初始摆放，已跳过（累计告警 ${state.alertCount}）`,
      )
      continue
    }
    state.agvs.push({
      id: i,
      state: 'IDLE',
      battery: 100,
      // 停靠期间车头对齐节点 angle（SPEC §7.2）；无 angle 时取 0
      heading: node.angle ?? 0,
      nodeId: node.id,
      routeEdgeIds: null,
      routeIndex: 0,
      legDistance: 0,
      speed: 0,
      legAligned: false,
      dwellRemaining: 0,
      retryRemaining: 0,
      pickNodeId: null,
      dropNodeId: null,
      chargeNodeId: null,
    })
  }
  return state
}

function resolveOptions(options?: SimulatorOptions): ResolvedSimulatorConfig {
  return {
    seed: options?.seed ?? DEFAULT_SIM_SEED,
    agvCount: options?.agvCount ?? DEFAULT_AGV_COUNT,
    loadUnloadSeconds: options?.loadUnloadSeconds ?? DEFAULT_LOAD_UNLOAD_SECONDS,
    idleRetrySeconds: options?.idleRetrySeconds ?? DEFAULT_IDLE_RETRY_SECONDS,
    batteryLowThreshold: options?.batteryLowThreshold ?? DEFAULT_BATTERY_LOW_THRESHOLD,
    batteryDrainPerMeter: options?.batteryDrainPerMeter ?? DEFAULT_BATTERY_DRAIN_PER_METER,
    batteryChargePerSecond: options?.batteryChargePerSecond ?? DEFAULT_BATTERY_CHARGE_PER_SECOND,
    defaultMaxSpeed: options?.defaultMaxSpeed ?? DEFAULT_MAX_SPEED,
    defaultAcceleration: options?.defaultAcceleration ?? DEFAULT_ACCELERATION,
    defaultDeceleration: options?.defaultDeceleration ?? DEFAULT_DECELERATION,
    defaultRotationSpeed: options?.defaultRotationSpeed ?? DEFAULT_ROTATION_SPEED,
    backSpeedFactor: options?.backSpeedFactor ?? DEFAULT_BACK_SPEED_FACTOR,
    graphWeightMode: options?.graphWeightMode ?? 'lengthOverSpeed',
  }
}

// ---------------------------------------------------------------------------
// 步进（纯函数语义：仅依赖 state 与 dt，不读真实时钟 / 帧率 / 外部随机源）
// ---------------------------------------------------------------------------

/**
 * 以固定步长推进模拟（SPEC §7.1：由渲染循环以固定步长调用，与帧率解耦）。
 * 仅原地更新 state；同一种子与步长序列下行为完全可复现。
 */
export function stepSimulator(state: SimulatorState, dt: number): void {
  if (!(dt > 0)) {
    return
  }
  state.time += dt
  for (const agv of state.agvs) {
    stepAgv(state, agv, dt)
  }
}

function stepAgv(state: SimulatorState, agv: AgvSimState, dt: number): void {
  switch (agv.state) {
    case 'IDLE':
      stepIdle(state, agv, dt)
      break
    case 'TO_PICK':
    case 'TO_DROP':
    case 'TO_CHARGE':
      stepDriving(state, agv, dt)
      break
    case 'LOADING':
    case 'UNLOADING':
      stepDwell(state, agv, dt)
      break
    case 'CHARGING':
      stepCharging(state, agv, dt)
      break
  }
}

// ---------------------------------------------------------------------------
// IDLE：电量检查与任务 / 充电决策（SPEC §7.1）
// ---------------------------------------------------------------------------

function stepIdle(state: SimulatorState, agv: AgvSimState, dt: number): void {
  const { config } = state
  // 停靠期间车头对齐节点 angle（SPEC §7.2）
  alignHeadingToNodeAngle(state, agv, dt)
  if (agv.retryRemaining > 0) {
    agv.retryRemaining = Math.max(0, agv.retryRemaining - dt)
    return
  }
  if (agv.battery < config.batteryLowThreshold) {
    planCharge(state, agv)
  } else {
    planTask(state, agv)
  }
}

/** 低电量 → 最近空闲 charge 节点（“最近”按路径权重代价，非欧氏距离）；无空闲位留 IDLE 重试 */
function planCharge(state: SimulatorState, agv: AgvSimState): void {
  const { config } = state
  const freeChargeIds = state.chargeNodeIds.filter((id) => !state.chargeOccupancy.has(id))
  if (freeChargeIds.length === 0) {
    // 无空闲位：留 IDLE 重试（SPEC §7.1；属正常竞争，不告警）
    agv.retryRemaining = config.idleRetrySeconds
    return
  }
  const here = agv.nodeId
  const nearest = here === null ? null : findNearestRoute(state.graph, here, freeChargeIds)
  if (nearest === null) {
    // 找不到可达充电位：回 IDLE 并告警计数（SPEC §10），不拖垮全局
    raiseAlert(state, agv, '找不到可达充电位')
    agv.retryRemaining = config.idleRetrySeconds
    return
  }
  // 充电位占用互斥：决策即预定，TO_CHARGE / CHARGING 全程持有
  state.chargeOccupancy.set(nearest.target, agv.id)
  agv.chargeNodeId = nearest.target
  beginRoute(state, agv, nearest.route, 'TO_CHARGE')
}

/** 电量正常 → 随机 work 取货（种子随机，SPEC §15.5） */
function planTask(state: SimulatorState, agv: AgvSimState): void {
  const { config } = state
  const here = agv.nodeId
  if (state.workNodeIds.length === 0 || here === null) {
    raiseAlert(state, agv, '无可用 work 节点，无法派发任务')
    agv.retryRemaining = config.idleRetrySeconds
    return
  }
  const pickNodeId = pickRandom(state.workNodeIds, state)
  const result = findRoute(state.graph, here, pickNodeId)
  if (!result.reachable) {
    raiseAlert(state, agv, `取货点 ${nodeName(state, pickNodeId)} 不可达`)
    agv.retryRemaining = config.idleRetrySeconds
    return
  }
  agv.pickNodeId = pickNodeId
  agv.dropNodeId = null
  beginRoute(state, agv, result.route, 'TO_PICK')
}

// ---------------------------------------------------------------------------
// 行驶：走廊统一几何弧长推进 + 朝向约束（SPEC §7.2）
// ---------------------------------------------------------------------------

/** 节点处相邻边朝向差小于该值（弧度）视为连续，可不停车通过 */
const HEADING_PASS_EPSILON = 1e-6

/** 开始一条路径：重置腿进度；空路径（已在目标点）立即完成到达 */
function beginRoute(
  state: SimulatorState,
  agv: AgvSimState,
  route: Route,
  travelState: 'TO_PICK' | 'TO_DROP' | 'TO_CHARGE',
): void {
  agv.routeEdgeIds = route.edgeIds
  agv.routeIndex = 0
  agv.legDistance = 0
  agv.speed = 0
  agv.legAligned = false
  agv.state = travelState
  if (route.edgeIds.length === 0) {
    completeArrival(state, agv)
  }
}

function currentLeg(state: SimulatorState, agv: AgvSimState): LegInfo {
  // routeEdgeIds 中的边必然在 legByEdgeId 中（路径由同一批有向边规划而来）
  return state.legByEdgeId.get(agv.routeEdgeIds![agv.routeIndex]) as LegInfo
}

/** AGV 是否载货（TO_DROP / UNLOADING 为载货；限速字段据此取 Load / Free 组） */
function isLoaded(agv: AgvSimState): boolean {
  return agv.state === 'TO_DROP' || agv.state === 'UNLOADING'
}

function stepDriving(state: SimulatorState, agv: AgvSimState, dt: number): void {
  const { config } = state
  const leg = currentLeg(state, agv)
  const loaded = isLoaded(agv)

  // 入边朝向对齐：节点处相邻边朝向突变时原地旋转后再出发（SPEC §7.2）；
  // 角速度取当前待进入边的 maxFree/LoadRotationSpeed（null 用缺省常量）
  if (!agv.legAligned) {
    const rotationSpeed = positiveOrDefault(
      loaded ? leg.edge.maxRotationSpeedLoad : leg.edge.maxRotationSpeedFree,
      config.defaultRotationSpeed,
    )
    const rotated = rotateToward(agv.heading, leg.edge.sFacing, rotationSpeed * dt)
    agv.heading = rotated.heading
    if (rotated.done) {
      agv.legAligned = true
    }
    return
  }

  const length = leg.geometry.length
  const remaining = length - agv.legDistance
  const isLastLeg = agv.routeIndex === agv.routeEdgeIds!.length - 1
  const nextLeg = isLastLeg
    ? null
    : (state.legByEdgeId.get(agv.routeEdgeIds![agv.routeIndex + 1]) as LegInfo)
  // 末腿必须停车到节点；中间节点相邻边朝向突变时也必须停车旋转（SPEC §7.2）
  const stopRequired =
    isLastLeg ||
    Math.abs(angleDifference(leg.edge.eFacing, nextLeg!.edge.sFacing)) > HEADING_PASS_EPSILON

  // 速度 / 加减速取当前行驶方向有向边字段（null 用缺省常量）；倒车边限速乘系数
  let maxSpeed = positiveOrDefault(
    loaded ? leg.edge.maxSpeedLoad : leg.edge.maxSpeedFree,
    config.defaultMaxSpeed,
  )
  if (leg.isBack) {
    maxSpeed *= config.backSpeedFactor
  }
  const acceleration = positiveOrDefault(
    loaded ? leg.edge.maxAccelerationLoad : leg.edge.maxAccelerationFree,
    config.defaultAcceleration,
  )
  const deceleration = positiveOrDefault(
    loaded ? leg.edge.maxDecelerationLoad : leg.edge.maxDecelerationFree,
    config.defaultDeceleration,
  )

  // 目标速度：限速与“剩余距离内可停住”的制动包线取小
  let targetSpeed = maxSpeed
  if (stopRequired) {
    targetSpeed = Math.min(targetSpeed, Math.sqrt(2 * deceleration * Math.max(0, remaining)))
  }
  let speed = agv.speed
  if (speed < targetSpeed) {
    speed = Math.min(speed + acceleration * dt, targetSpeed)
  } else if (speed > targetSpeed) {
    speed = Math.max(speed - deceleration * dt, targetSpeed)
  }

  const advance = speed * dt
  if (advance >= remaining) {
    // 到达本边末端节点：只按实际行驶里程计耗电（SPEC §7.1 按里程线性消耗）
    agv.legDistance = length
    agv.battery = Math.max(0, agv.battery - config.batteryDrainPerMeter * remaining)
    agv.heading = leg.edge.eFacing
    agv.nodeId = leg.edge.to
    if (isLastLeg) {
      agv.speed = 0
      completeArrival(state, agv)
      return
    }
    // 途经节点：跨入下一腿（本步剩余时间并入下一步处理，固定步长下确定性不受影响）
    agv.routeIndex++
    agv.legDistance = 0
    if (stopRequired) {
      // 朝向突变：停车，下一步原地旋转对齐下一边 sFacing
      agv.speed = 0
      agv.legAligned = false
    } else {
      // 朝向连续：不停车通过；入腿速度封顶，保证下一停车点可在腿内停住
      agv.legAligned = true
      agv.heading = nextLeg!.edge.sFacing
      agv.speed = Math.min(speed, entrySpeedCap(state, agv, nextLeg!))
    }
    return
  }

  agv.legDistance += advance
  agv.speed = speed
  agv.battery = Math.max(0, agv.battery - config.batteryDrainPerMeter * advance)
  // 朝向约束：进入边对齐 sFacing、离开边对齐 eFacing；不等时沿弧长插值（SPEC §7.2）
  const t = agv.legDistance / length
  agv.heading = lerpAngle(leg.edge.sFacing, leg.edge.eFacing, t)
}

/**
 * 跨节点不停车时的入腿速度上限：
 * 下一腿为末腿或其末端节点需停车旋转时，按下一腿减速度保证腿内可停住。
 */
function entrySpeedCap(state: SimulatorState, agv: AgvSimState, leg: LegInfo): number {
  const { config } = state
  const loaded = isLoaded(agv)
  let maxSpeed = positiveOrDefault(
    loaded ? leg.edge.maxSpeedLoad : leg.edge.maxSpeedFree,
    config.defaultMaxSpeed,
  )
  if (leg.isBack) {
    maxSpeed *= config.backSpeedFactor
  }
  const isLastLeg = agv.routeIndex === agv.routeEdgeIds!.length - 1
  if (isLastLeg) {
    const deceleration = positiveOrDefault(
      loaded ? leg.edge.maxDecelerationLoad : leg.edge.maxDecelerationFree,
      config.defaultDeceleration,
    )
    return Math.min(maxSpeed, Math.sqrt(2 * deceleration * leg.geometry.length))
  }
  const afterNext = state.legByEdgeId.get(agv.routeEdgeIds![agv.routeIndex + 1]) as LegInfo
  if (Math.abs(angleDifference(leg.edge.eFacing, afterNext.edge.sFacing)) > HEADING_PASS_EPSILON) {
    const deceleration = positiveOrDefault(
      loaded ? leg.edge.maxDecelerationLoad : leg.edge.maxDecelerationFree,
      config.defaultDeceleration,
    )
    return Math.min(maxSpeed, Math.sqrt(2 * deceleration * leg.geometry.length))
  }
  return maxSpeed
}

/** 路径耗尽到达终点：按当前行驶状态进入下一相位（SPEC §7.1 状态机迁移） */
function completeArrival(state: SimulatorState, agv: AgvSimState): void {
  agv.routeEdgeIds = null
  agv.routeIndex = 0
  agv.legDistance = 0
  agv.speed = 0
  switch (agv.state) {
    case 'TO_PICK':
      agv.state = 'LOADING'
      agv.dwellRemaining = state.config.loadUnloadSeconds
      break
    case 'TO_DROP':
      agv.state = 'UNLOADING'
      agv.dwellRemaining = state.config.loadUnloadSeconds
      break
    case 'TO_CHARGE':
      agv.state = 'CHARGING'
      break
    default:
      break
  }
}

// ---------------------------------------------------------------------------
// 装卸停留与充电
// ---------------------------------------------------------------------------

/** LOADING / UNLOADING：停留 N 秒；期间节点 angle 非空时车头对齐 angle（SPEC §7.2） */
function stepDwell(state: SimulatorState, agv: AgvSimState, dt: number): void {
  alignHeadingToNodeAngle(state, agv, dt)
  agv.dwellRemaining -= dt
  if (agv.dwellRemaining > 0) {
    return
  }
  agv.dwellRemaining = 0
  if (agv.state === 'LOADING') {
    planDrop(state, agv)
  } else {
    // UNLOADING 完成：任务结束回流 IDLE（SPEC §7.1），下一步立即可决策
    agv.state = 'IDLE'
    agv.pickNodeId = null
    agv.dropNodeId = null
    agv.retryRemaining = 0
  }
}

/** 装货完成 → 规划到另一 work 卸货（异于取货点；不可达时回 IDLE 并告警计数） */
function planDrop(state: SimulatorState, agv: AgvSimState): void {
  const here = agv.nodeId
  // “另一 work”（SPEC §7.1）：候选排除取货点；全图仅一个 work 时退化为自身
  const candidates = state.workNodeIds.filter((id) => id !== agv.pickNodeId)
  const pool = candidates.length > 0 ? candidates : state.workNodeIds
  if (here === null || pool.length === 0) {
    raiseAlert(state, agv, '无可用卸货点')
    backToIdle(state, agv)
    return
  }
  const dropNodeId = pickRandom(pool, state)
  const result = findRoute(state.graph, here, dropNodeId)
  if (!result.reachable) {
    raiseAlert(state, agv, `卸货点 ${nodeName(state, dropNodeId)} 不可达`)
    backToIdle(state, agv)
    return
  }
  agv.dropNodeId = dropNodeId
  beginRoute(state, agv, result.route, 'TO_DROP')
}

/** CHARGING：按时间恢复电量（%/s，SPEC §7.1），充满释放充电位并回 IDLE */
function stepCharging(state: SimulatorState, agv: AgvSimState, dt: number): void {
  alignHeadingToNodeAngle(state, agv, dt)
  agv.battery = Math.min(100, agv.battery + state.config.batteryChargePerSecond * dt)
  if (agv.battery >= 100) {
    if (agv.chargeNodeId !== null) {
      state.chargeOccupancy.delete(agv.chargeNodeId)
    }
    agv.chargeNodeId = null
    agv.state = 'IDLE'
    agv.retryRemaining = 0
  }
}

/** 异常回流：清任务回 IDLE 并带重试冷却（SPEC §10：该 AGV 回 IDLE 并告警计数） */
function backToIdle(state: SimulatorState, agv: AgvSimState): void {
  agv.state = 'IDLE'
  agv.routeEdgeIds = null
  agv.routeIndex = 0
  agv.legDistance = 0
  agv.speed = 0
  agv.pickNodeId = null
  agv.dropNodeId = null
  if (agv.chargeNodeId !== null) {
    state.chargeOccupancy.delete(agv.chargeNodeId)
    agv.chargeNodeId = null
  }
  agv.retryRemaining = state.config.idleRetrySeconds
}

/** 停靠期间车头对齐节点 angle（SPEC §7.2）；无 angle 或无停靠节点时保持 */
function alignHeadingToNodeAngle(state: SimulatorState, agv: AgvSimState, dt: number): void {
  if (agv.nodeId === null) {
    return
  }
  const node = state.nodeById.get(agv.nodeId)
  if (node === undefined || node.angle === null) {
    return
  }
  agv.heading = rotateToward(agv.heading, node.angle, state.config.defaultRotationSpeed * dt).heading
}

function raiseAlert(state: SimulatorState, agv: AgvSimState, reason: string): void {
  state.alertCount++
  console.warn(`[simulator] AGV ${agv.id} ${reason}，回 IDLE 重试（累计告警 ${state.alertCount}）`)
}

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------

/** 对外快照：每台 AGV 一个新对象（供渲染 / 面板按帧读取，不与内部状态共享引用） */
export function snapshotSimulator(state: SimulatorState): AgvSnapshot[] {
  return state.agvs.map((agv) => snapshotAgv(state, agv))
}

/** 单台 AGV 快照（供按 id 定点读取） */
export function snapshotAgv(state: SimulatorState, agv: AgvSimState): AgvSnapshot {
  const driving = agv.routeEdgeIds !== null
  return {
    id: agv.id,
    status: toExternalStatus(agv.state),
    battery: agv.battery,
    edgeId: driving ? agv.routeEdgeIds![agv.routeIndex] : null,
    nodeId: driving ? null : agv.nodeId,
    task: taskLabel(state, agv),
    position: mapToWorld(agvMapPoint(state, agv), state.calibration),
    yaw: headingToWorldYaw(agv.heading, state.calibration),
  }
}

/** 当前地图平面位置：行驶中按走廊统一几何弧长采样（反向行驶折线反转），停靠取节点坐标 */
function agvMapPoint(state: SimulatorState, agv: AgvSimState): MapPoint {
  if (agv.routeEdgeIds !== null) {
    const leg = currentLeg(state, agv)
    const s = leg.alongGeometry
      ? agv.legDistance
      : leg.geometry.length - agv.legDistance
    return samplePolylineAt(leg.geometry, s).point
  }
  const node = state.nodeById.get(agv.nodeId!)
  return { x: node!.x, y: node!.y }
}

function taskLabel(state: SimulatorState, agv: AgvSimState): string | null {
  switch (agv.state) {
    case 'TO_PICK':
    case 'LOADING':
      return `取货 ${nodeName(state, agv.pickNodeId)}`
    case 'TO_DROP':
    case 'UNLOADING':
      return `卸货 ${nodeName(state, agv.dropNodeId)}`
    case 'TO_CHARGE':
    case 'CHARGING':
      return `充电 ${nodeName(state, agv.chargeNodeId)}`
    default:
      return null
  }
}

function nodeName(state: SimulatorState, nodeId: string | null): string {
  if (nodeId === null) {
    return '?'
  }
  return state.nodeById.get(nodeId)?.name ?? nodeId
}

// ---------------------------------------------------------------------------
// 确定性随机与角度工具（模块内部）
// ---------------------------------------------------------------------------

/** mulberry32 单步（纯函数）：返回 [0, 1) 随机数与下一状态 */
function rngNext(rngState: number): { value: number; next: number } {
  const next = (rngState + 0x6d2b79f5) | 0
  let t = Math.imul(next ^ (next >>> 15), 1 | next)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, next }
}

/** 抽一个 [0, 1) 随机数并推进模拟器随机状态（唯一随机源，保证种子可复现） */
function drawRandom(state: SimulatorState): number {
  const result = rngNext(state.rngState)
  state.rngState = result.next
  return result.value
}

/** Fisher–Yates 洗牌（种子随机，返回新数组） */
function shuffled(items: readonly string[], state: SimulatorState): string[] {
  const result = items.slice()
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(drawRandom(state) * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

/** 种子随机取一元素（调用方保证非空数组） */
function pickRandom(items: readonly string[], state: SimulatorState): string {
  return items[Math.floor(drawRandom(state) * items.length)]
}

/** 角度差包裹到 (-π, π]：b - a 的最短弧（带符号） */
function angleDifference(a: number, b: number): number {
  let diff = (b - a) % (2 * Math.PI)
  if (diff <= -Math.PI) {
    diff += 2 * Math.PI
  } else if (diff > Math.PI) {
    diff -= 2 * Math.PI
  }
  return diff
}

/** 沿最短弧插值朝向（t ∈ [0, 1]），输出包裹到 (-π, π] */
function lerpAngle(a: number, b: number, t: number): number {
  const wrapped = a + angleDifference(a, b) * t
  return angleDifference(0, wrapped)
}

/** 以最大角步长转向目标；|差值| ≤ 步长时吸附对齐 */
function rotateToward(
  heading: number,
  target: number,
  maxStep: number,
): { heading: number; done: boolean } {
  const diff = angleDifference(heading, target)
  if (Math.abs(diff) <= maxStep) {
    return { heading: angleDifference(0, target), done: true }
  }
  return { heading: angleDifference(0, heading + Math.sign(diff) * maxStep), done: false }
}

/** 边字段缺省兜底：null 或非正数取缺省常量（SPEC §7.2：字段存在、值可 null） */
function positiveOrDefault(value: number | null, fallback: number): number {
  return value !== null && value > 0 ? value : fallback
}
