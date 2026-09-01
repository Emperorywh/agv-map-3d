/*
 * useVehicleDataSource React 生命周期测试（TASK-007 / SPEC §3.1、§4、§12.5；F4、F5）。
 *
 * 覆盖：挂载连接/卸载断开的对称性、StrictMode 双执行收敛（任意时刻至多一条
 *       活跃连接、事件只应用一次）、高频事件只进运行时不进 React、1Hz ticker
 *       驱动 freshness 跃迁、快速 source 切换的隔离、source=null 稳态、options
 *       引用不稳定不重建连接、卸载竞态（pending connect 被取消且无异常外泄）。
 */
import { StrictMode } from 'react'
import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import {
  createFleetRuntime,
  type FleetRuntime,
} from '../model/createFleetRuntime'
import {
  useVehicleDataSource,
  type UseVehicleDataSourceOptions,
} from '../hooks/useVehicleDataSource'
import type {
  SourceStatus,
  Unsubscribe,
  VehicleDataEvent,
  VehicleDataSource,
} from '../data-source/contract'
import {
  heartbeatEvent,
  makeRawVehicle,
  snapshotEvent,
  snapshotOf,
} from './testVehicles'

const MAP = 'map-under-test'

/** freshness ticker 周期（与实现常量一致） */
const TICK_MS = 1_000

/** 可变 source 引用：模拟 App 侧数据源在重渲染间变化 */
class VehicleSourceRef {
  current: VehicleDataSource | null
  constructor(current: VehicleDataSource | null) {
    this.current = current
  }
}

/** 计数型假数据源：记录 connect/disconnect 次数与并发活跃连接峰值 */
class FakeSource implements VehicleDataSource {
  connectCount = 0
  disconnectCount = 0
  active = 0
  maxActive = 0
  /** connect 返回的 promise 由测试控制（默认立即兑现） */
  pendingConnect: Promise<void> | null = null
  private readonly eventCbs = new Set<(event: VehicleDataEvent) => void>()
  private readonly statusCbs = new Set<(status: SourceStatus) => void>()
  lastSignal: AbortSignal | null = null

  connect(signal?: AbortSignal): Promise<void> {
    this.connectCount += 1
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    this.lastSignal = signal ?? null
    return this.pendingConnect ?? Promise.resolve()
  }

  disconnect(): void {
    this.disconnectCount += 1
    this.active = Math.max(0, this.active - 1)
  }

  requestSnapshot(): void {}

  get status(): SourceStatus {
    return 'IDLE'
  }

  onEvent(cb: (event: VehicleDataEvent) => void): Unsubscribe {
    this.eventCbs.add(cb)
    return () => {
      this.eventCbs.delete(cb)
    }
  }

  onStatusChange(cb: (status: SourceStatus) => void): Unsubscribe {
    this.statusCbs.add(cb)
    return () => {
      this.statusCbs.delete(cb)
    }
  }

  emit(event: VehicleDataEvent): void {
    for (const cb of [...this.eventCbs]) {
      cb(event)
    }
  }
}

function makeSnapshotPayload(agvKey = 'agv-001') {
  return snapshotOf(makeRawVehicle({ agvKey }), MAP)
}

/** 挂载被测 Hook 的最小 Harness（经 render 触发真实 StrictMode 双执行语义） */
function Harness({
  source,
  runtime,
  options,
}: {
  source: VehicleDataSource | null
  runtime: FleetRuntime
  options: UseVehicleDataSourceOptions
}) {
  useVehicleDataSource(source, runtime, options)
  return null
}

function harnessTree(
  source: VehicleDataSource | null,
  runtime: FleetRuntime,
  options: UseVehicleDataSourceOptions,
): ReactNode {
  return (
    <StrictMode>
      <Harness source={source} runtime={runtime} options={options} />
    </StrictMode>
  )
}

function renderDataHook(
  source: VehicleSourceRef,
  runtime: FleetRuntime,
  options: UseVehicleDataSourceOptions = {},
) {
  return render(harnessTree(source.current, runtime, options))
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('连接生命周期（F4）', () => {
  it('挂载即连接（携带 AbortSignal），卸载即断开；StrictMode 下成对收敛', () => {
    const source = new FakeSource()
    const runtime = createFleetRuntime()
    const ref = new VehicleSourceRef(source)
    const { unmount } = renderDataHook(ref, runtime)
    // StrictMode：setup → cleanup → setup，活跃连接峰值仍为 1
    expect(source.connectCount).toBe(2)
    expect(source.disconnectCount).toBe(1)
    expect(source.maxActive).toBe(1)
    expect(source.lastSignal).toBeInstanceOf(AbortSignal)
    unmount()
    expect(source.disconnectCount).toBe(2)
    expect(source.active).toBe(0)
  })

  it('StrictMode 双执行收敛：连接/断开成对发生，活跃连接峰值 ≤ 1', () => {
    const source = new FakeSource()
    const runtime = createFleetRuntime()
    const ref = new VehicleSourceRef(source)
    const { unmount } = renderDataHook(ref, runtime)
    // setup → cleanup → setup：两次 connect、一次中途 disconnect
    expect(source.connectCount).toBe(2)
    expect(source.disconnectCount).toBe(1)
    expect(source.maxActive).toBe(1)
    unmount()
    expect(source.disconnectCount).toBe(2)
    expect(source.active).toBe(0)
  })

  it('source=null 是合法稳态：不连接、每次接线状态回调收到 IDLE', () => {
    const runtime = createFleetRuntime()
    const statuses: SourceStatus[] = []
    const ref = new VehicleSourceRef(null)
    const { unmount } = renderDataHook(ref, runtime, {
      onStatusChange: (status) => statuses.push(status),
    })
    expect(statuses.length).toBeGreaterThan(0)
    expect(statuses.every((status) => status === 'IDLE')).toBe(true)
    unmount()
  })

  it('options 每次渲染变化（内联回调）不重建连接', () => {
    const source = new FakeSource()
    const runtime = createFleetRuntime()
    const ref = new VehicleSourceRef(source)
    const { rerender } = renderDataHook(ref, runtime)
    rerender(
      harnessTree(source, runtime, { onStatusChange: () => {} }),
    )
    rerender(harnessTree(source, runtime, { now: () => 1 }))
    expect(source.connectCount).toBe(2) // 仅 StrictMode 双执行，无额外重建
    expect(source.disconnectCount).toBe(1)
  })

  it('卸载竞态：connect 未兑现时卸载 → 成对断开且无异常外泄', async () => {
    const source = new FakeSource()
    source.pendingConnect = new Promise<void>(() => {})
    const runtime = createFleetRuntime()
    const ref = new VehicleSourceRef(source)
    const { unmount } = renderDataHook(ref, runtime)
    unmount()
    expect(source.disconnectCount).toBe(source.connectCount)
    await act(async () => {
      await Promise.resolve()
    })
  })
})

describe('事件接线与 ticker（F5、§11.1）', () => {
  it('高频事件只写运行时；StrictMode 双执行下同一事件只应用一次', () => {
    const source = new FakeSource()
    const runtime = createFleetRuntime({ now: () => 0 })
    const ref = new VehicleSourceRef(source)
    renderDataHook(ref, runtime)
    source.emit(snapshotEvent([makeSnapshotPayload()], 0, 1, MAP))
    expect(runtime.count).toBe(1)
    expect(runtime.get(makeSnapshotPayload().entityKey)).toBeDefined()
  })

  it('1Hz ticker 驱动 freshness 跃迁：10s 无更新转 STALE', () => {
    const source = new FakeSource()
    let now = 0
    const runtime = createFleetRuntime({ now: () => now })
    const ref = new VehicleSourceRef(source)
    renderDataHook(ref, runtime, { now: () => now })
    const payload = makeSnapshotPayload()
    source.emit(snapshotEvent([payload], now, 1, MAP))
    expect(runtime.get(payload.entityKey)?.freshness).toBe('FRESH')
    now += 10_000
    act(() => {
      vi.advanceTimersByTime(TICK_MS)
    })
    expect(runtime.get(payload.entityKey)?.freshness).toBe('STALE')
  })

  it('heartbeat 不刷新单车新鲜度（由运行时语义保证经 Hook 通道生效）', () => {
    const source = new FakeSource()
    let now = 0
    const runtime = createFleetRuntime({ now: () => now })
    const ref = new VehicleSourceRef(source)
    renderDataHook(ref, runtime, { now: () => now })
    const payload = makeSnapshotPayload()
    source.emit(snapshotEvent([payload], now, 1, MAP))
    now += 5_000
    source.emit(heartbeatEvent(now, MAP))
    now += 6_000
    act(() => {
      vi.advanceTimersByTime(TICK_MS)
    })
    expect(runtime.get(payload.entityKey)?.freshness).toBe('STALE')
  })
})

describe('快速 source 切换（TASK-007 验证项）', () => {
  it('切换后旧源被断开且事件被退订，新源接入', () => {
    const first = new FakeSource()
    const second = new FakeSource()
    const runtime = createFleetRuntime({ now: () => 0 })
    const ref = new VehicleSourceRef(first)
    const { rerender, unmount } = renderDataHook(ref, runtime)
    rerender(harnessTree(second, runtime, {}))
    expect(first.disconnectCount).toBeGreaterThanOrEqual(1)
    expect(second.connectCount).toBe(1)
    // 旧源事件已退订：不影响运行时
    first.emit(snapshotEvent([makeSnapshotPayload('ghost')], 0, 1, MAP))
    expect(runtime.count).toBe(0)
    // 新源事件正常进入运行时
    second.emit(snapshotEvent([makeSnapshotPayload()], 0, 1, MAP))
    expect(runtime.count).toBe(1)
    unmount()
    expect(second.disconnectCount).toBe(1)
  })
})
