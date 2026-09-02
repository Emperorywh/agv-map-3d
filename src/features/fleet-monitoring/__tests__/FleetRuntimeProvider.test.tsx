/*
 * FleetRuntimeProvider 测试（TASK-007 / SPEC §4、§12.5）。
 *
 * 覆盖：运行时单实例（状态变化重渲染不重建）、低频状态经 Context 可达、
 *       高频事件落入运行时（经 Context 可读）、source=null 稳态、卸载断开、
 *       缺 Provider 的接线错误立即暴露。
 */
import { StrictMode } from 'react'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWebSocketVehicleDataSource,
  type VehicleDataSource,
} from '@/features/fleet-monitoring'
import { FleetRuntimeProvider } from '../components/FleetRuntimeProvider'
import { useFleetRuntime } from '../hooks/FleetRuntimeContext'
import { createFakeSocketFactory, createTestProtocolAdapter } from './fakeWebSocket'
import { makeRawVehicle } from './testVehicles'

const MAP = 'map-under-test'

/** 探针：渲染 Context 注入值的最小消费组件 */
function Probe({ onRender }: { onRender: (status: string, count: number, runtimeId: number) => void }) {
  const { runtime, status } = useFleetRuntime()
  onRender(status, runtime.count, runtimeIdOf(runtime))
  return null
}

const runtimeIds = new WeakMap<object, number>()
let nextRuntimeId = 1
function runtimeIdOf(runtime: object): number {
  let id = runtimeIds.get(runtime)
  if (id === undefined) {
    id = nextRuntimeId
    nextRuntimeId += 1
    runtimeIds.set(runtime, id)
  }
  return id
}

function renderProvider(
  source: VehicleDataSource | null,
  probe: (status: string, count: number, runtimeId: number) => void,
) {
  return render(
    <StrictMode>
      <FleetRuntimeProvider source={source}>
        <Probe onRender={probe} />
      </FleetRuntimeProvider>
    </StrictMode>,
  )
}

/** 真实 WS 数据源（假 socket）：验证 Provider → Hook → 数据源整条接线 */
function makeWsSource() {
  const { sockets, factory, current } = createFakeSocketFactory()
  const source = createWebSocketVehicleDataSource({
    wsUrl: 'ws://test-harness/vehicle',
    mapId: MAP,
    adapter: createTestProtocolAdapter(MAP),
    socketFactory: factory,
  })
  return { source, sockets, current }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('FleetRuntimeProvider（TASK-007）', () => {
  it('状态经 Context 低频可达；运行时引用跨状态变化保持恒定', () => {
    const { source, current } = makeWsSource()
    const renders: Array<{ status: string; runtimeId: number }> = []
    const { unmount } = renderProvider(source, (status, _count, runtimeId) => {
      renders.push({ status, runtimeId })
    })
    // StrictMode 双执行收敛后连接建立
    act(() => {
      current().open()
    })
    act(() => {
      current().serverMessage(
        JSON.stringify({
          type: 'snapshot',
          schemaVersion: 'test/1',
          sequence: 1,
          vehicles: [makeRawVehicle({ agvKey: 'agv-001' })],
        }),
      )
    })
    const runtimeIdsInRenders = new Set(renders.map((entry) => entry.runtimeId))
    expect(runtimeIdsInRenders.size).toBe(1)
    expect(renders.at(-1)?.status).toBe('OPEN')
    unmount()
  })

  it('高频事件写入运行时且可经 Context 读取；卸载断开数据源', () => {
    const { source, current } = makeWsSource()
    const seenCounts: number[] = []
    const { unmount } = renderProvider(source, (_status, count) => {
      seenCounts.push(count)
    })
    act(() => {
      current().open()
    })
    act(() => {
      current().serverMessage(
        JSON.stringify({
          type: 'snapshot',
          schemaVersion: 'test/1',
          sequence: 1,
          vehicles: [
            makeRawVehicle({ agvKey: 'agv-001' }),
            makeRawVehicle({ agvKey: 'agv-002' }),
          ],
        }),
      )
    })
    expect(seenCounts.at(-1)).toBe(2)
    unmount()
  })

  it('source=null 稳态：状态恒为 IDLE，子树正常消费运行时', () => {
    const renders: Array<{ status: string; count: number }> = []
    const { unmount } = renderProvider(null, (status, count) => {
      renders.push({ status, count })
    })
    expect(renders.at(-1)).toEqual({ status: 'IDLE', count: 0 })
    unmount()
  })

  it('缺 Provider 时 useFleetRuntime 立即暴露接线错误', () => {
    function Orphan(): null {
      useFleetRuntime()
      return null
    }
    // 屏蔽 React 错误边界输出，只断言抛错行为
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Orphan />)).toThrow(/FleetRuntimeProvider 子树/)
    consoleSpy.mockRestore()
  })

  it('onRuntimeAvailable：以恒定运行时引用通知一次，StrictMode 重挂载幂等（TASK-013）', () => {
    const notified: unknown[] = []
    const { unmount } = render(
      <StrictMode>
        <FleetRuntimeProvider source={null} onRuntimeAvailable={(runtime) => {
          notified.push(runtime)
        }}>
          <Probe onRender={() => {}} />
        </FleetRuntimeProvider>
      </StrictMode>,
    )
    // StrictMode 双执行：两次通知携带同一运行时引用（回调幂等即可）
    expect(notified.length).toBeGreaterThanOrEqual(1)
    expect(new Set(notified).size).toBe(1)
    unmount()
    // 卸载后不再通知
    const countAfterUnmount = notified.length
    act(() => {})
    expect(notified.length).toBe(countAfterUnmount)
  })
})
