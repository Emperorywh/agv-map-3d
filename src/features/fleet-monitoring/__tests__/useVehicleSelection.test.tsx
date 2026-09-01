/*
 * 车辆选择交互测试（TASK-012 / SPEC §7.3、§8、§11.6）。
 *
 * 职责：验证 useVehicleSelection 的事件语义——外壳拾取到实体键、Esc/空白
 *       取消、拖拽与非主指针抑制、双击仅上抛跟随请求、监听器对称清理，以及
 *       Provider 删除差异 → 车辆删除立即清理选中的整条接线。
 */
import { act, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StrictMode } from 'react'
import type { ThreeEvent } from '@react-three/fiber'
import { createVehicleEntityKey } from '../model/types'
import { createInstanceSlotTable, type InstanceSlotTable } from '../model/instanceSlots'
import { useFleetMonitoringStore } from '../model/fleetMonitoringStore'
import { useVehicleSelection } from '../hooks/useVehicleSelection'
import { FleetRuntimeProvider } from '../components/FleetRuntimeProvider'
import { useFleetRuntime } from '../hooks/FleetRuntimeContext'
import type { SourceStatus, Unsubscribe, VehicleDataEvent, VehicleDataSource } from '../data-source/contract'
import { removeEvent, snapshotOf } from './testVehicles'

const MAP = 'map-under-test'

function makeTableWithEntity(key: string): InstanceSlotTable {
  const table = createInstanceSlotTable()
  table.acquire(key)
  return table
}

/** 构造命中外壳的 R3F 事件形态（本 Hook 只消费这几个字段）。
 *  交叉类型使其可同时传给 onPointerDown（PointerEvent 形参）与
 *  onClick/onDoubleClick（MouseEvent 形参）。 */
function shellClickEvent(options: {
  batchId?: number
  instanceId?: number
  clientX?: number
  clientY?: number
  pointerType?: string
  isPrimary?: boolean
}): ThreeEvent<PointerEvent> & ThreeEvent<MouseEvent> {
  const nativeEvent = {
    clientX: options.clientX ?? 10,
    clientY: options.clientY ?? 10,
    pointerType: options.pointerType,
    isPrimary: options.isPrimary,
  }
  const event = {
    instanceId: options.instanceId ?? 0,
    object: { userData: { batchId: options.batchId ?? 0 } },
    nativeEvent,
  }
  return event as unknown as ThreeEvent<PointerEvent> & ThreeEvent<MouseEvent>
}

function missedEvent(clientX = 10, clientY = 10) {
  return { clientX, clientY } as MouseEvent
}

const pendingUnmounts: Array<() => void> = []

beforeEach(() => {
  useFleetMonitoringStore.setState({ selectedKey: null, activeAlertKeys: new Set() })
})

afterEach(() => {
  // 本项目未开启 vitest globals，RTL 自动清理不生效：显式卸载，保证
  // Esc 监听器不跨用例泄漏（正是被测行为本身）
  for (const unmount of pendingUnmounts.splice(0)) {
    unmount()
  }
  useFleetMonitoringStore.setState({ selectedKey: null, activeAlertKeys: new Set() })
})

describe('useVehicleSelection（TASK-012）', () => {
  it('单击外壳：(batchId, instanceId) 经槽位表解析为实体键并选中', () => {
    const key = createVehicleEntityKey(MAP, 'v1')
    const table = makeTableWithEntity(key)
    const { result, unmount } = renderHook(() => useVehicleSelection({ table }))
    pendingUnmounts.push(unmount)
    act(() => {
      result.current.onPointerDown(shellClickEvent({}))
      result.current.onClick(shellClickEvent({}))
    })
    expect(useFleetMonitoringStore.getState().selectedKey).toBe(key)
  })

  it('点击空白（pointerMissed）取消选中', () => {
    const key = createVehicleEntityKey(MAP, 'v1')
    const table = makeTableWithEntity(key)
    const { result, unmount } = renderHook(() => useVehicleSelection({ table }))
    pendingUnmounts.push(unmount)
    act(() => {
      result.current.onPointerDown(shellClickEvent({}))
      result.current.onClick(shellClickEvent({}))
      result.current.onPointerMissed(missedEvent())
    })
    expect(useFleetMonitoringStore.getState().selectedKey).toBeNull()
  })

  it('Esc 键取消选中；卸载后监听对称移除', () => {
    const key = createVehicleEntityKey(MAP, 'v1')
    const table = makeTableWithEntity(key)
    const { result, unmount } = renderHook(() => useVehicleSelection({ table }))
    act(() => {
      result.current.onPointerDown(shellClickEvent({}))
      result.current.onClick(shellClickEvent({}))
    })
    expect(useFleetMonitoringStore.getState().selectedKey).toBe(key)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(useFleetMonitoringStore.getState().selectedKey).toBeNull()

    // 卸载后：Esc 不再触达监听器（选中状态保持由外部设置值）
    unmount()
    useFleetMonitoringStore.setState({ selectedKey: key })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(useFleetMonitoringStore.getState().selectedKey).toBe(key)
  })

  it('拖拽抑制：按下后位移超过阈值的 click/missed 均不改变选中', () => {
    const key = createVehicleEntityKey(MAP, 'v1')
    const table = makeTableWithEntity(key)
    const { result, unmount } = renderHook(() => useVehicleSelection({ table }))
    pendingUnmounts.push(unmount)
    act(() => {
      // 选中基线
      result.current.onPointerDown(shellClickEvent({ clientX: 0, clientY: 0 }))
      result.current.onClick(shellClickEvent({ clientX: 0, clientY: 0 }))
    })
    expect(useFleetMonitoringStore.getState().selectedKey).toBe(key)
    act(() => {
      // 拖拽（位移 50px > 6px）：点击另一外壳不选中、missed 不取消
      result.current.onPointerDown(shellClickEvent({ clientX: 50, clientY: 50 }))
      result.current.onClick(shellClickEvent({ clientX: 200, clientY: 200 }))
      result.current.onPointerMissed(missedEvent(200, 200))
    })
    expect(useFleetMonitoringStore.getState().selectedKey).toBe(key)
  })

  it('非主指针 / 非鼠标指针被忽略（SPEC §8 只接受主鼠标指针）', () => {
    const key = createVehicleEntityKey(MAP, 'v1')
    const table = makeTableWithEntity(key)
    const { result, unmount } = renderHook(() => useVehicleSelection({ table }))
    pendingUnmounts.push(unmount)
    act(() => {
      result.current.onPointerDown(
        shellClickEvent({ clientX: 0, clientY: 0, isPrimary: false }),
      )
      result.current.onClick(shellClickEvent({ clientX: 0, clientY: 0, isPrimary: false }))
      result.current.onPointerDown(
        shellClickEvent({ clientX: 0, clientY: 0, pointerType: 'touch' }),
      )
      result.current.onClick(shellClickEvent({ clientX: 0, clientY: 0, pointerType: 'touch' }))
    })
    expect(useFleetMonitoringStore.getState().selectedKey).toBeNull()
  })

  it('双击仅上抛跟随请求（不改选中、不移动相机）；无回调时安全 no-op', () => {
    const key = createVehicleEntityKey(MAP, 'v1')
    const table = makeTableWithEntity(key)
    const followRequests: string[] = []
    const { result, unmount } = renderHook(() =>
      useVehicleSelection({ table, onFollowRequest: (k) => followRequests.push(k) }),
    )
    pendingUnmounts.push(unmount)
    act(() => {
      result.current.onDoubleClick(shellClickEvent({}))
    })
    expect(followRequests).toEqual([key])
    expect(useFleetMonitoringStore.getState().selectedKey).toBeNull()

    // 无回调：不抛出
    const bare = renderHook(() => useVehicleSelection({ table }))
    pendingUnmounts.push(bare.unmount)
    expect(() => {
      act(() => {
        bare.result.current.onDoubleClick(shellClickEvent({}))
      })
    }).not.toThrow()
  })

  it('槽位未命中（复用/超限）时忽略点击，不误选', () => {
    const table = createInstanceSlotTable()
    const { result, unmount } = renderHook(() => useVehicleSelection({ table }))
    pendingUnmounts.push(unmount)
    act(() => {
      result.current.onPointerDown(shellClickEvent({ batchId: 3, instanceId: 999 }))
      result.current.onClick(shellClickEvent({ batchId: 3, instanceId: 999 }))
    })
    expect(useFleetMonitoringStore.getState().selectedKey).toBeNull()
  })
})

/** 事件可注入的最小 fake 数据源（仅服务删除清理接线验证） */
function makeFakeSource() {
  const listeners = new Set<(event: VehicleDataEvent) => void>()
  const statusListeners = new Set<(status: SourceStatus) => void>()
  const source: VehicleDataSource = {
    connect: () => Promise.resolve(),
    disconnect: () => {},
    requestSnapshot: () => {},
    get status(): SourceStatus {
      return 'OPEN'
    },
    onEvent(cb): Unsubscribe {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    onStatusChange(cb): Unsubscribe {
      statusListeners.add(cb)
      return () => statusListeners.delete(cb)
    },
  }
  return {
    source,
    emit(event: VehicleDataEvent): void {
      for (const listener of listeners) {
        listener(event)
      }
    },
  }
}

describe('车辆删除立即清理选中（Provider 删除差异转发，SPEC §11.6）', () => {
  it('remove 事件经 Provider 转发为 notifyEntitiesRemoved，被删车的选中同帧清空', async () => {
    const { source, emit } = makeFakeSource()
    const key = createVehicleEntityKey(MAP, 'v1')
    const snapshot = snapshotOf({ agvKey: 'v1' }, MAP)

    function Probe(): null {
      useFleetRuntime()
      return null
    }
    const { unmount } = render(
      <StrictMode>
        <FleetRuntimeProvider source={source}>
          <Probe />
        </FleetRuntimeProvider>
      </StrictMode>,
    )
    try {
      act(() => {
        useFleetMonitoringStore.getState().select(key)
      })
      expect(useFleetMonitoringStore.getState().selectedKey).toBe(key)

      // 全量快照建立基线，随后 remove 该车
      act(() => {
        emit({
          type: 'snapshot',
          schemaVersion: 'test/1',
          mapId: MAP,
          sequence: 1,
          receivedAt: 1_000,
          vehicles: [snapshot],
        })
        emit({
          type: 'remove',
          schemaVersion: 'test/1',
          mapId: MAP,
          sequence: 2,
          receivedAt: 2_000,
          agvKey: 'v1',
        })
      })
      expect(useFleetMonitoringStore.getState().selectedKey).toBeNull()
      expect(useFleetMonitoringStore.getState().select).toBeDefined()
      expect(removeEvent(MAP, 'v1', 2_000).agvKey).toBe('v1')
    } finally {
      unmount()
    }
  })

  it('删除其他车辆不影响当前选中', async () => {
    const { source, emit } = makeFakeSource()
    const keptKey = createVehicleEntityKey(MAP, 'keep')
    const snapshot = snapshotOf({ agvKey: 'keep' }, MAP)
    const other = snapshotOf({ agvKey: 'other' }, MAP)

    function Probe(): null {
      useFleetRuntime()
      return null
    }
    const { unmount } = render(
      <FleetRuntimeProvider source={source}>
        <Probe />
      </FleetRuntimeProvider>,
    )
    try {
      act(() => {
        emit({
          type: 'snapshot',
          schemaVersion: 'test/1',
          mapId: MAP,
          sequence: 1,
          receivedAt: 1_000,
          vehicles: [snapshot, other],
        })
        useFleetMonitoringStore.getState().select(keptKey)
        emit({
          type: 'remove',
          schemaVersion: 'test/1',
          mapId: MAP,
          sequence: 2,
          receivedAt: 2_000,
          agvKey: 'other',
        })
      })
      expect(useFleetMonitoringStore.getState().selectedKey).toBe(keptKey)
    } finally {
      unmount()
    }
  })
})
