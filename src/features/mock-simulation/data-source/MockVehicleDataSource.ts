/**
 * Mock 车辆数据源（SPEC §3.1、§9.3、§11.6；TASK-009）。
 *
 * 职责：以 TASK-008 仿真内核为引擎实现 VehicleDataSource 合同——connect 时
 *       发布全量 snapshot 建立基线；随后按 2Hz 基频 ±50% 抖动的自调度计时
 *       链推进内核、驱动确定性验收场景并发布 update / remove / heartbeat
 *       事件。全部车辆负载经 fleet-monitoring 公开的 validateVehicle 同一
 *       校验路径归一化，与真实 WebSocket 共享同一事件合同。
 * 边界：计时器与仿真生命周期归本模块（内核本身无计时器）；验收场景只覆盖
 *       上报字段（订单/故障/连接/暂停/交通/定位），不改写内核的运动、电量
 *       与充电语义；不渲染 DOM、不创建 Three 对象、不持有 React 状态；
 *       RECONNECTING/ERROR 对本地仿真不可达（无网络故障语义）。
 * 关键不变量：
 * 1. 可复现（SPEC §9.3）：内容只由 seed 与调用序列决定——内核随机性、场景
 *    时间线与指令落点全部确定；注入同一时钟与随机源时，两次运行的事件序
 *    列（类型、序号、内容、receivedAt）逐位一致；
 * 2. 暂停不积累位移：paused 期间不推进内核、不发布数据事件，但每 tick 仍
 *    刷新 lastTickAt——恢复后的第一步 dt 只有一个普通周期，绝不「补走暂停
 *    期间的路」（内核 maxStepSeconds 钳制是第二道防线）；
 * 3. 幂等生命周期：重复 connect 复用会话；手动 disconnect 清理计时链与
 *    AbortSignal 监听进 CLOSED，绝不自动重连；断开后可再次 connect（车队
 *    状态延续，重连以快照重新对齐，与真实 WS 语义同构）；
 * 4. 删除显式：增删车经内核 addVehicle/removeVehicle 完成并以显式 update/
 *    remove 事件发布，绝不靠快照缺席隐式删除；agvKey 序号全局递增不复用；
 * 5. 序号单调：四类事件共用同一个严格递增 sequence；receivedAt 由注入的
 *    单调时钟在发布时刻打点。
 */
import type { MapModel } from '@/features/map-visualization'
import {
  DEFAULT_VEHICLE_DIMENSION,
  validateVehicle,
  type VehicleSnapshot,
} from '@/features/fleet-monitoring'
import {
  createDiagnosticsReporter,
  describeError,
  type DiagnosticsReporter,
} from '@/shared/diagnostics'
import type {
  SourceStatus,
  Unsubscribe,
  VehicleDataEvent,
  VehicleDataSource,
} from '@/features/fleet-monitoring'
import { DEFAULT_MOCK_SEED } from '../model/prng'
import {
  createMockSimulationKernel,
  formatMockAgvKey,
  parseMockAgvSerial,
  type MockVehicleRuntimeState,
} from '../model/simulationKernel'
import { buildTrafficRectangles } from '../model/trafficRectangle'
import {
  createAcceptanceScenario,
  type AcceptanceScenario,
} from '../scenarios/acceptanceScenario'

/* ==================== 可调常量（SPEC §9.3 / TASKS TASK-009） ==================== */

/** 默认车队规模（台） */
export const MOCK_DEFAULT_VEHICLE_COUNT = 60
/** 压力场景可调上限（台） */
export const MOCK_PRESSURE_VEHICLE_COUNT = 250
/** 基础推送间隔（毫秒）：500ms = 2Hz，实际间隔加 ±50% 抖动 */
export const MOCK_BASE_INTERVAL_MS = 500
/** 心跳间隔（仿真时间毫秒） */
export const MOCK_HEARTBEAT_INTERVAL_MS = 5_000
/** 验收场景窗口（仿真秒） */
export const MOCK_ACCEPTANCE_WINDOW_SECONDS = 120
/** Mock 事件 schema 版本标识 */
export const MOCK_SCHEMA_VERSION = 'mock/1'
/** 初始电量低于寻充阈值的车辆数：保证充电事件在窗口内确定出现 */
export const MOCK_LOW_BATTERY_VEHICLE_COUNT = 2

/** 正常定位置信度（与真实夹具同款满值） */
const MOCK_LOCALIZATION_SCORE = 1
/** 场景注入「低定位」时使用的定位置信度（< 0.5 触发 L1） */
const MOCK_LOW_LOCALIZATION_SCORE = 0.3

/* ==================== 公开类型 ==================== */

export interface MockVehicleDataSourceOptions {
  /** 真实地图拓扑：内核分配、行驶与寻充的唯一地理事实源 */
  mapModel: MapModel
  /** 初始车队规模；缺省 60 */
  vehicleCount?: number
  /** 随机种子；缺省 DEFAULT_MOCK_SEED（20260901） */
  seed?: number
  /** 基础推送间隔（毫秒）；缺省 500（2Hz） */
  baseIntervalMs?: number
  /** 心跳间隔（仿真毫秒）；缺省 5000 */
  heartbeatIntervalMs?: number
  /** 开发桥可调车队上限；缺省 250 */
  maxVehicleCount?: number
  /** 单调时钟；缺省 performance.now()（receivedAt 与推进计时口径） */
  now?: () => number
  /** [0,1) 随机源：只用于推送间隔抖动；缺省 Math.random，测试注入固定值 */
  random?: () => number
  /** 结构化诊断通道；默认创建独立控制台通道 */
  diagnostics?: DiagnosticsReporter
}

/** Mock 仿真读数（开发桥与自测用；全部为低频标量） */
export interface MockDataSourceStats {
  readonly fleetSize: number
  readonly simTimeSeconds: number
  readonly paused: boolean
  readonly scenarioEnabled: boolean
  readonly seed: number
  /** 已发布事件计数（按类型） */
  readonly emittedByType: Readonly<Record<string, number>>
}

/**
 * Mock 开发控制接口（经 __AGV_MOCK__ 暴露的命令面，SPEC §9.3）。
 * 只含命令与读数：修改车辆数、种子、事件开关与暂停状态。
 */
export interface MockDevControl {
  /** 调整车队规模到目标值（0～maxVehicleCount），逐台发布增删事件 */
  setVehicleCount(count: number): void
  getVehicleCount(): number
  /** 暂停/恢复仿真：暂停期间不推进、不发布数据事件、不积累位移 */
  setPaused(paused: boolean): void
  isPaused(): boolean
  /** 开关验收场景时间线（关闭后游标停走，重开只投递未来指令） */
  setScenarioEnabled(enabled: boolean): void
  isScenarioEnabled(): boolean
  /** 整体复位仿真：可同时换种子与车队规模，随后以新快照对齐 */
  resetSimulation(options?: { seed?: number; vehicleCount?: number }): void
  getSeed(): number
  /** 当前仿真读数 */
  getStats(): MockDataSourceStats
}

export interface MockVehicleDataSource extends VehicleDataSource {
  /** 开发控制接口；桥注册（registerMockDevBridge）由 app 组合层按需执行 */
  readonly devControl: MockDevControl
}

/* ==================== 场景覆盖的上报状态 ==================== */

/** 单车场景覆盖（只影响快照原始字段，不触碰内核运动/电量语义） */
interface VehicleOverrideState {
  orderAssigned: boolean
  faultActive: boolean
  offlineActive: boolean
  pausedActive: boolean
  trafficActive: boolean
  lowLocalizationActive: boolean
  /** 任意覆盖变化自增：进入增量签名，保证覆盖切换必然产生一条 update */
  revision: number
}

const createEmptyOverride = (): VehicleOverrideState => ({
  orderAssigned: false,
  faultActive: false,
  offlineActive: false,
  pausedActive: false,
  trafficActive: false,
  lowLocalizationActive: false,
  revision: 0,
})

/* ==================== 数据源实现 ==================== */

/**
 * 创建 Mock 车辆数据源。
 * 内核在本工厂内创建（调用方已保证 MapModel 拓扑就绪）；计时链只在 OPEN
 * 状态存在，disconnect 后内核与场景状态保留，重连以快照重新对齐。
 */
export function createMockVehicleDataSource(
  options: MockVehicleDataSourceOptions,
): MockVehicleDataSource {
  const mapModel = options.mapModel
  const mapId = mapModel.mapId
  const now = options.now ?? ((): number => performance.now())
  const random = options.random ?? Math.random
  const diagnostics = options.diagnostics ?? createDiagnosticsReporter()
  const baseIntervalMs = options.baseIntervalMs ?? MOCK_BASE_INTERVAL_MS
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? MOCK_HEARTBEAT_INTERVAL_MS
  const maxVehicleCount = options.maxVehicleCount ?? MOCK_PRESSURE_VEHICLE_COUNT

  /* ---------- 仿真状态（disconnect 后保留，重连不重置） ---------- */

  let seed = options.seed ?? DEFAULT_MOCK_SEED
  let vehicleCount = options.vehicleCount ?? MOCK_DEFAULT_VEHICLE_COUNT
  let kernel = createMockSimulationKernel(mapModel, {
    vehicleCount,
    seed,
    lowBatteryVehicleCount: MOCK_LOW_BATTERY_VEHICLE_COUNT,
  })
  const scenario: AcceptanceScenario = createAcceptanceScenario({
    windowSeconds: MOCK_ACCEPTANCE_WINDOW_SECONDS,
  })
  /** agvKey → 场景覆盖（车辆删除时同步清理） */
  const overrides = new Map<string, VehicleOverrideState>()
  /** agvKey → 上次发布的内容签名（变化检测，未变化不发布） */
  const signatures = new Map<string, string>()
  /** 已上报过的受阻标记（agvKey:reason，一次采样，不重复刷屏） */
  const blockedReported = new Set<string>()
  /** 仿真累计时间（秒）：场景时间线与心跳的唯一时钟（暂停即冻结） */
  let simTimeSeconds = 0
  let lastHeartbeatSimSeconds = 0
  let paused = false
  let scenarioEnabled = true

  /* ---------- 连接生命周期 ---------- */

  /**
   * 会话状态机：idle → connecting → open → closed；
   * abort 把 connecting/open 拆回 idle（之后紧随的 disconnect 落到 closed）。
   */
  let state: 'idle' | 'connecting' | 'open' | 'closed' = 'idle'
  let tickTimer: ReturnType<typeof setTimeout> | null = null
  /** 上次推进时刻（毫秒，单调时钟）；暂停期间照常刷新以防时间债 */
  let lastTickAt: number | null = null

  let sessionResolve: (() => void) | null = null
  let sessionReject: ((error: unknown) => void) | null = null
  let sessionPromise: Promise<void> | null = null
  let sessionSignal: AbortSignal | null = null
  let sessionOnAbort: (() => void) | null = null

  /* ---------- 订阅者 ---------- */

  const eventSubscribers = new Set<(event: VehicleDataEvent) => void>()
  const statusSubscribers = new Set<(status: SourceStatus) => void>()
  const emittedByType: Record<string, number> = {}

  const currentStatus = (): SourceStatus => {
    switch (state) {
      case 'connecting':
        return 'CONNECTING'
      case 'open':
        return 'OPEN'
      case 'closed':
        return 'CLOSED'
      default:
        return 'IDLE'
    }
  }

  const notifyStatus = (): void => {
    const status = currentStatus()
    for (const cb of [...statusSubscribers]) {
      try {
        cb(status)
      } catch {
        // 订阅者异常隔离：状态通知绝不打断数据源生命周期
      }
    }
  }

  // 四类事件共用一个严格递增序号（从 1 起，永不回退）
  let sequenceCounter = 0
  const nextSequence = (): number => {
    sequenceCounter += 1
    return sequenceCounter
  }

  const emitEvent = (event: VehicleDataEvent): void => {
    emittedByType[event.type] = (emittedByType[event.type] ?? 0) + 1
    for (const cb of [...eventSubscribers]) {
      try {
        cb(event)
      } catch (error) {
        diagnostics.report(
          'MOCK_SUBSCRIBER_ERROR',
          'warn',
          '车辆事件订阅回调异常，已隔离',
          { reason: describeError(error) },
        )
      }
    }
  }

  /* ---------- 快照构建（内核状态 → 原始负载 → 统一校验路径） ---------- */

  /** 把内核只读状态翻译为与真实车辆消息同构的原始负载（受控构造） */
  const buildRawVehicle = (vs: MockVehicleRuntimeState): Record<string, unknown> => {
    const override = overrides.get(vs.agvKey)
    const dimension = DEFAULT_VEHICLE_DIMENSION
    return {
      agvKey: vs.agvKey,
      agvName: vs.agvKey,
      // 与真实夹具同款的未知车型枚举：含义未映射前不解释（SPEC R2）
      type: 1,
      agvPosition: {
        x: vs.position.x,
        y: vs.position.y,
        theta: vs.position.theta,
        localizationScore: override?.lowLocalizationActive
          ? MOCK_LOW_LOCALIZATION_SCORE
          : MOCK_LOCALIZATION_SCORE,
      },
      agvDimension: { ...dimension },
      batteryState: {
        // 三位小数：保留电量趋势判读，同时抑制浮点尾差进入事件内容
        batteryCharge: Math.round(vs.batteryPercent * 1000) / 1000,
        batteryHealth: 100,
        batteryVoltage: 220,
        charging: vs.charging,
      },
      // 速度仅诊断展示用途，不参与位置推算（SPEC §2.4）
      velocity: { vx: 0, vy: 0, omega: 0 },
      connectionState: override?.offlineActive ? 'OFFLINE' : 'ONLINE',
      dispatchState: 'ENABLE',
      // 基线上报「已知空闲组合」：operation 派生为 IDLE，绝不伪装成其他状态
      orderState: override?.orderAssigned ? 'PROCESSING' : 'IDLE',
      vehicleProcStatus: override?.trafficActive ? 'TRAFFIC' : 'IDLE',
      paused: override?.pausedActive ?? false,
      loaded: vs.loaded,
      errorEntryList: override?.faultActive
        ? [{ code: 'MOCK_SCENARIO_FAULT', source: 'acceptance-scenario' }]
        : [],
      // 受阻（死路/无充电路径）是合法拓扑事实而非车辆故障（SPEC §9.1），
      // 不写入 errorEntryList；经由诊断通道观测
      trafficShapeResources: buildReportedTrafficResources(vs, override),
      // 刻意省略 createTime：服务端时间戳不是确定性内容（SPEC §2.4 仅诊断用）
    }
  }

  /** 场景覆盖状态 → 上报交通资源（字段名与真实夹具 trafficShapeResources 同构） */
function buildReportedTrafficResources(
  vs: MockVehicleRuntimeState,
  override: VehicleOverrideState | undefined,
): { lockedRectangles: number[][]; applyingRectangles: number[][] } {
  if (!override?.trafficActive) {
    return { lockedRectangles: [], applyingRectangles: [] }
  }
  const dimension = DEFAULT_VEHICLE_DIMENSION
  const rectangles = buildTrafficRectangles(vs.position, {
    halfLength: dimension.length / 2,
    halfWidth: dimension.width / 2,
  })
  return {
    lockedRectangles: rectangles.locked,
    applyingRectangles: rectangles.applying,
  }
}

/** 增量签名：任一可观测字段或覆盖版本变化都必须产生一条 update */
  const buildSignature = (vs: MockVehicleRuntimeState): string => {
    const override = overrides.get(vs.agvKey)
    return [
      vs.position.x,
      vs.position.y,
      vs.position.theta,
      vs.batteryPercent,
      vs.charging ? 1 : 0,
      vs.loaded ? 1 : 0,
      override?.revision ?? 0,
    ].join('|')
  }

  /** 构建并发布单车上报事件（受控负载被统一校验拒绝时记诊断并跳过该车） */
  const emitUpdateFor = (vs: MockVehicleRuntimeState): void => {
    const result = validateVehicle(buildRawVehicle(vs), mapId)
    if (!result.ok) {
      diagnostics.report(
        'MOCK_SNAPSHOT_REJECTED',
        'error',
        'Mock 生成的车辆负载未通过统一校验（受控构造不应发生），本车本次跳过',
        { agvKey: vs.agvKey, reason: result.reason },
      )
      return
    }
    const event: VehicleDataEvent = {
      type: 'update',
      schemaVersion: MOCK_SCHEMA_VERSION,
      mapId,
      sequence: nextSequence(),
      receivedAt: now(),
      vehicle: result.snapshot,
    }
    emitEvent(event)
    signatures.set(vs.agvKey, buildSignature(vs))
  }

  /** 发布全量快照，并把当前内容设为后续增量的基线 */
  const emitSnapshotEvent = (): void => {
    const vehicles: VehicleSnapshot[] = []
    for (const vs of kernel.getVehicleStates()) {
      const result = validateVehicle(buildRawVehicle(vs), mapId)
      if (result.ok) {
        vehicles.push(result.snapshot)
      } else {
        diagnostics.report(
          'MOCK_SNAPSHOT_REJECTED',
          'error',
          'Mock 生成的车辆负载未通过统一校验（受控构造不应发生），快照中跳过该车',
          { agvKey: vs.agvKey, reason: result.reason },
        )
      }
    }
    emitEvent({
      type: 'snapshot',
      schemaVersion: MOCK_SCHEMA_VERSION,
      mapId,
      sequence: nextSequence(),
      receivedAt: now(),
      vehicles,
    })
    for (const vs of kernel.getVehicleStates()) {
      signatures.set(vs.agvKey, buildSignature(vs))
    }
  }

  /* ---------- 场景指令落实与车队成员变更 ---------- */

  const findVehicle = (agvKey: string): MockVehicleRuntimeState | null => {
    for (const vs of kernel.getVehicleStates()) {
      if (vs.agvKey === agvKey) {
        return vs
      }
    }
    return null
  }

  /** 当前建车序号最大的在册车辆（删车目标：最新加入的成员） */
  const findNewestVehicle = (): MockVehicleRuntimeState | null => {
    let newest: MockVehicleRuntimeState | null = null
    let newestSerial = -1
    for (const vs of kernel.getVehicleStates()) {
      const serial = parseMockAgvSerial(vs.agvKey)
      if (serial !== null && serial > newestSerial) {
        newestSerial = serial
        newest = vs
      }
    }
    return newest
  }

  /** 删除指定车辆并发布显式 remove 事件（OPEN 状态下），同步清理派生缓存 */
  const removeVehicleByKey = (agvKey: string): boolean => {
    if (!kernel.removeVehicle(agvKey)) {
      return false
    }
    overrides.delete(agvKey)
    signatures.delete(agvKey)
    blockedReported.delete(agvKey)
    if (state === 'open') {
      emitEvent({
        type: 'remove',
        schemaVersion: MOCK_SCHEMA_VERSION,
        mapId,
        sequence: nextSequence(),
        receivedAt: now(),
        agvKey,
      })
    }
    return true
  }

  /** 增车：内核创建后以显式 update 发布（运行时把未知键的 update 视为新增） */
  const addVehicleAndEmit = (): void => {
    const added = kernel.addVehicle()
    if (added === null) {
      return
    }
    overrides.delete(added.agvKey)
    signatures.delete(added.agvKey)
    if (state === 'open') {
      emitUpdateFor(added)
    }
  }

  const applyPatchOverride = (
    override: VehicleOverrideState,
    field: string,
    value: string,
  ): void => {
    switch (field) {
      case 'order':
        override.orderAssigned = value === 'assign'
        break
      case 'fault':
        override.faultActive = value === 'on'
        break
      case 'offline':
        override.offlineActive = value === 'on'
        break
      case 'paused':
        override.pausedActive = value === 'on'
        break
      case 'traffic':
        override.trafficActive = value === 'on'
        break
      case 'lowLocalization':
        override.lowLocalizationActive = value === 'on'
        break
    }
    override.revision += 1
  }

  /** 驱动验收场景：取走到期指令并落实（关闭时游标停走，不补发历史） */
  const applyScenarioDirectives = (): void => {
    if (!scenarioEnabled) {
      return
    }
    for (const directive of scenario.advance(simTimeSeconds)) {
      if (directive.kind === 'patch') {
        const key = formatMockAgvKey(directive.serial)
        // 目标序号超出当前车队（小规模自定义）或已被删除：指令安全跳过
        if (findVehicle(key) === null) {
          continue
        }
        const override = overrides.get(key) ?? createEmptyOverride()
        applyPatchOverride(override, directive.patch.field, directive.patch.value)
        overrides.set(key, override)
      } else if (directive.kind === 'remove') {
        const newest = findNewestVehicle()
        if (newest !== null) {
          removeVehicleByKey(newest.agvKey)
        }
      } else {
        addVehicleAndEmit()
      }
    }
  }

  /* ---------- 推进循环（自调度计时链：每tick独立 ±50% 抖动） ---------- */

  const clearTickTimer = (): void => {
    if (tickTimer !== null) {
      clearTimeout(tickTimer)
      tickTimer = null
    }
  }

  const scheduleTick = (): void => {
    clearTickTimer()
    if (state !== 'open') {
      return
    }
    // ±50% 抖动：随机系数落在 [0.5, 1.5)，间隔 ∈ [250, 750)ms（2Hz 基频）
    const delay = baseIntervalMs * (0.5 + random())
    tickTimer = setTimeout(handleTick, delay)
  }

  const handleTick = (): void => {
    tickTimer = null
    if (state !== 'open') {
      return
    }
    const timestamp = now()
    const last = lastTickAt ?? timestamp
    // 暂停期间也刷新基准点：恢复后第一步只有一个普通周期（不变量 2）
    lastTickAt = timestamp
    if (!paused) {
      const dtSeconds = Math.max(0, (timestamp - last) / 1000)
      if (dtSeconds > 0) {
        // 内核对超时再钳制一次（maxStepSeconds），大时间差丢弃超额部分
        kernel.step(dtSeconds)
        simTimeSeconds += dtSeconds
      }
      applyScenarioDirectives()
      publishChanges()
      maybeEmitHeartbeat()
    }
    scheduleTick()
  }

  /** 对比签名发布增量：静止车（受阻/充电满/被暂停覆盖）自然静默 */
  const publishChanges = (): void => {
    for (const vs of kernel.getVehicleStates()) {
      if (vs.mode === 'IDLE_BLOCKED' && vs.blockedReason !== null) {
        const marker = `${vs.agvKey}:${vs.blockedReason}`
        if (!blockedReported.has(marker)) {
          blockedReported.add(marker)
          diagnostics.report(
            'MOCK_VEHICLE_BLOCKED',
            'warn',
            'Mock 车辆安全停车（死路/无充电路径属合法拓扑），此后保持静止上报',
            { agvKey: vs.agvKey, reason: vs.blockedReason, alerts: [...vs.mockAlerts] },
          )
        }
      }
      if (signatures.get(vs.agvKey) === buildSignature(vs)) {
        continue
      }
      emitUpdateFor(vs)
    }
  }

  const maybeEmitHeartbeat = (): void => {
    if (simTimeSeconds - lastHeartbeatSimSeconds < heartbeatIntervalMs / 1000) {
      return
    }
    lastHeartbeatSimSeconds = simTimeSeconds
    emitEvent({
      type: 'heartbeat',
      schemaVersion: MOCK_SCHEMA_VERSION,
      mapId,
      sequence: nextSequence(),
      receivedAt: now(),
    })
  }

  /* ---------- 会话与 AbortSignal ---------- */

  const detachSessionSignal = (): void => {
    if (sessionSignal !== null && sessionOnAbort !== null) {
      sessionSignal.removeEventListener('abort', sessionOnAbort)
    }
    sessionSignal = null
    sessionOnAbort = null
  }

  const resolveSession = (): void => {
    sessionResolve?.()
    sessionResolve = null
    sessionReject = null
  }

  const rejectSession = (error: unknown): void => {
    sessionReject?.(error)
    sessionResolve = null
    sessionReject = null
  }

  const abortError = (): unknown =>
    new DOMException('Mock 数据源连接已被中止', 'AbortError')

  /** AbortSignal 中止：拆除会话回到 IDLE（随后到达的 disconnect 落到 CLOSED） */
  const handleSessionAbort = (): void => {
    detachSessionSignal()
    clearTickTimer()
    state = 'idle'
    lastTickAt = null
    rejectSession(abortError())
    notifyStatus()
  }

  /** 会话起点：发布基线快照 → OPEN → 启动推进计时链 */
  const beginSession = (): void => {
    emitSnapshotEvent()
    state = 'open'
    lastTickAt = now()
    lastHeartbeatSimSeconds = simTimeSeconds
    notifyStatus()
    resolveSession()
    scheduleTick()
  }

  /* ---------- VehicleDataSource 合同实现 ---------- */

  const connect = (signal?: AbortSignal): Promise<void> => {
    // 幂等：连接中 / 已打开 → 复用进行中的会话 promise
    if (state === 'open' || state === 'connecting') {
      return sessionPromise ?? Promise.resolve()
    }
    detachSessionSignal()
    if (signal?.aborted) {
      return Promise.reject(abortError())
    }
    state = 'connecting'
    const promise = new Promise<void>((resolve, reject) => {
      sessionResolve = resolve
      sessionReject = reject
    })
    sessionPromise = promise
    if (signal) {
      sessionSignal = signal
      sessionOnAbort = (): void => {
        handleSessionAbort()
      }
      signal.addEventListener('abort', sessionOnAbort, { once: true })
    }
    notifyStatus()
    // 本地仿真无异步握手：基线快照与 OPEN 在同一任务内完成
    beginSession()
    return promise
  }

  /** 手动断开：清理计时链与监听进 CLOSED；绝不自动重连；幂等 */
  const disconnect = (): void => {
    detachSessionSignal()
    clearTickTimer()
    state = 'closed'
    lastTickAt = null
    resolveSession()
    notifyStatus()
  }

  const requestSnapshot = (): void => {
    // 幂等语义：非 OPEN 状态为无操作；OPEN 时每次调用发布一份当前全量
    if (state !== 'open') {
      return
    }
    emitSnapshotEvent()
  }

  /* ---------- 开发控制（__AGV_MOCK__ 命令面） ---------- */

  const devControl: MockDevControl = {
    setVehicleCount(count: number): void {
      const target = Math.min(
        Math.max(0, Math.floor(Number.isFinite(count) ? count : 0)),
        maxVehicleCount,
      )
      let guard = 0
      const maxIterations = maxVehicleCount + 1
      while (kernel.getVehicleStates().length < target && guard < maxIterations) {
        const before = kernel.getVehicleStates().length
        addVehicleAndEmit()
        if (kernel.getVehicleStates().length === before) {
          break
        }
        guard += 1
      }
      guard = 0
      while (kernel.getVehicleStates().length > target && guard < maxIterations) {
        const newest = findNewestVehicle()
        if (newest === null || !removeVehicleByKey(newest.agvKey)) {
          break
        }
        guard += 1
      }
    },
    getVehicleCount(): number {
      return kernel.getVehicleStates().length
    },
    setPaused(value: boolean): void {
      paused = value
    },
    isPaused(): boolean {
      return paused
    },
    setScenarioEnabled(value: boolean): void {
      scenarioEnabled = value
    },
    isScenarioEnabled(): boolean {
      return scenarioEnabled
    },
    resetSimulation(resetOptions: { seed?: number; vehicleCount?: number } = {}): void {
      seed = resetOptions.seed ?? seed
      vehicleCount = resetOptions.vehicleCount ?? vehicleCount
      kernel = createMockSimulationKernel(mapModel, {
        vehicleCount,
        seed,
        lowBatteryVehicleCount: MOCK_LOW_BATTERY_VEHICLE_COUNT,
      })
      overrides.clear()
      signatures.clear()
      blockedReported.clear()
      scenario.reset()
      simTimeSeconds = 0
      lastHeartbeatSimSeconds = 0
      if (state === 'open') {
        // 复位后立即以新车队快照重新对齐（增量基线同步重建）
        emitSnapshotEvent()
      }
    },
    getSeed(): number {
      return seed
    },
    getStats(): MockDataSourceStats {
      return {
        fleetSize: kernel.getVehicleStates().length,
        simTimeSeconds,
        paused,
        scenarioEnabled,
        seed,
        emittedByType: { ...emittedByType },
      }
    },
  }

  return {
    connect,
    disconnect,
    requestSnapshot,
    get status(): SourceStatus {
      return currentStatus()
    },
    onEvent(cb: (event: VehicleDataEvent) => void): Unsubscribe {
      eventSubscribers.add(cb)
      return () => {
        eventSubscribers.delete(cb)
      }
    },
    onStatusChange(cb: (status: SourceStatus) => void): Unsubscribe {
      statusSubscribers.add(cb)
      return () => {
        statusSubscribers.delete(cb)
      }
    },
    devControl,
  }
}
