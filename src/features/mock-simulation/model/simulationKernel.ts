/**
 * Mock 仿真内核：车队领域状态与确定性推进（SPEC §9.1～§9.2；TASK-008）。
 *
 * 职责：在真实有向地图上创建可复现的车队仿真领域状态——按各弱连通分量的
 *       逻辑边数量比例分配车辆、从有效有向边上生成初始位置，并按固定规则
 *       推进：普通行驶只在出边间随机转移、电量低于阈值用 Dijkstra 寻本分量
 *       最近 charge、充至目标电量恢复任务、死路/无充电路径安全停车并产生
 *       Mock 专用数据告警。全部随机决策消费同一条固定种子 PRNG 流。
 * 边界：纯领域内核——不创建计时器、不建立数据源生命周期（那是 TASK-009 的
 *       MockVehicleDataSource）、不依赖 React/Three.js；高频内部状态以普通
 *       对象原地更新（与 createFleetRuntime 同策略），绝不进入 React state。
 *       车辆速度不使用加速度惯性（位置直接由弧长推进决定）。
 * 关键不变量：
 * 1. 可复现：同一 mapModel + 同一 options + 同一 step 调用序列 ⇒ 内核状态
 *   逐步全等（PRNG 消费顺序固定：建车「边→进度→电量→速度→载荷」，到站
 *   「电量裁决→出边随机」）；
 * 2. 拓扑守恒：车辆只沿其所在分量的有向逻辑边移动，绝不瞬移、绝不逆行、
 *   绝不跨分量（寻充路径由有向 Dijkstra 给出，天然不离开本分量）；
 * 3. 大时间差不累积位移：单步时长被钳制到 maxStepSeconds，超出部分直接
 *   丢弃（不结转、不欠账），后台标签页回到前台不会让车辆跳到「未来位置」；
 * 4. 单步换边上限：一步内最多连续跨越 MAX_EDGE_TRANSITIONS_PER_STEP 条边，
 *   超出后丢弃本步剩余里程（防御极短边导致的长转移链，保证步进有界）；
 * 5. 安全停车：死路（节点无出边）停在节点进入 IDLE；找不到充电路径停在
 *   当前位置进入 IDLE——两者都写入 Mock 数据告警且此后保持静止，绝不
 *   传送到其他分量或虚构路径。
 */
import type { MapEdge, MapModel } from '@/features/map-visualization'
import { createEdgeTraverseTable, type EdgeTraverseTable } from './arcLengthTable'
import { resolveCruiseSpeed, resolveEdgeSpeedLimit, sampleTargetSpeed } from './motion'
import { findNearestChargePath } from './pathfinding'
import { createMockPrng, DEFAULT_MOCK_SEED, randomInRange, randomInt, type MockPrng } from './prng'

/** Mock 车辆运行模式：巡航 / 前往充电 / 充电中 / 受阻停车 */
export type MockVehicleMode = 'CRUISE' | 'TO_CHARGE' | 'CHARGING' | 'IDLE_BLOCKED'

/** Mock 专用数据告警码：描述 Mock 数据自身拓扑事实，不是车辆业务故障 */
export type MockVehicleAlertCode = 'MOCK_DEAD_END' | 'MOCK_NO_CHARGE_PATH'

/** 受阻原因：死路（无出边）或找不到本分量充电路径 */
export type MockVehicleBlockedReason = 'DEAD_END' | 'NO_CHARGE_PATH'

/** 低电量寻充阈值（百分比，SPEC §9.2：低于 25% 寻找 charge） */
export const MOCK_LOW_BATTERY_SEEK_PERCENT = 25

/** 充电目标电量（百分比，SPEC §9.2：充至 90% 再恢复任务） */
export const MOCK_CHARGE_TARGET_PERCENT = 90

/** 单步内连续换边上限（防御极短边链，见模块不变量 4） */
export const MAX_EDGE_TRANSITIONS_PER_STEP = 64

/** 内核可调参数；未提供的字段使用缺省值 */
export interface MockSimulationOptions {
  /** 车队规模；TASK-009 默认 60、压力场景 250 */
  vehicleCount: number
  /** 随机种子；缺省 DEFAULT_MOCK_SEED（20260901） */
  seed?: number
  /** 单步时长钳制（秒）；超出部分丢弃不结转。缺省 1s */
  maxStepSeconds?: number
  /** 充电速率（百分比/秒）。缺省 2 */
  chargeRatePercentPerSecond?: number
  /** 行驶电量消耗（百分比/米）。缺省 0.01 */
  batteryDrainPercentPerMeter?: number
  /** 初始电量采样区间下限（百分比）。缺省 30 */
  initialBatteryMinPercent?: number
  /** 初始电量采样区间上限（百分比）。缺省 100 */
  initialBatteryMaxPercent?: number
  /** 车辆带载荷的概率 [0,1]。缺省 0.5 */
  loadedProbability?: number
}

/** 解析后的只读内核配置（options 归一化结果） */
export interface ResolvedMockSimulationConfig {
  readonly vehicleCount: number
  readonly seed: number
  readonly maxStepSeconds: number
  readonly chargeRatePercentPerSecond: number
  readonly batteryDrainPercentPerMeter: number
  readonly lowBatterySeekPercent: number
  readonly chargeTargetPercent: number
  readonly initialBatteryMinPercent: number
  readonly initialBatteryMaxPercent: number
  readonly loadedProbability: number
}

/** 单车仿真领域状态（只读视图；内核内部原地更新，消费方不得改写） */
export interface MockVehicleRuntimeState {
  readonly agvKey: string
  /** 所属弱连通分量序号；车辆终生停留在该分量的边上 */
  readonly componentIndex: number
  readonly mode: MockVehicleMode
  readonly blockedReason: MockVehicleBlockedReason | null
  /** 活跃的 Mock 数据告警（受阻时写入，保持到状态被外部替换） */
  readonly mockAlerts: readonly MockVehicleAlertCode[]
  /** 当前地图坐标位置（米）与朝向（弧度） */
  readonly position: { readonly x: number; readonly y: number; readonly theta: number }
  readonly batteryPercent: number
  readonly charging: boolean
  readonly loaded: boolean
  /** 采样的目标速度（米/秒）；实际速度还受当前边限速钳制 */
  readonly targetSpeed: number
  /** 当前乘用的有向边；充电中或受阻停车时可能为 null */
  readonly currentEdgeId: string | null
  /** 沿当前边的已行进弧长（米） */
  readonly progressM: number
  /** 正在驶向（或停靠在）的节点 ID */
  readonly anchorNodeId: string
}

/** 内核公开视图：确定性推进 + 只读车队状态 */
export interface MockSimulationKernel {
  readonly mapId: string
  readonly config: ResolvedMockSimulationConfig
  /** 推进仿真：dt ≤ 0 为无操作；dt 超过 maxStepSeconds 时只推进钳制值 */
  step(dtSeconds: number): void
  /** 只读车队状态（内部对象零拷贝暴露；发布到事件前必须复制为不可变快照） */
  getVehicleStates(): readonly MockVehicleRuntimeState[]
}

/** 内部可变单车状态（字段与公开视图一一对应，位置对象原地更新） */
interface MockVehicleInternal {
  agvKey: string
  componentIndex: number
  mode: MockVehicleMode
  blockedReason: MockVehicleBlockedReason | null
  mockAlerts: MockVehicleAlertCode[]
  position: { x: number; y: number; theta: number }
  batteryPercent: number
  charging: boolean
  loaded: boolean
  targetSpeed: number
  currentEdgeId: string | null
  progressM: number
  anchorNodeId: string
  /** 前往充电的剩余计划（有向边 ID 队列；首元素即当前边） */
  chargePlan: string[]
}

/** 最大余额法（Hamilton）分配：按份额整数部分打底，余数按份额小数降序、
 *  分量序号升序补齐——确定性且总和恰为 vehicleCount */
export function allocateByEdgeProportion(edgeCounts: readonly number[], vehicleCount: number): number[] {
  const counts = new Array<number>(edgeCounts.length).fill(0)
  if (vehicleCount <= 0) {
    return counts
  }
  const totalEdges = edgeCounts.reduce((sum, n) => sum + n, 0)
  if (totalEdges <= 0) {
    return counts
  }
  let allocated = 0
  const fractions: { index: number; fraction: number }[] = []
  for (let i = 0; i < edgeCounts.length; i += 1) {
    if (edgeCounts[i] <= 0) {
      continue
    }
    const share = (vehicleCount * edgeCounts[i]) / totalEdges
    const base = Math.floor(share)
    counts[i] = base
    allocated += base
    fractions.push({ index: i, fraction: share - base })
  }
  let remaining = vehicleCount - allocated
  fractions.sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  for (const entry of fractions) {
    if (remaining <= 0) {
      break
    }
    counts[entry.index] += 1
    remaining -= 1
  }
  return counts
}

/** 组装边遍历表的惰性缓存（同一内核对同一条边只建一次表） */
class EdgeTableCache {
  private readonly tables = new Map<string, EdgeTraverseTable>()
  private readonly mapModel: MapModel

  constructor(mapModel: MapModel) {
    this.mapModel = mapModel
  }

  get(edgeId: string): EdgeTraverseTable | null {
    const cached = this.tables.get(edgeId)
    if (cached) {
      return cached
    }
    const edge = this.mapModel.edges.get(edgeId)
    if (!edge) {
      return null
    }
    const table = createEdgeTraverseTable(edge)
    this.tables.set(edgeId, table)
    return table
  }
}

/**
 * 创建 Mock 仿真内核。车辆先按分量的逻辑边数量比例（最大余额法）分配到
 * 各弱连通分量，再从该分量的有向边池中随机取边、随机进度生成初始位置；
 * 电量、目标速度与载荷同样从固定 PRNG 流采样。agvKey 按分量顺序连续编号，
 * 保证同配置建车顺序逐位一致。
 */
export function createMockSimulationKernel(
  mapModel: MapModel,
  options: MockSimulationOptions,
): MockSimulationKernel {
  const config: ResolvedMockSimulationConfig = {
    vehicleCount: Math.max(0, Math.floor(options.vehicleCount)),
    seed: options.seed ?? DEFAULT_MOCK_SEED,
    maxStepSeconds: options.maxStepSeconds ?? 1,
    chargeRatePercentPerSecond: options.chargeRatePercentPerSecond ?? 2,
    batteryDrainPercentPerMeter: options.batteryDrainPercentPerMeter ?? 0.01,
    lowBatterySeekPercent: MOCK_LOW_BATTERY_SEEK_PERCENT,
    chargeTargetPercent: MOCK_CHARGE_TARGET_PERCENT,
    initialBatteryMinPercent: options.initialBatteryMinPercent ?? 30,
    initialBatteryMaxPercent: options.initialBatteryMaxPercent ?? 100,
    loadedProbability: options.loadedProbability ?? 0.5,
  }
  const prng: MockPrng = createMockPrng(config.seed)
  const tables = new EdgeTableCache(mapModel)

  // 分量有向边池：按起点节点所属分量归组（边两端必属同一弱连通分量）
  const componentEdgePools: string[][] = mapModel.components.map(() => [])
  for (const edge of mapModel.edgeList) {
    const componentIndex = mapModel.componentIndexOfNode.get(edge.snodeId)
    if (componentIndex === undefined) {
      continue
    }
    componentEdgePools[componentIndex].push(edge.id)
  }

  const vehicles: MockVehicleInternal[] = []
  const allocation = allocateByEdgeProportion(
    componentEdgePools.map((pool) => pool.length),
    config.vehicleCount,
  )
  let serial = 0
  for (let componentIndex = 0; componentIndex < allocation.length; componentIndex += 1) {
    const pool = componentEdgePools[componentIndex]
    for (let n = 0; n < allocation[componentIndex]; n += 1) {
      serial += 1
      vehicles.push(createVehicle(componentIndex, pool, serial))
    }
  }

  /** 在分量边池上生成一辆初始车辆（PRNG 消费顺序固定，见不变量 1） */
  function createVehicle(
    componentIndex: number,
    pool: readonly string[],
    serialNumber: number,
  ): MockVehicleInternal {
    const edgeId = pool[randomInt(prng, pool.length)]
    const edge = mapModel.edges.get(edgeId)
    if (!edge) {
      // 纵深防御：池中边必然存在；失效则降级为停靠起点的静止车辆
      return {
        agvKey: formatAgvKey(serialNumber),
        componentIndex,
        mode: 'IDLE_BLOCKED',
        blockedReason: 'DEAD_END',
        mockAlerts: ['MOCK_DEAD_END'],
        position: { x: 0, y: 0, theta: 0 },
        batteryPercent: config.initialBatteryMinPercent,
        charging: false,
        loaded: false,
        targetSpeed: MOCK_SPEED_FALLBACK,
        currentEdgeId: null,
        progressM: 0,
        anchorNodeId: '',
        chargePlan: [],
      }
    }
    const progress = randomInRange(prng, 0, edge.length)
    const battery = randomInRange(
      prng,
      config.initialBatteryMinPercent,
      config.initialBatteryMaxPercent,
    )
    const targetSpeed = sampleTargetSpeed(prng)
    const loaded = prng() < config.loadedProbability
    const sample = tables.get(edge.id)!.sample(progress)
    return {
      agvKey: formatAgvKey(serialNumber),
      componentIndex,
      mode: 'CRUISE',
      blockedReason: null,
      mockAlerts: [],
      position: { x: sample.x, y: sample.y, theta: sample.theta },
      batteryPercent: battery,
      charging: false,
      loaded,
      targetSpeed,
      currentEdgeId: edge.id,
      progressM: progress,
      anchorNodeId: edge.enodeId,
      chargePlan: [],
    }
  }

  /** 车辆进入一条有向边：进度归零、位置对齐到边起点、锚点更新为终点 */
  function enterEdge(vehicle: MockVehicleInternal, edge: MapEdge): void {
    const table = tables.get(edge.id)
    if (!table) {
      return
    }
    vehicle.currentEdgeId = edge.id
    vehicle.progressM = 0
    vehicle.anchorNodeId = edge.enodeId
    const sample = table.sample(0)
    vehicle.position.x = sample.x
    vehicle.position.y = sample.y
    vehicle.position.theta = sample.theta
  }

  /** 写入一次 Mock 数据告警（同码幂等） */
  function addMockAlert(vehicle: MockVehicleInternal, code: MockVehicleAlertCode): void {
    if (!vehicle.mockAlerts.includes(code)) {
      vehicle.mockAlerts.push(code)
    }
  }

  /** 受阻停车：进入 IDLE_BLOCKED，丢弃在边上的行进状态，位置保持原地 */
  function blockVehicle(
    vehicle: MockVehicleInternal,
    reason: MockVehicleBlockedReason,
    alert: MockVehicleAlertCode,
  ): void {
    vehicle.mode = 'IDLE_BLOCKED'
    vehicle.blockedReason = reason
    vehicle.currentEdgeId = null
    vehicle.progressM = 0
    vehicle.chargePlan = []
    addMockAlert(vehicle, alert)
  }

  /** 到达充电目标：进入 CHARGING，停靠在充电节点（最后一段边的终点） */
  function startCharging(vehicle: MockVehicleInternal): void {
    vehicle.mode = 'CHARGING'
    vehicle.charging = true
    vehicle.currentEdgeId = null
    vehicle.progressM = 0
    vehicle.chargePlan = []
  }

  /**
   * 到站裁决（在边终点调用）：充电计划走完即开始充电；否则低电量先寻充，
   * 寻充失败按无路径受阻；再否则无出边按死路受阻；最后随机选一条出边继续。
   */
  function handleArrival(vehicle: MockVehicleInternal, nodeId: string): void {
    if (vehicle.mode === 'TO_CHARGE') {
      const nextEdgeId = vehicle.chargePlan.shift()
      if (nextEdgeId === undefined) {
        // 计划耗尽：当前节点即目标 charge
        startCharging(vehicle)
        return
      }
      const edge = mapModel.edges.get(nextEdgeId)
      if (edge) {
        enterEdge(vehicle, edge)
      } else {
        // 纵深防御：计划边失效等同无充电路径
        blockVehicle(vehicle, 'NO_CHARGE_PATH', 'MOCK_NO_CHARGE_PATH')
      }
      return
    }
    const outEdgeIds = mapModel.outEdgeIds.get(nodeId) ?? []
    if (vehicle.batteryPercent < config.lowBatterySeekPercent) {
      const path = findNearestChargePath(mapModel, nodeId, vehicle.componentIndex)
      if (path === null) {
        blockVehicle(vehicle, 'NO_CHARGE_PATH', 'MOCK_NO_CHARGE_PATH')
        return
      }
      vehicle.mode = 'TO_CHARGE'
      vehicle.chargePlan = [...path.edgeIds]
      const nextEdgeId = vehicle.chargePlan.shift()
      if (nextEdgeId === undefined) {
        // 当前节点就是 charge：原地开始充电
        startCharging(vehicle)
        return
      }
      const edge = mapModel.edges.get(nextEdgeId)
      if (edge) {
        enterEdge(vehicle, edge)
        return
      }
      blockVehicle(vehicle, 'NO_CHARGE_PATH', 'MOCK_NO_CHARGE_PATH')
      return
    }
    if (outEdgeIds.length === 0) {
      // 死路是合法拓扑（SPEC §9.1）：停在节点进入 IDLE，不瞬移不逆行
      blockVehicle(vehicle, 'DEAD_END', 'MOCK_DEAD_END')
      return
    }
    const nextEdge = mapModel.edges.get(outEdgeIds[randomInt(prng, outEdgeIds.length)])
    if (nextEdge) {
      enterEdge(vehicle, nextEdge)
    } else {
      blockVehicle(vehicle, 'DEAD_END', 'MOCK_DEAD_END')
    }
  }

  /** 推进一辆车一个已钳制的时间步（内部按里程跨边循环） */
  function advanceVehicle(vehicle: MockVehicleInternal, dtSeconds: number): void {
    if (vehicle.mode === 'IDLE_BLOCKED') {
      return
    }
    if (vehicle.mode === 'CHARGING') {
      vehicle.batteryPercent = Math.min(
        config.chargeTargetPercent,
        vehicle.batteryPercent + config.chargeRatePercentPerSecond * dtSeconds,
      )
      if (vehicle.batteryPercent >= config.chargeTargetPercent) {
        // 充至目标电量：恢复任务，从充电节点按正常规则出发
        vehicle.charging = false
        vehicle.mode = 'CRUISE'
        handleArrival(vehicle, vehicle.anchorNodeId)
      }
      return
    }
    const edge = vehicle.currentEdgeId ? mapModel.edges.get(vehicle.currentEdgeId) : null
    const table = vehicle.currentEdgeId ? tables.get(vehicle.currentEdgeId) : null
    if (!edge || !table) {
      // 纵深防御：巡航中失去当前边（地图被替换）按死路隔离
      blockVehicle(vehicle, 'DEAD_END', 'MOCK_DEAD_END')
      return
    }
    // 以「剩余时间」驱动推进：每条边按自身限速把时间换算为里程，
    // 跨边后自然以新边限速继续，避免用旧边速度预支新边里程
    let remainingS = dtSeconds
    let transitions = 0
    for (;;) {
      const currentEdge = vehicle.currentEdgeId ? mapModel.edges.get(vehicle.currentEdgeId) : null
      const currentTable = vehicle.currentEdgeId ? tables.get(vehicle.currentEdgeId) : null
      if (!currentEdge || !currentTable) {
        blockVehicle(vehicle, 'DEAD_END', 'MOCK_DEAD_END')
        return
      }
      const limit = resolveEdgeSpeedLimit(currentEdge, vehicle.loaded)
      const speed = resolveCruiseSpeed(vehicle.targetSpeed, limit)
      const edgeLength = currentTable.totalLength
      const toEndM = edgeLength - vehicle.progressM
      const timeToEndS = speed > 0 ? toEndM / speed : Number.POSITIVE_INFINITY
      if (remainingS < timeToEndS) {
        // 本步走不到边终点：边内弧长推进 + 按里程耗电
        const advanceM = speed * remainingS
        vehicle.progressM += advanceM
        const sample = currentTable.sample(vehicle.progressM)
        vehicle.position.x = sample.x
        vehicle.position.y = sample.y
        vehicle.position.theta = sample.theta
        vehicle.batteryPercent = Math.max(
          0,
          vehicle.batteryPercent - config.batteryDrainPercentPerMeter * advanceM,
        )
        return
      }
      // 抵达边终点：结算这段里程后交由到站裁决；剩余时间留给下一段
      vehicle.progressM = edgeLength
      const sample = currentTable.sample(edgeLength)
      vehicle.position.x = sample.x
      vehicle.position.y = sample.y
      vehicle.position.theta = sample.theta
      vehicle.batteryPercent = Math.max(
        0,
        vehicle.batteryPercent - config.batteryDrainPercentPerMeter * toEndM,
      )
      remainingS -= timeToEndS
      const arrivedNodeId = currentEdge.enodeId
      handleArrival(vehicle, arrivedNodeId)
      if (vehicle.mode !== 'CRUISE' && vehicle.mode !== 'TO_CHARGE') {
        // 到站后进入充电或受阻：本步剩余时间丢弃（不结转）
        return
      }
      transitions += 1
      if (transitions >= MAX_EDGE_TRANSITIONS_PER_STEP) {
        return
      }
    }
  }

  return {
    mapId: mapModel.mapId,
    config,
    step(dtSeconds: number): void {
      // 大时间差不累积位移：只推进钳制后的时长，超出部分直接丢弃
      const effectiveDt = Number.isFinite(dtSeconds)
        ? Math.min(Math.max(dtSeconds, 0), config.maxStepSeconds)
        : 0
      if (effectiveDt <= 0) {
        return
      }
      for (const vehicle of vehicles) {
        advanceVehicle(vehicle, effectiveDt)
      }
    },
    getVehicleStates(): readonly MockVehicleRuntimeState[] {
      return vehicles
    },
  }
}

/** agvKey 编号格式：mock-agv-0001（连续四位，按分量顺序分配） */
function formatAgvKey(serial: number): string {
  return `mock-agv-${String(serial).padStart(4, '0')}`
}

/** 建车降级路径使用的兜底目标速度（米/秒，区间下限） */
const MOCK_SPEED_FALLBACK = 0.5
