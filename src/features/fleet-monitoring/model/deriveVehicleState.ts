/**
 * 正交状态与告警派生（SPEC §2.4、§2.6、§7.3、§11.3、§11.8；TASK-006）。
 *
 * 职责：从不可变 VehicleSnapshot 派生互不丢失信息的静态维度——
 *       connectivity（严格映射，未知枚举归 UNKNOWN）、operation（固定优先级
 *       链：FAULT → PAUSED → CHARGING → TRAFFIC_WAIT → EXECUTING → IDLE →
 *       UNKNOWN）、loadState、alerts（允许多告警并存），以及把静态维度与
 *       freshness 合成为 primaryDisplayState/secondary 副徽标的投影函数。
 * 边界：纯函数，无时钟、无副作用；freshness 不在本模块计算（属运行时的
 *       单调时钟职责），投影函数只消费已算好的 freshness。
 * 关键不变量：
 * 1. operation 优先级顺序固定且短路：更高优先级条件成立时不再考察后续条件
 *    （SPEC §2.6 判定顺序），表驱动测试锁定 FAULT+OFFLINE、TRAFFIC+PROCESSING、
 *    PAUSED+CHARGING 等组合的唯一结果；
 * 2. 未知枚举绝不归入已知值：connectionState 非 'ONLINE'/'OFFLINE' 一律
 *    UNKNOWN，无法识别的状态组合 operation=UNKNOWN（不猜测为 IDLE）；
 * 3. 告警阈值边界：CRITICAL_BATTERY < 15 ≤ LOW_BATTERY < 30 ≤ 无电量告警；
 *    LOW_LOCALIZATION < 0.5；缺失值（null）不产生告警也不伪装正常；
 * 4. 投影顺序固定：STALE 冻结 > OFFLINE/UNKNOWN 连接断连灰 > FRESH 业务色；
 *    副徽标只在 STALE/断连时保留最后已知业务状态，业务状态本身 UNKNOWN 时
 *    副徽标为 null（不把「未知」当业务徽标展示）；
 * 5. 交通四边形无效完整传播：所属车任一 locked/applying 矩形无法形成有效
 *    凸四边形时增加 INVALID_DATA（SPEC §5.3 第 5 步），有效矩形不产生告警。
 */
import { trafficHasInvalidRectangle } from './trafficRectangle'
import type {
  StaticVehicleState,
  VehicleAlert,
  VehicleConnectivity,
  VehicleDisplayState,
  VehicleFreshness,
  VehicleLoadState,
  VehicleOperation,
  VehicleSnapshot,
} from './types'

/** L1 电量告警下限（含）；低于它升级为 CRITICAL（SPEC §7.3） */
export const LOW_BATTERY_THRESHOLD = 15
/** 电量告警上限（不含）：[15, 30) 为 LOW，≥30 无告警 */
export const BATTERY_NORMAL_THRESHOLD = 30
/** 低定位置信度阈值（不含）：localizationScore < 0.5 为 LOW_LOCALIZATION */
export const LOW_LOCALIZATION_THRESHOLD = 0.5

/** 已知的空闲过程状态集合：满足「已知空闲组合」判定（SPEC §2.6 第 6 步） */
const KNOWN_IDLE_PROC_STATUS: ReadonlySet<string> = new Set(['IDLE'])

/**
 * 从快照派生静态正交维度。freshness 相关表达由 projectDisplayState 与运行时
 * 配合完成，本函数结果对同一快照永远一致（纯函数）。
 */
export function deriveVehicleState(snapshot: VehicleSnapshot): StaticVehicleState {
  return Object.freeze({
    connectivity: deriveConnectivity(snapshot.connectionState),
    operation: deriveOperation(snapshot),
    loadState: deriveLoadState(snapshot.loaded),
    alerts: deriveAlerts(snapshot),
  })
}

/** connectivity 严格映射：未知枚举/缺失一律 UNKNOWN，绝不归为已知值 */
function deriveConnectivity(raw: string | null): VehicleConnectivity {
  if (raw === 'ONLINE') {
    return 'ONLINE'
  }
  if (raw === 'OFFLINE') {
    return 'OFFLINE'
  }
  return 'UNKNOWN'
}

/**
 * operation 按固定优先级短路判定（SPEC §2.6 判定顺序 1～7）：
 * 故障 > 暂停 > 充电 > 交通等待 > 执行订单 > 已知空闲 > 无法识别。
 * vehicleProcStatus 的已知枚举按调度系统协议语义映射（PROCESSING=执行任务、
 * CHARGE=充电任务；线上推送的车辆负载不带 orderState，执行中判定以过程
 * 状态为准）。
 */
function deriveOperation(snapshot: VehicleSnapshot): VehicleOperation {
  if (snapshot.rawErrorEntries.length > 0) {
    return 'FAULT'
  }
  if (snapshot.paused) {
    return 'PAUSED'
  }
  if (snapshot.battery.charging || snapshot.vehicleProcStatus === 'CHARGE') {
    return 'CHARGING'
  }
  if (snapshot.vehicleProcStatus === 'TRAFFIC') {
    return 'TRAFFIC_WAIT'
  }
  if (
    snapshot.orderState === 'PROCESSING' ||
    snapshot.vehicleProcStatus === 'PROCESSING'
  ) {
    return 'EXECUTING'
  }
  if (
    snapshot.vehicleProcStatus !== null &&
    KNOWN_IDLE_PROC_STATUS.has(snapshot.vehicleProcStatus)
  ) {
    return 'IDLE'
  }
  return 'UNKNOWN'
}

function deriveLoadState(loaded: boolean | null): VehicleLoadState {
  if (loaded === true) {
    return 'LOADED'
  }
  if (loaded === false) {
    return 'EMPTY'
  }
  return 'UNKNOWN'
}

/** 多告警并存：电量、定位、数据有效性与交通四边形四类互不排斥，按稳定顺序输出 */
function deriveAlerts(snapshot: VehicleSnapshot): readonly VehicleAlert[] {
  const alerts: VehicleAlert[] = []
  const charge = snapshot.battery.batteryCharge
  if (charge !== null) {
    if (charge < LOW_BATTERY_THRESHOLD) {
      alerts.push({ type: 'CRITICAL_BATTERY' })
    } else if (charge < BATTERY_NORMAL_THRESHOLD) {
      alerts.push({ type: 'LOW_BATTERY' })
    }
  }
  const score = snapshot.position.localizationScore
  if (score !== null && score < LOW_LOCALIZATION_THRESHOLD) {
    alerts.push({ type: 'LOW_LOCALIZATION' })
  }
  if (
    !snapshot.positionValid ||
    !snapshot.dimensionValid ||
    // 无效交通矩形逐项跳过渲染，同时给所属车传播 INVALID_DATA（SPEC §5.3）
    trafficHasInvalidRectangle(snapshot.trafficShapeResources)
  ) {
    alerts.push({ type: 'INVALID_DATA' })
  }
  return Object.freeze(alerts)
}

/**
 * 主状态显示投影（SPEC §2.6 投影顺序）：
 * 1. STALE：主状态为冻结灰，最后已知业务状态保留为副徽标；
 * 2. OFFLINE 或 UNKNOWN 连接：主状态为深灰，副徽标规则同上；
 * 3. FRESH 且 ONLINE：主状态为 operation 本身，无副徽标。
 */
export function projectDisplayState(
  state: StaticVehicleState,
  freshness: VehicleFreshness,
): VehicleDisplayState {
  if (freshness === 'STALE') {
    return Object.freeze({ primary: 'STALE', secondary: toSecondary(state.operation) })
  }
  if (state.connectivity !== 'ONLINE') {
    return Object.freeze({
      primary: 'DISCONNECTED',
      secondary: toSecondary(state.operation),
    })
  }
  return Object.freeze({ primary: state.operation, secondary: null })
}

/** 业务状态 UNKNOWN 不作为副徽标（无「最后已知」信息可言） */
function toSecondary(operation: VehicleOperation): VehicleOperation | null {
  return operation === 'UNKNOWN' ? null : operation
}
