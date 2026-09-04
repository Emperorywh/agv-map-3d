/**
 * 车辆标签 LOD 与重点标签纯函数（SPEC §6.4、§7.2、§7.3；TASK-011）。
 *
 * 职责：提供标签显示决策的全部纯函数——
 * 1. labelLevelForPixels：按车体投影长度给出内容档位（0 隐藏 / 1 仅名称 /
 *    2 名称 + 电量条 + 状态芯片），阈值来自 fleetAppearance（8px/20px）；
 * 2. labelImportanceRank：重点车优先级（选中 > FAULT > STALE > OFFLINE >
 *    严重低电量 > 低定位），供远景 20 个重点标签的截断排序；
 * 3. labelAlertLevel：标签边框告警级（0 无 / 1 L1 黄 / 2 L2 红），与 §7.3
 *    告警表同口径；
 * 4. labelChipOf：状态芯片文本取值——FRESH 显示业务主状态，STALE/断连保留
 *    最后已知业务状态副徽标，UNKNOWN 不作为徽标展示。
 * 边界：纯函数、无 THREE/React/时钟依赖，全部输入来自运行时只读实体或渲染
 *       层计算结果；排序与截断不产生迭代器分配（数组原地比较）。
 * 关键不变量：
 * 1. 档位边界含下限：投影恰为 8px 时显示名称、恰为 20px 时显示完整内容；
 *    非有限投影长度一律 0（不显示），绝不以 NaN 进入比较；
 * 2. 优先级次序固定且取最小秩：多条件并存时以最高优先级条件为准；
 * 3. 告警级 L2 优先于 L1：同时存在 L1 与 L2 条件时报 L2（红色外环语义）；
 * 4. 重点截断稳定：按（秩, 扁平槽位号）升序保留前 max 个，逐帧结果可复现。
 */
import type { VehicleAlert, VehicleOperation, VehiclePrimaryDisplayState } from '../model/types'
import { LABEL_FULL_MIN_PX, LABEL_NAME_MIN_PX } from './fleetAppearance'

/** 标签内容档位：0 隐藏、1 仅名称、2 名称 + 电量条 + 状态芯片 */
export type LabelLevel = 0 | 1 | 2

/** 按投影长度取内容档位；非有限值一律隐藏（纵深防御） */
export function labelLevelForPixels(projectedPx: number): LabelLevel {
  if (!Number.isFinite(projectedPx) || projectedPx < LABEL_NAME_MIN_PX) {
    return 0
  }
  if (projectedPx < LABEL_FULL_MIN_PX) {
    return 1
  }
  return 2
}

/** labelImportanceRank 的输入（全部来自运行时只读实体） */
export interface LabelImportanceInput {
  /** 是否为当前选中车辆（实体键匹配） */
  readonly selected: boolean
  readonly primary: VehiclePrimaryDisplayState
  readonly alerts: readonly VehicleAlert[]
}

/**
 * 重点车优先级秩（越小越优先）：选中 0、FAULT 1、STALE 2、断连（OFFLINE/
 * UNKNOWN）3、严重低电量 4、低定位 5；非重点返回 null。
 */
export function labelImportanceRank(input: LabelImportanceInput): number | null {
  if (input.selected) {
    return 0
  }
  if (input.primary === 'FAULT') {
    return 1
  }
  if (input.primary === 'STALE') {
    return 2
  }
  /**
   * 连接中断与离线采用相同的标签优先级。
   * 主状态颜色继续分别表达，不将中断当作普通在线车辆过滤。
   */
  if (input.primary === 'DISCONNECTED' || input.primary === 'CONNECTION_BROKEN') {
    return 3
  }
  for (const alert of input.alerts) {
    if (alert.type === 'CRITICAL_BATTERY') {
      return 4
    }
  }
  for (const alert of input.alerts) {
    if (alert.type === 'LOW_LOCALIZATION') {
      return 5
    }
  }
  /**
   * 普通标签隐藏后，其他现有告警也需要进入持续提示候选集合。
   * 这里只决定视觉优先级，不删除或改写告警数据。
   */
  if (input.alerts.length > 0) return 6
  return null
}

/**
 * 总览档重点标签白名单（视觉差距分析 P1-12/7.3）：投影 < 8px 的总览距离下，
 * 只保留秩 ≤ 该值的重点车（选中 + FAULT，即秩 0/1）——总览画面的芯片数量
 * 从「所有重点」收敛到「告警本体」，STALE/断连/低电量车只在近中景显示标签。
 * 该秩体系同时仍是远景截断（capImportantLabels）的优先级排序依据。
 */
export const FAR_IMPORTANT_MAX_RANK = 1

/** 总览档重点准入判定：秩非空且在白名单内（类型谓词收窄非空秩） */
export function isFarImportantRank(rank: number | null): rank is number {
  return rank !== null && rank <= FAR_IMPORTANT_MAX_RANK
}

/**
 * 标签边框告警级（SPEC §7.3）：L2 红含 FAULT/STALE/OFFLINE（断连投影）、
 * CRITICAL_BATTERY 与 INVALID_DATA；L1 黄含 LOW_BATTERY 与 LOW_LOCALIZATION；
 * L2 优先于 L1。连接中断同样属于断连告警，多告警并存时不丢失最高级。
 */
export function labelAlertLevel(
  primary: VehiclePrimaryDisplayState,
  alerts: readonly VehicleAlert[],
): 0 | 1 | 2 {
  if (
    primary === 'FAULT' ||
    primary === 'STALE' ||
    primary === 'DISCONNECTED' ||
    primary === 'CONNECTION_BROKEN'
  ) {
    return 2
  }
  let level: 0 | 1 | 2 = 0
  for (const alert of alerts) {
    if (alert.type === 'CRITICAL_BATTERY' || alert.type === 'INVALID_DATA') {
      return 2
    }
    if (alert.type === 'LOW_BATTERY' || alert.type === 'LOW_LOCALIZATION') {
      level = 1
    }
  }
  return level
}

/**
 * 状态芯片文本取值：FRESH 显示业务主状态；STALE/断连显示最后已知业务状态
 * （副徽标）；连接中断沿用同一规则，UNKNOWN 返回 null 隐藏芯片。
 */
export function labelChipOf(
  primary: VehiclePrimaryDisplayState,
  secondary: VehicleOperation | null,
): VehicleOperation | null {
  if (primary === 'STALE' || primary === 'DISCONNECTED' || primary === 'CONNECTION_BROKEN') {
    return secondary
  }
  return primary === 'UNKNOWN' ? null : primary
}

/** 一个远景重点标签候选：扁平槽位号 + 优先级秩（帧同步层组装） */
export interface ImportantLabelEntry {
  readonly flatSlot: number
  readonly rank: number
}

/**
 * 远景重点标签截断：按（秩, 扁平槽位号）升序保留前 max 个，返回入选的扁平
 * 槽位号集合。输入数量不超过上限时返回 null（无需截断，避免逐帧分配）。
 */
export function capImportantLabels(
  entries: readonly ImportantLabelEntry[],
  max: number,
): Set<number> | null {
  if (entries.length <= max) {
    return null
  }
  // 秩与槽位号均为小整数：打包为单数值排序（稳定、零对象分配）
  const packed = entries
    .map((entry) => entry.rank * 4096 + entry.flatSlot)
    .sort((a, b) => a - b)
  const kept = new Set<number>()
  for (let i = 0; i < max; i += 1) {
    kept.add(packed[i] % 4096)
  }
  return kept
}
