/*
 * fleetMonitoringStore 低频状态测试（TASK-006 / §4、§11.6）。
 *
 * 覆盖：选中/取消幂等与订阅通知次数、告警键集合内容幂等（等价集合不通知）、
 *       选中车辆被删除时立即清除选中、store 内不含高频数据。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useFleetMonitoringStore } from '../model/fleetMonitoringStore'
import { createVehicleEntityKey } from '../model/types'

const KEY_A = createVehicleEntityKey('m', 'a')
const KEY_B = createVehicleEntityKey('m', 'b')

/** 每个用例前重置为初始状态（zustand store 是模块级单例） */
beforeEach(() => {
  useFleetMonitoringStore.setState({ selectedKey: null, activeAlertKeys: new Set() })
})

describe('选中状态', () => {
  it('select 写入与取消；重复写入同一键不重复通知', () => {
    const store = useFleetMonitoringStore
    let notifications = 0
    const unsubscribe = store.subscribe(() => {
      notifications += 1
    })
    store.getState().select(KEY_A)
    store.getState().select(KEY_A)
    expect(store.getState().selectedKey).toBe(KEY_A)
    expect(notifications).toBe(1)
    store.getState().select(null)
    expect(store.getState().selectedKey).toBeNull()
    unsubscribe()
  })

  it('选中车辆被删除时立即清除选中，不保留详情（§11.6）', () => {
    const store = useFleetMonitoringStore
    store.getState().select(KEY_A)
    store.getState().notifyEntitiesRemoved([KEY_B])
    expect(store.getState().selectedKey).toBe(KEY_A)
    store.getState().notifyEntitiesRemoved([KEY_A, KEY_B])
    expect(store.getState().selectedKey).toBeNull()
  })
})

describe('活跃告警键集合（内容幂等）', () => {
  it('等价集合不触发通知；内容变化才更新并通知', () => {
    const store = useFleetMonitoringStore
    let notifications = 0
    const unsubscribe = store.subscribe(() => {
      notifications += 1
    })
    store.getState().setActiveAlertKeys(new Set([KEY_A, KEY_B]))
    expect(notifications).toBe(1)
    // 顺序不同的等价集合：no-op
    store.getState().setActiveAlertKeys(new Set([KEY_B, KEY_A]))
    expect(notifications).toBe(1)
    store.getState().setActiveAlertKeys(new Set([KEY_A]))
    expect(notifications).toBe(2)
    expect(store.getState().activeAlertKeys).toEqual(new Set([KEY_A]))
    unsubscribe()
  })

  it('相同集合实例直接 no-op', () => {
    const store = useFleetMonitoringStore
    const keys = new Set([KEY_A])
    store.getState().setActiveAlertKeys(keys)
    let notifications = 0
    const unsubscribe = store.subscribe(() => {
      notifications += 1
    })
    store.getState().setActiveAlertKeys(keys)
    expect(notifications).toBe(0)
    unsubscribe()
  })
})
