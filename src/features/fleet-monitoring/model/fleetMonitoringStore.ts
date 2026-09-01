/**
 * 低频车队监控 Store（SPEC §4、§11.6、§12.5；TASK-006）。
 *
 * 职责：以独立 zustand store 持有 fleet-monitoring 的低频交互状态——车辆
 *       选中键与活跃告警实体键集合；选中车辆被删除时立即清除选中。
 *       高频快照、实体表、脏槽位一律不进入本 store（它们由 createFleetRuntime
 *       的普通 Map 持有）；组件经窄 selector 订阅单个字段，禁止整店订阅。
 * 边界：只服务选中与告警键集合两类低频状态；不持有车辆位置/姿态/电量等
 *       高频数据，也不提供任何派生查询（渲染层从运行时只读视图取数）。
 *       本 store 不被其他 Feature 导入（跨 Feature 协作由 app 组合层完成）。
 * 关键不变量：
 * 1. 告警键集合按内容幂等：与当前集合等价的新集合不触发任何通知，避免高
 *    频事件流在无实质变化时骚扰低频订阅者；
 * 2. 选中键是实体键 (mapId, agvKey)：选中车辆被移除时选中立即清空，不保留
 *    详情快照（SPEC §11.6）；
 * 3. 所有写入口都是命令式动作（select/setActiveAlertKeys/notifyRemoved），
 *    渲染层用 selector 只读订阅，状态变更频率与数据事件频率解耦。
 */
import { create } from 'zustand'

export interface FleetMonitoringState {
  /** 当前选中车辆的实体键；null 表示无选中 */
  selectedKey: string | null
  /** 选中指定车辆；传 null 取消选中（幂等） */
  select: (key: string | null) => void
  /** 存在活跃 L1/L2 告警的实体键集合（内容幂等更新） */
  activeAlertKeys: ReadonlySet<string>
  /** 以内容对比更新告警键集合；等价集合为 no-op */
  setActiveAlertKeys: (keys: ReadonlySet<string>) => void
  /** 通知实体已删除：清除选中（若被删）；告警集合由调用方整体重算 */
  notifyEntitiesRemoved: (keys: readonly string[]) => void
}

/** 比较两个键集合内容是否等价（无序） */
function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) {
    return true
  }
  if (a.size !== b.size) {
    return false
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false
    }
  }
  return true
}

export const useFleetMonitoringStore = create<FleetMonitoringState>((set, get) => ({
  selectedKey: null,
  select: (key) => {
    if (get().selectedKey !== key) {
      set({ selectedKey: key })
    }
  },
  activeAlertKeys: new Set<string>(),
  setActiveAlertKeys: (keys) => {
    // 内容幂等：高频事件流中告警无实质变化时不触发低频订阅者
    if (!setsEqual(get().activeAlertKeys, keys)) {
      set({ activeAlertKeys: new Set(keys) })
    }
  },
  notifyEntitiesRemoved: (keys) => {
    const { selectedKey } = get()
    if (selectedKey !== null && keys.includes(selectedKey)) {
      set({ selectedKey: null })
    }
  },
}))
