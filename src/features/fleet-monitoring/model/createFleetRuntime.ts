/**
 * 高频车队运行时（SPEC §2.6、§4、§11.1、§11.6、§11.13；TASK-006）。
 *
 * 职责：以普通 Map 持有全部车辆实体的高频最新状态（最新快照、单调接收时间、
 *       freshness、派生状态缓存），归并四类 VehicleDataEvent（snapshot diff
 *       产生 added/removed/updated、update 不隐式删除、remove 幂等、heartbeat
 *       不触碰实体），维护脏集合（pose/display/removed）供渲染层每帧批量
 *       消费，并提供 1Hz tick 只做 FRESH/STALE 跃迁。
 * 边界：与 React 完全无关——快照、实体表与脏集合绝不进入 React state 或
 *       zustand（SPEC §4）；事件的外壳校验、协议映射与序号治理属数据源层
 *       （事件到达时已携带完成校验与 mapId 补全的 VehicleSnapshot），本运行
 *       时只做纵深防御式形态检查。地图上下文由事件携带的 mapId 决定，实体
 *       键 (mapId, agvKey) 天然隔离不同地图。
 * 关键不变量：
 * 1. 单调接收时间：实体 lastReceivedAt 只增不减（取 max），freshness 一律
 *    以它与单调时钟的差值计算，服务端时间戳不参与（SPEC §2.4/§11.1）；
 * 2. freshness 跃迁守恒：tick 只在 FRESH↔STALE 边界产生变化并标记 display
 *    脏；有效 update 到达立即恢复 FRESH；heartbeat 不刷新单车新鲜度；
 * 3. 脏标记最小化：pose 仅在位置/朝向/尺寸实际变化（或新增）时标记，display
 *    仅在主状态/副徽标/告警/载荷/电量/名称签名变化（或 freshness 跃迁）时
 *    标记——为渲染层「未变化槽位不写」提供依据；
 * 4. 快照 diff 的删除只作用于事件 mapId 的实体空间：其他地图的同名车不受
 *    影响（实体键隔离，SPEC §2.4）；
 * 5. 全部实体与脏集合都是运行时自有普通对象；对外只暴露只读视图与键列表，
 *    消费方无法经公开接口改写高频状态。
 */
import {
  createDiagnosticsReporter,
  type DiagnosticsReporter,
} from '@/shared/diagnostics'
import { isFiniteNumber } from '@/shared/validation'
import type {
  HeartbeatEvent,
  RemoveEvent,
  SnapshotEvent,
  UpdateEvent,
  VehicleDataEvent,
} from '../data-source/contract'
import { deriveVehicleState, projectDisplayState } from './deriveVehicleState'
import {
  createVehicleEntityKey,
  type StaticVehicleState,
  type VehicleDisplayState,
  type VehicleFreshness,
  type VehicleSnapshot,
} from './types'

/** 默认单车数据过期阈值（SPEC §2.6：本地连续 10s 无有效更新为 STALE） */
export const DEFAULT_STALE_AFTER_MS = 10_000

/** 运行时实体的可变内部形态（高频字段由运行时原地更新，不经 React） */
export interface FleetEntityData {
  readonly key: string
  readonly mapId: string
  readonly agvKey: string
  /** 最新已校验快照（整体替换，不原地修改） */
  snapshot: VehicleSnapshot
  staticState: StaticVehicleState
  displayState: VehicleDisplayState
  freshness: VehicleFreshness
  /** 本地单调接收时间（毫秒）；只增不减 */
  lastReceivedAt: number
  lastServerTime: number | null
}

/** 对外只读实体视图：消费方只能读取，不能改写高频状态 */
export type ReadonlyFleetEntity = Readonly<FleetEntityData>

/** 一次事件归并产生的实体键差异（added/updated/removed 互不相交） */
export interface FleetDiff {
  readonly added: readonly string[]
  readonly updated: readonly string[]
  readonly removed: readonly string[]
}

/** 供渲染帧批量消费的脏集合（consume 后清空） */
export interface DirtyBatch {
  readonly pose: readonly string[]
  readonly display: readonly string[]
  readonly removed: readonly string[]
}

export interface CreateFleetRuntimeOptions {
  /** 单车过期阈值（毫秒）；默认 10s，来自运行时配置 staleAfterMs */
  staleAfterMs?: number
  /** 结构化诊断通道；默认创建独立通道（事件外壳拒绝为采样告警） */
  diagnostics?: DiagnosticsReporter
  /** 单调时钟；默认 performance.now()，仅在事件缺 receivedAt 时兜底 */
  now?: () => number
}

/** 只读车队查询视图：app 组合层与其他 Feature 允许依赖的全部能力 */
export interface ReadonlyFleetRuntime {
  readonly staleAfterMs: number
  get(key: string): ReadonlyFleetEntity | undefined
  /** 全部实体的只读快照列表（插入序稳定） */
  entities(): readonly ReadonlyFleetEntity[]
  readonly count: number
}

export interface FleetRuntime extends ReadonlyFleetRuntime {
  /** 归并一个已校验事件；事件外壳非法时整条拒绝并记录采样诊断 */
  applyEvent(event: VehicleDataEvent): FleetDiff
  /** 1Hz 跃迁推进：只处理 FRESH/STALE 边界；now 为单调毫秒 */
  tick(now: number): void
  /**
   * 强制全量脏标记（SPEC §11.5）：把当前全部存活实体标记为 pose+display 脏。
   * 用于页面回前台后的「强制 diff、瞬时对齐」——隐藏期间帧同步未运行，可能
   * 存在脏标记被提前消费或标记缺失的边界，回前台时以本方法保证下一个渲染帧
   * 把全部实例缓冲重写到运行时当前真相。只标记存活实体，不制造 removed。
   */
  markAllDirty(): void
  /** 取出自上次消费以来的脏集合并清空 */
  consumeDirty(): DirtyBatch
}

const EMPTY_DIFF: FleetDiff = { added: [], updated: [], removed: [] }

/** 事件外壳要求的四个事件类型 */
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'snapshot',
  'update',
  'remove',
  'heartbeat',
])

export function createFleetRuntime(
  options: CreateFleetRuntimeOptions = {},
): FleetRuntime {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  const fallbackNow = options.now ?? (() => performance.now())
  const diagnostics =
    options.diagnostics ?? createDiagnosticsReporter()

  /** 实体表：键为 (mapId, agvKey) 编码，值为可变内部实体 */
  const entities = new Map<string, FleetEntityData>()
  const dirtyPose = new Set<string>()
  const dirtyDisplay = new Set<string>()
  const dirtyRemoved = new Set<string>()

  /** 新建或更新实体；返回是否为新增。数据本身立即生效并恢复 FRESH */
  const upsert = (
    snapshot: VehicleSnapshot,
    receivedAt: number,
  ): 'added' | 'updated' => {
    const existing = entities.get(snapshot.entityKey)
    if (existing === undefined) {
      const staticState = deriveVehicleState(snapshot)
      const entity: FleetEntityData = {
        key: snapshot.entityKey,
        mapId: snapshot.mapId,
        agvKey: snapshot.agvKey,
        snapshot,
        staticState,
        displayState: projectDisplayState(staticState, 'FRESH'),
        freshness: 'FRESH',
        lastReceivedAt: receivedAt,
        lastServerTime: snapshot.serverTime,
      }
      entities.set(entity.key, entity)
      dirtyPose.add(entity.key)
      dirtyDisplay.add(entity.key)
      return 'added'
    }

    const poseChanged = poseSignature(existing.snapshot) !== poseSignature(snapshot)
    const nextStatic = deriveVehicleState(snapshot)
    const nextDisplay = projectDisplayState(nextStatic, 'FRESH')
    const displayChanged =
      displaySignature(existing.snapshot, existing.staticState, existing.displayState) !==
      displaySignature(snapshot, nextStatic, nextDisplay)
    const freshnessRecovering = existing.freshness !== 'FRESH'

    // 单调接收时间：只增不减（SPEC §11.1）；数据本身仍立即生效
    existing.lastReceivedAt = Math.max(existing.lastReceivedAt, receivedAt)
    existing.snapshot = snapshot
    existing.staticState = nextStatic
    existing.lastServerTime = snapshot.serverTime
    existing.freshness = 'FRESH'
    existing.displayState = nextDisplay
    if (poseChanged) {
      dirtyPose.add(existing.key)
    }
    if (displayChanged || freshnessRecovering) {
      dirtyDisplay.add(existing.key)
    }
    return 'updated'
  }

  /** 幂等删除：不存在的键为 no-op；删除键从其他脏集合移除（清理优先） */
  const removeEntity = (mapId: string, agvKey: string): string | null => {
    const key = createVehicleEntityKey(mapId, agvKey)
    if (!entities.has(key)) {
      return null
    }
    entities.delete(key)
    dirtyPose.delete(key)
    dirtyDisplay.delete(key)
    dirtyRemoved.add(key)
    return key
  }

  const applySnapshot = (event: SnapshotEvent, receivedAt: number): FleetDiff => {
    const added: string[] = []
    const updated: string[] = []
    const presentKeys = new Set<string>()
    // 同一快照内重复 agvKey：后到条目覆盖先到（同一实体只保留最终状态）
    for (const snapshot of event.vehicles) {
      presentKeys.add(snapshot.entityKey)
      const outcome = upsert(snapshot, receivedAt)
      if (outcome === 'added') {
        added.push(snapshot.entityKey)
      } else {
        updated.push(snapshot.entityKey)
      }
    }
    // 全量基线：同 mapId 中未出现在快照里的实体视为删除（SPEC §3.2）。
    // 先收集后删除，避免在遍历实体表的过程中修改它。
    const missing: FleetEntityData[] = []
    for (const entity of entities.values()) {
      if (entity.mapId === event.mapId && !presentKeys.has(entity.key)) {
        missing.push(entity)
      }
    }
    const removed: string[] = []
    for (const entity of missing) {
      const key = removeEntity(entity.mapId, entity.agvKey)
      if (key !== null) {
        removed.push(key)
      }
    }
    return { added, updated, removed }
  }

  const applyEvent = (event: VehicleDataEvent): FleetDiff => {
    if (!isKnownEventShape(event)) {
      diagnostics.report(
        'FLEET_EVENT_REJECTED',
        'warn',
        '车队事件外壳非法，整条拒绝且不修改现有数据',
        { type: (event as { type?: unknown } | null)?.['type'] ?? null },
      )
      return EMPTY_DIFF
    }
    // receivedAt 缺失或非法时以运行时单调时钟兜底，保证实体时间戳恒为有限值
    const receivedAt = isFiniteNumber(event.receivedAt) ? event.receivedAt : fallbackNow()
    switch (event.type) {
      case 'snapshot':
        return applySnapshot(event, receivedAt)
      case 'update':
        // 增量只影响目标车，绝不隐式删除其他车辆（SPEC §3.2）
        return upsert(event.vehicle, receivedAt) === 'added'
          ? { added: [event.vehicle.entityKey], updated: [], removed: [] }
          : { added: [], updated: [event.vehicle.entityKey], removed: [] }
      case 'remove': {
        const removedKey = removeEntity(event.mapId, event.agvKey)
        return removedKey !== null
          ? { added: [], updated: [], removed: [removedKey] }
          : EMPTY_DIFF
      }
      case 'heartbeat':
        // 心跳只代表通道存活，不刷新任何单车新鲜度（数据沉默仍会 STALE）
        return EMPTY_DIFF
    }
  }

  const tick = (now: number): void => {
    for (const entity of entities.values()) {
      const next: VehicleFreshness =
        now - entity.lastReceivedAt >= staleAfterMs ? 'STALE' : 'FRESH'
      if (next === entity.freshness) {
        continue
      }
      entity.freshness = next
      entity.displayState = projectDisplayState(entity.staticState, next)
      dirtyDisplay.add(entity.key)
    }
  }

  // 全量脏标记：幂等（Set 去重），只覆盖存活实体——已删除实体不在表中，
  // 其 removed 差异只能由 applyEvent 产生，这里绝不伪造
  const markAllDirty = (): void => {
    for (const entity of entities.values()) {
      dirtyPose.add(entity.key)
      dirtyDisplay.add(entity.key)
    }
  }

  const consumeDirty = (): DirtyBatch => {
    const batch: DirtyBatch = {
      pose: [...dirtyPose],
      display: [...dirtyDisplay],
      removed: [...dirtyRemoved],
    }
    dirtyPose.clear()
    dirtyDisplay.clear()
    dirtyRemoved.clear()
    return batch
  }

  return {
    staleAfterMs,
    applyEvent,
    tick,
    markAllDirty,
    consumeDirty,
    get: (key) => entities.get(key),
    entities: () => [...entities.values()] as readonly ReadonlyFleetEntity[],
    get count(): number {
      return entities.size
    },
  }
}

/** 事件外壳纵深防御：类型已知、mapId 非空字符串、receivedAt 可用 */
function isKnownEventShape(
  event: VehicleDataEvent,
): event is SnapshotEvent | UpdateEvent | RemoveEvent | HeartbeatEvent {
  if (typeof event !== 'object' || event === null) {
    return false
  }
  const candidate = event as Partial<VehicleDataEvent>
  if (
    typeof candidate['type'] !== 'string' ||
    !KNOWN_EVENT_TYPES.has(candidate['type'])
  ) {
    return false
  }
  if (typeof candidate['mapId'] !== 'string' || candidate['mapId'].length === 0) {
    return false
  }
  // receivedAt 缺失时由运行时以单调时钟兜底（合同要求来源打点，此处宽容）
  if (candidate['receivedAt'] !== undefined && !isFiniteNumber(candidate['receivedAt'])) {
    return false
  }
  return true
}

/** 位姿签名：位置/朝向/尺寸/有效性任一变化都视为位姿变化 */
function poseSignature(snapshot: VehicleSnapshot): string {
  return [
    snapshot.position.x,
    snapshot.position.y,
    snapshot.position.theta,
    snapshot.positionValid ? 1 : 0,
    snapshot.dimension.length,
    snapshot.dimension.width,
    snapshot.dimension.loadLength,
    snapshot.dimension.loadWidth,
    snapshot.dimension.centerOffset,
    snapshot.dimensionValid ? 1 : 0,
  ].join(',')
}

/** 显示签名：主状态/副徽标/载荷/告警/电量/名称任一变化都视为显示变化 */
function displaySignature(
  snapshot: VehicleSnapshot,
  staticState: StaticVehicleState,
  displayState: VehicleDisplayState,
): string {
  return [
    displayState.primary,
    displayState.secondary,
    staticState.loadState,
    staticState.alerts.map((alert) => alert.type).join('+'),
    snapshot.battery.batteryCharge,
    snapshot.agvName,
  ].join('|')
}
