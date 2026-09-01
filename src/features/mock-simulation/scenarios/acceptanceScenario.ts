/**
 * 确定性验收场景时间线（SPEC §9.3「压力验收使用确定性场景脚本，保证所有
 * 事件在规定窗口内至少发生一次，不依赖随机概率碰巧命中」；TASK-009；E3）。
 *
 * 职责：声明一份固定的、循环执行的调度表——在 120s 仿真窗口内确定性地覆盖
 *       接单/完成、故障/恢复、掉线/恢复、暂停、交通等待、低定位置信度、
 *       删车与增车全部验收事件；数据源按仿真时钟调用 advance(simTime) 取走
 *       「新近到期」的指令并落实到上报状态与车队成员资格。
 * 边界：纯调度器——只产生指令，不接触内核、不发布事件、不解析地图；目标
 *       车辆用「全局建车序号」表达，序号到 agvKey 的换算与「车辆是否存在」
 *       的裁决归数据源层（序号可能超出小车队规模）。
 * 关键不变量：
 * 1. 确定性：调度表是模块级常量，advance 的产出只由 (simTime, 游标) 决定，
 *    同一推进序列必然产出同一指令序列（不消费任何随机源）；
 * 2. 单调游标：指令按表序恰好投递一次；时间倒退（simTime 变小）不重放；
 * 3. 循环覆盖：游标越过窗口末尾后从下一周期开头继续，长时运行周期性复现
 *    全部事件（删车/增车成对出现，车队规模在完整周期内守恒）；
 * 4. 事件开关关闭时数据源跳过 advance，游标停走——重新开启后只投递未来
 *    指令，绝不一次性补发停用期间积压的全部历史指令。
 */

/** 默认验收窗口（秒）：一个完整周期内覆盖全部验收事件 */
export const DEFAULT_ACCEPTANCE_WINDOW_SECONDS = 120

/**
 * 场景目标车辆的起始建车序号（mock-agv-0011 起）。
 * 取值说明：数据源默认让前 2 台初始电量低于寻充阈值以确定性触发充电，
 * 场景目标与之错开，保证「充电」与脚本事件在不同车辆上独立可见。
 */
export const ACCEPTANCE_TARGET_SERIAL_BASE = 11

/** 上报字段覆盖指令：field/value 由数据源翻译为车辆快照的原始字段 */
export type MockScenarioPatch =
  | { readonly field: 'order'; readonly value: 'assign' | 'complete' }
  | {
      readonly field: 'fault' | 'offline' | 'paused' | 'traffic' | 'lowLocalization'
      readonly value: 'on' | 'off'
    }

/** 场景指令：上报覆盖、删车（当前序号最大的在册车辆）或增车 */
export type MockScenarioDirective =
  | { readonly kind: 'patch'; readonly serial: number; readonly patch: MockScenarioPatch }
  | { readonly kind: 'remove' }
  | { readonly kind: 'add' }

/** 单条调度项：窗口内相对时刻 + 到期投递的指令 */
interface ScheduleItem {
  readonly atSeconds: number
  readonly directive: MockScenarioDirective
}

/**
 * 固定调度表（窗口内秒数；全部事件在前 80s 内发生，留出观察余量）：
 * 覆盖 SPEC §9.3 要求的接单/完成、故障/恢复、掉线/恢复、暂停/恢复、
 * 交通等待/解除、低定位/恢复与删车、增车。
 */
const SCHEDULE: readonly ScheduleItem[] = [
  { atSeconds: 2, directive: { kind: 'patch', serial: 11, patch: { field: 'order', value: 'assign' } } },
  { atSeconds: 8, directive: { kind: 'patch', serial: 12, patch: { field: 'fault', value: 'on' } } },
  { atSeconds: 14, directive: { kind: 'patch', serial: 13, patch: { field: 'offline', value: 'on' } } },
  { atSeconds: 20, directive: { kind: 'patch', serial: 14, patch: { field: 'paused', value: 'on' } } },
  { atSeconds: 26, directive: { kind: 'patch', serial: 15, patch: { field: 'traffic', value: 'on' } } },
  { atSeconds: 32, directive: { kind: 'patch', serial: 16, patch: { field: 'lowLocalization', value: 'on' } } },
  { atSeconds: 38, directive: { kind: 'patch', serial: 11, patch: { field: 'order', value: 'complete' } } },
  { atSeconds: 44, directive: { kind: 'patch', serial: 12, patch: { field: 'fault', value: 'off' } } },
  { atSeconds: 50, directive: { kind: 'patch', serial: 13, patch: { field: 'offline', value: 'off' } } },
  { atSeconds: 56, directive: { kind: 'patch', serial: 14, patch: { field: 'paused', value: 'off' } } },
  { atSeconds: 62, directive: { kind: 'patch', serial: 15, patch: { field: 'traffic', value: 'off' } } },
  { atSeconds: 68, directive: { kind: 'patch', serial: 16, patch: { field: 'lowLocalization', value: 'off' } } },
  { atSeconds: 74, directive: { kind: 'remove' } },
  { atSeconds: 80, directive: { kind: 'add' } },
]

export interface CreateAcceptanceScenarioOptions {
  /** 窗口时长（秒）；缺省 120 */
  windowSeconds?: number
}

export interface AcceptanceScenario {
  /** 窗口时长（秒） */
  readonly windowSeconds: number
  /**
   * 推进到 simTimeSeconds，返回按表序新近到期的指令（可能为空数组）。
   * 重复传入同一或更小的 simTime 不产生增量（单调游标）。
   */
  advance(simTimeSeconds: number): readonly MockScenarioDirective[]
  /** 游标归零：下一个窗口从头开始（配合仿真整体复位） */
  reset(): void
}

/** 创建确定性验收场景调度器（无随机源、无时钟依赖） */
export function createAcceptanceScenario(
  options: CreateAcceptanceScenarioOptions = {},
): AcceptanceScenario {
  const windowSeconds = options.windowSeconds ?? DEFAULT_ACCEPTANCE_WINDOW_SECONDS
  // 游标：当前周期序与周期内条目序；advance 只前进不回退（不变量 2）
  let cycle = 0
  let item = 0

  return {
    windowSeconds,
    advance(simTimeSeconds: number): readonly MockScenarioDirective[] {
      const due: MockScenarioDirective[] = []
      for (;;) {
        const entry = SCHEDULE[item]
        const dueAt = cycle * windowSeconds + entry.atSeconds
        if (dueAt > simTimeSeconds) {
          break
        }
        due.push(entry.directive)
        item += 1
        if (item >= SCHEDULE.length) {
          item = 0
          cycle += 1
        }
      }
      return due
    },
    reset(): void {
      cycle = 0
      item = 0
    },
  }
}
