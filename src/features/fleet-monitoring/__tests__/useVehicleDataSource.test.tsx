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
  removeEvent,
  snapshotEvent,
  snapshotOf,
  updateEvent,
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

/* ==================== 后台节流与前台瞬时对齐（SPEC §11.5；TASK-015） ==================== */

/**
 * 设置页面可见性并派发 visibilitychange（jsdom 无真实切换）：
 * 实时改写 document.visibilityState（实现约定回调内实时读取）后手动派发。
 */
function setPageVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('后台节流与前台瞬时对齐（§11.5；TASK-015）', () => {
  afterEach(() => {
    // 恢复可见性，避免影响同文件其他用例的挂载初始态
    setPageVisibility('visible')
  })

  it('隐藏即暂停 ticker：暂停前立即重算一次，此后时间推进不再 tick', () => {
    const source = new FakeSource()
    let now = 0
    const runtime = createFleetRuntime({ now: () => now })
    const ref = new VehicleSourceRef(source)
    const tickSpy = vi.spyOn(runtime, 'tick')
    renderDataHook(ref, runtime, { now: () => now })
    const payload = makeSnapshotPayload()
    source.emit(snapshotEvent([payload], now, 1, MAP))
    tickSpy.mockClear()

    act(() => {
      now = 3_000
      setPageVisibility('hidden')
    })
    // 暂停前立即重算：freshness 冻结在隐藏时刻的真相
    expect(tickSpy).toHaveBeenCalledTimes(1)
    expect(tickSpy).toHaveBeenLastCalledWith(3_000)
    expect(runtime.get(payload.entityKey)?.freshness).toBe('FRESH')

    // 隐藏 10min：ticker 已暂停，时间推进不产生任何 tick
    act(() => {
      now += 600_000
      vi.advanceTimersByTime(60_000)
    })
    expect(tickSpy).toHaveBeenCalledTimes(1)
    expect(runtime.get(payload.entityKey)?.freshness).toBe('FRESH')

    // 回前台立即重算：后台静默车一次性跃迁 STALE（603s ≫ 10s 阈值）
    act(() => {
      setPageVisibility('visible')
    })
    expect(tickSpy).toHaveBeenCalledTimes(2)
    expect(tickSpy).toHaveBeenLastCalledWith(603_000)
    expect(runtime.get(payload.entityKey)?.freshness).toBe('STALE')
  })

  it('回前台立即 markAllDirty：脏集合覆盖全部存活实体，ticker 恢复运行', () => {
    const source = new FakeSource()
    let now = 0
    const runtime = createFleetRuntime({ now: () => now })
    const ref = new VehicleSourceRef(source)
    const tickSpy = vi.spyOn(runtime, 'tick')
    renderDataHook(ref, runtime, { now: () => now })
    const payload = makeSnapshotPayload()
    source.emit(snapshotEvent([payload], now, 1, MAP))
    runtime.consumeDirty()
    tickSpy.mockClear()

    act(() => {
      setPageVisibility('hidden')
    })
    tickSpy.mockClear()

    act(() => {
      now = 500
      setPageVisibility('visible')
    })
    // 强制全量 diff：与隐藏期间事件是否到达无关，全部存活实体进脏集合
    const batch = runtime.consumeDirty()
    expect(batch.pose).toEqual([payload.entityKey])
    expect(batch.display).toEqual([payload.entityKey])
    // ticker 恢复：时间推进继续驱动 freshness
    act(() => {
      vi.advanceTimersByTime(TICK_MS)
    })
    expect(tickSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('隐藏期间数据源不断开、事件继续归并：每车只保留最新快照', () => {
    const source = new FakeSource()
    let now = 0
    const runtime = createFleetRuntime({ now: () => now })
    const ref = new VehicleSourceRef(source)
    const { unmount } = renderDataHook(ref, runtime, { now: () => now })
    const payload = makeSnapshotPayload()
    source.emit(snapshotEvent([payload], now, 1, MAP))
    const connectBaseline = source.connectCount
    const disconnectBaseline = source.disconnectCount

    act(() => {
      now = 1_000
      setPageVisibility('hidden')
    })
    expect(source.connectCount).toBe(connectBaseline)
    expect(source.disconnectCount).toBe(disconnectBaseline)

    // 后台期间连续多次 update（位置推进）与一次 remove：
    // update 只保留最新（无事件回放），remove 事件照常归并
    now = 600_000
    source.emit(updateEvent(
      snapshotOf(makeRawVehicle({ agvPosition: { x: 130, y: 55, theta: 0.4, localizationScore: 0.9 } })),
      now,
      2,
    ))
    expect(runtime.count).toBe(1)
    const entity = runtime.get(payload.entityKey)
    expect(entity?.snapshot.position.x).toBe(130)
    expect(entity?.freshness).toBe('FRESH')

    source.emit(removeEvent(MAP, payload.agvKey, now + 1))
    expect(runtime.count).toBe(0)

    act(() => {
      setPageVisibility('visible')
    })
    unmount()
    // 断开只发生一次（卸载清理），可见性切换不触碰连接
    expect(source.disconnectCount).toBe(disconnectBaseline + 1)
  })

  it('挂载即隐藏：ticker 不启动；回前台立即重算并恢复 ticker', () => {
    const source = new FakeSource()
    let now = 0
    const runtime = createFleetRuntime({ now: () => now })
    const ref = new VehicleSourceRef(source)
    const tickSpy = vi.spyOn(runtime, 'tick')
    act(() => {
      setPageVisibility('hidden')
    })
    renderDataHook(ref, runtime, { now: () => now })
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(tickSpy).not.toHaveBeenCalled()

    act(() => {
      now = 20_000
      setPageVisibility('visible')
    })
    expect(tickSpy).toHaveBeenCalledTimes(1)
    expect(tickSpy).toHaveBeenLastCalledWith(20_000)
    act(() => {
      vi.advanceTimersByTime(TICK_MS)
    })
    expect(tickSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('监听对称清理：卸载后可见性变化不再触达运行时，且 StrictMode 下无重复监听', () => {
    const source = new FakeSource()
    let now = 0
    const runtime = createFleetRuntime({ now: () => now })
    const ref = new VehicleSourceRef(source)
    const tickSpy = vi.spyOn(runtime, 'tick')
    const { unmount } = renderDataHook(ref, runtime, { now: () => now })
    // StrictMode setup→cleanup→setup 后只剩一个监听：一次 hide 一次 show
    // 各触发恰好一次立即 tick（重复监听会使次数翻倍）
    act(() => {
      setPageVisibility('hidden')
    })
    act(() => {
      setPageVisibility('visible')
    })
    expect(tickSpy).toHaveBeenCalledTimes(2)
    tickSpy.mockClear()

    unmount()
    act(() => {
      setPageVisibility('hidden')
      setPageVisibility('visible')
    })
    expect(tickSpy).not.toHaveBeenCalled()
    expect(source.disconnectCount).toBe(source.connectCount)
  })
})
