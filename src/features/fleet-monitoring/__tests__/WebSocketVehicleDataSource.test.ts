/*
 * WebSocket 车辆数据源测试（TASK-007 / SPEC §3.1～§3.3、§11.2、§11.7；C1～C3）。
 *
 * 覆盖：四类事件与上下文补全、重复/回退序号治理、快照基线门控（孤立增量拒绝、
 *       heartbeat 通行）、连接代次隔离、1/2/4/8s→30s 抖动退避与 60s 稳定重置、
 *       15s 静默主动重连、手动断开清理全部计时器、连续解码失败进入 ERROR 终态、
 *       重连全量对齐、connect/disconnect 幂等、AbortSignal 三阶段取消与
 *       ERROR→CLOSED→connect 恢复路径、完整 SourceStatus 状态机。
 * 手法：FakeWebSocket 手动驱动连接生命周期，vi.useFakeTimers 驱动退避与
 *       看门狗，随机源注入固定值锁定抖动区间。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDiagnosticsReporter,
  type DiagnosticRecord,
} from '@/shared/diagnostics'
import {
  createWebSocketVehicleDataSource,
  type SourceStatus,
  type VehicleDataEvent,
  type WebSocketDataSourceOptions,
} from '@/features/fleet-monitoring'
import {
  createFakeSocketFactory,
  createTestProtocolAdapter,
  FakeWebSocket,
} from './fakeWebSocket'
import { makeRawVehicle } from './testVehicles'

const MAP = 'map-under-test'

const frame = (payload: unknown): string => JSON.stringify(payload)

const snapshotFrame = (sequence: number, agvKeys: string[]): string =>
  frame({
    type: 'snapshot',
    schemaVersion: 'test/1',
    sequence,
    vehicles: agvKeys.map((agvKey) => makeRawVehicle({ agvKey })),
  })

const updateFrame = (sequence: number, x: number, agvKey = 'agv-001'): string =>
  frame({
    type: 'update',
    schemaVersion: 'test/1',
    sequence,
    vehicle: makeRawVehicle({
      agvKey,
      agvPosition: { x, y: 1, theta: 0, localizationScore: 0.9 },
    }),
  })

const removeFrame = (sequence: number, agvKey: string): string =>
  frame({ type: 'remove', schemaVersion: 'test/1', sequence, agvKey })

const heartbeatFrame = (sequence: number): string =>
  frame({ type: 'heartbeat', schemaVersion: 'test/1', sequence })

interface Harness {
  source: ReturnType<typeof createWebSocketVehicleDataSource>
  sockets: ReturnType<typeof createFakeSocketFactory>['sockets']
  current: () => FakeWebSocket
  events: VehicleDataEvent[]
  statuses: SourceStatus[]
  diagCodes: () => string[]
  seq: () => number
}

function setup(options: Partial<WebSocketDataSourceOptions> = {}): Harness {
  const { sockets, factory, current } = createFakeSocketFactory()
  const events: VehicleDataEvent[] = []
  const statuses: SourceStatus[] = []
  const diagnostics: DiagnosticRecord[] = []
  let sequenceCounter = 0
  const source = createWebSocketVehicleDataSource({
    wsUrl: 'ws://test-harness/vehicle',
    mapId: MAP,
    adapter: createTestProtocolAdapter(MAP),
    socketFactory: factory,
    diagnostics: createDiagnosticsReporter({
      sink: (record) => diagnostics.push(record),
    }),
    ...options,
  })
  source.onEvent((event) => events.push(event))
  source.onStatusChange((status) => statuses.push(status))
  return {
    source,
    sockets,
    current,
    events,
    statuses,
    diagCodes: () => diagnostics.map((record) => record.code),
    seq: () => ++sequenceCounter,
  }
}

/** 建立一条已打开且已对齐（基线快照落地）的连接 */
function openAligned(h: Harness, agvKeys: string[] = ['agv-001']): void {
  h.source.connect()
  h.current().open()
  h.current().serverMessage(snapshotFrame(h.seq(), agvKeys))
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('生命周期与幂等（§3.1）', () => {
  it('connect 前为 IDLE；connect 建立 CONNECTING，基线快照落地后转 OPEN', () => {
    const h = setup()
    expect(h.source.status).toBe('IDLE')
    h.source.connect()
    expect(h.sockets).toHaveLength(1)
    expect(h.source.status).toBe('CONNECTING')
    h.current().open()
    // socket 已打开但基线未建立：首次连接保持 CONNECTING
    expect(h.source.status).toBe('CONNECTING')
    h.current().serverMessage(snapshotFrame(h.seq(), ['agv-001']))
    expect(h.source.status).toBe('OPEN')
  })

  it('连接中重复 connect 幂等：不建第二条连接，会话在打开时一并兑现', async () => {
    const h = setup()
    let firstResolved = false
    let secondResolved = false
    const first = h.source.connect().then(() => {
      firstResolved = true
    })
    const second = h.source.connect().then(() => {
      secondResolved = true
    })
    expect(h.sockets).toHaveLength(1)
    expect(firstResolved).toBe(false)
    h.current().open()
    await Promise.all([first, second])
    expect(firstResolved).toBe(true)
    expect(secondResolved).toBe(true)
    expect(h.sockets).toHaveLength(1)
  })

  it('手动 disconnect：CLOSED 终态、socket 以 1000 关闭、清理全部计时器；再次 connect 可恢复', () => {
    const h = setup()
    openAligned(h)
    h.source.disconnect()
    expect(h.source.status).toBe('CLOSED')
    expect(h.current().closedWith?.code).toBe(1000)
    // 推进 10 分钟：无重连、无静默看门狗触发
    vi.advanceTimersByTime(10 * 60_000)
    expect(h.sockets).toHaveLength(1)
    // 幂等：重复 disconnect 无副作用
    h.source.disconnect()
    expect(h.source.status).toBe('CLOSED')
    // 再次 connect（手动恢复路径）正常工作
    h.source.connect()
    expect(h.sockets).toHaveLength(2)
    h.current().open()
    h.current().serverMessage(snapshotFrame(h.seq(), ['agv-002']))
    expect(h.source.status).toBe('OPEN')
  })

  it('AbortSignal：connect 前已中止 → 以 AbortError 拒绝且不创建连接', async () => {
    const h = setup()
    const controller = new AbortController()
    controller.abort()
    const pending = h.source.connect(controller.signal)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.sockets).toHaveLength(0)
    expect(h.source.status).toBe('IDLE')
  })

  it('AbortSignal：连接中取消 → socket 关闭、会话拒绝、无重连计时器残留', async () => {
    const h = setup()
    const controller = new AbortController()
    const pending = h.source.connect(controller.signal)
    expect(h.sockets).toHaveLength(1)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.current().readyState).toBe(3)
    expect(h.source.status).toBe('IDLE')
    vi.advanceTimersByTime(10 * 60_000)
    expect(h.sockets).toHaveLength(1)
  })

  it('AbortSignal：重连等待期取消 → 退避计时器清理，不再建立新连接', async () => {
    const h = setup({ random: () => 0 })
    const controller = new AbortController()
    const pending = h.source.connect(controller.signal)
    h.current().open() // 会话 promise 在首个连接打开时兑现
    await flush()
    h.current().drop()
    expect(h.source.status).toBe('RECONNECTING')
    controller.abort() // 中止只拆除连接与计时器，不再重复拒绝已兑现的会话
    vi.advanceTimersByTime(10 * 60_000)
    expect(h.sockets).toHaveLength(1)
    expect(h.source.status).toBe('IDLE')
    await pending
  })

  it('完整 SourceStatus 状态机：六种状态在真实迁移路径中全部出现', async () => {
    const h = setup({ random: () => 0 })
    expect(['IDLE']).toContain(h.source.status)
    h.source.connect() // CONNECTING
    h.current().open() // 打开但未对齐：仍 CONNECTING
    h.current().serverMessage(snapshotFrame(h.seq(), ['a'])) // OPEN
    h.current().drop() // RECONNECTING
    vi.advanceTimersByTime(800) // 重连计时到期，新连接
    h.current().open()
    h.current().serverMessage(snapshotFrame(h.seq(), ['a'])) // OPEN
    h.source.disconnect() // CLOSED
    h.source.connect() // CONNECTING
    h.current().open()
    for (let i = 0; i < 10; i += 1) {
      h.current().serverMessage('broken')
    } // ERROR
    await flush()
    expect(h.statuses).toEqual([
      'CONNECTING',
      'OPEN',
      'RECONNECTING',
      'OPEN',
      'CLOSED',
      'CONNECTING',
      'ERROR',
    ])
  })
})

describe('序号治理与快照基线门控（§3.2、§3.3）', () => {
  it('四类事件按序应用并补全 mapId 与单调 receivedAt', () => {
    const h = setup({
      now: (() => {
        let t = 0
        return () => {
          t += 1
          return t
        }
      })(),
    })
    openAligned(h, ['agv-001', 'agv-002'])
    h.current().serverMessage(updateFrame(h.seq(), 5))
    h.current().serverMessage(removeFrame(h.seq(), 'agv-002'))
    h.current().serverMessage(heartbeatFrame(h.seq()))
    expect(h.events.map((event) => event.type)).toEqual([
      'snapshot',
      'update',
      'remove',
      'heartbeat',
    ])
    for (const event of h.events) {
      expect(event.mapId).toBe(MAP)
      expect(typeof event.receivedAt).toBe('number')
      expect(Number.isFinite(event.receivedAt)).toBe(true)
    }
    const receivedAtList = h.events.map((event) => event.receivedAt)
    for (let i = 1; i < receivedAtList.length; i += 1) {
      expect(receivedAtList[i]!).toBeGreaterThan(receivedAtList[i - 1]!)
    }
    const snapshot = h.events[0]!
    if (snapshot.type === 'snapshot') {
      expect(snapshot.vehicles).toHaveLength(2)
    }
    const update = h.events[1]!
    if (update.type === 'update') {
      expect(update.vehicle.agvKey).toBe('agv-001')
    }
  })

  it('重复与回退序号被忽略并记录采样告警，不影响现有数据', () => {
    const h = setup()
    openAligned(h, ['agv-001'])
    const baseline = h.events.length
    h.current().serverMessage(snapshotFrame(1, ['agv-001'])) // 与首条同序号：重复
    h.current().serverMessage(snapshotFrame(1, ['agv-001', 'agv-002'])) // 重复
    h.current().serverMessage(updateFrame(0, 9)) // 回退
    expect(h.events).toHaveLength(baseline)
    expect(h.diagCodes()).toContain('WS_SEQUENCE_STALE')
    h.current().serverMessage(updateFrame(2, 7)) // 更新序号：接受
    expect(h.events).toHaveLength(baseline + 1)
  })

  it('快照前的孤立 update/remove 被拒绝；heartbeat 通行但不建立基线', () => {
    const h = setup()
    h.source.connect()
    h.current().open()
    h.current().serverMessage(updateFrame(1, 5))
    h.current().serverMessage(removeFrame(2, 'agv-001'))
    expect(h.events).toHaveLength(0)
    expect(h.diagCodes()).toContain('WS_ORPHAN_INCREMENT')
    expect(h.source.status).toBe('CONNECTING')
    h.current().serverMessage(heartbeatFrame(3))
    expect(h.events).toHaveLength(1) // heartbeat 通行
    expect(h.source.status).toBe('CONNECTING') // 但不建立基线
    h.current().serverMessage(snapshotFrame(4, ['agv-001']))
    expect(h.source.status).toBe('OPEN')
    expect(h.events).toHaveLength(2)
  })

  it('重连全量对齐：新连接上孤立增量被拒，新快照重建基线', () => {
    const h = setup({ random: () => 0 })
    openAligned(h, ['agv-001'])
    h.current().drop() // 异常断开
    vi.advanceTimersByTime(800)
    expect(h.sockets).toHaveLength(2)
    h.current().open()
    h.current().serverMessage(updateFrame(100, 9)) // 孤立增量（新序号空间内合法但无基线）
    expect(h.events).toHaveLength(1)
    h.current().serverMessage(snapshotFrame(101, ['agv-X', 'agv-Y']))
    expect(h.source.status).toBe('OPEN')
    expect(h.events).toHaveLength(2)
    const latest = h.events[1]!
    if (latest.type === 'snapshot') {
      expect(latest.vehicles.map((vehicle) => vehicle.agvKey)).toEqual([
        'agv-X',
        'agv-Y',
      ])
    }
  })

  it('连接代次隔离：被替换的旧连接上的消息全部失效', () => {
    const h = setup()
    h.source.connect()
    const staleSocket = h.current()
    staleSocket.open()
    // 静默超时触发主动重连：staleSocket 被替换
    vi.advanceTimersByTime(15_002)
    expect(h.sockets).toHaveLength(2)
    expect(h.source.status).toBe('RECONNECTING')
    staleSocket.serverMessage(snapshotFrame(h.seq(), ['ghost']))
    expect(h.events).toHaveLength(0)
    h.current().open()
    h.current().serverMessage(snapshotFrame(h.seq(), ['real']))
    expect(h.events).toHaveLength(1)
  })
})

describe('异常退避与静默看门狗（§3.3）', () => {
  it('异常断开按 1s/2s/4s/8s/16s→30s 基础间隔 ×0.8（random=0）退避', () => {
    const h = setup({ random: () => 0 })
    h.source.connect()
    const expectedDelays = [800, 1_600, 3_200, 6_400, 12_800, 24_000, 24_000]
    let socketCount = 1
    for (const delay of expectedDelays) {
      h.current().open()
      h.current().drop()
      expect(h.source.status).toBe('RECONNECTING')
      expect(h.diagCodes()).toContain('WS_RECONNECT_SCHEDULED')
      vi.advanceTimersByTime(delay - 1)
      expect(h.sockets).toHaveLength(socketCount)
      vi.advanceTimersByTime(1)
      socketCount += 1
      expect(h.sockets).toHaveLength(socketCount)
    }
  })

  it('抖动上界：random=1 → 基础间隔 ×1.2', () => {
    const h = setup({ random: () => 1 })
    h.source.connect()
    h.current().open()
    h.current().drop()
    vi.advanceTimersByTime(1_200 - 1)
    expect(h.sockets).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(h.sockets).toHaveLength(2)
  })

  it('连接连续稳定 60s 后退避级别重置', () => {
    const h = setup({ random: () => 0 })
    h.source.connect()
    h.current().open()
    h.current().drop()
    vi.advanceTimersByTime(800) // 第一次重连：level 1
    h.current().open() // 打开并保持：稳定时长从打开时刻起算
    // 新连接持续 65s：每 5s 心跳重置静默看门狗
    for (let i = 0; i < 13; i += 1) {
      vi.advanceTimersByTime(5_000)
      h.current().serverMessage(heartbeatFrame(h.seq()))
    }
    expect(h.sockets).toHaveLength(2)
    h.current().drop()
    // 稳定 65s ≥ 60s：级别重置，延迟回到 1000×0.8 而非升级
    vi.advanceTimersByTime(799)
    expect(h.sockets).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(h.sockets).toHaveLength(3)
  })

  it('静默 15s 主动重连：立即重建、不消耗退避、旧连接以 4000 关闭', () => {
    const h = setup({ random: () => 0 })
    h.source.connect()
    h.current().open()
    vi.advanceTimersByTime(14_999)
    expect(h.sockets).toHaveLength(1)
    // 看门狗触发 + 0ms 重连计时（计时器链在同一次推进内可能需要额外一拍）
    vi.advanceTimersByTime(2)
    expect(h.sockets).toHaveLength(2)
    expect(h.sockets[0]!.closedWith?.code).toBe(4000)
    expect(h.source.status).toBe('RECONNECTING')
    expect(h.diagCodes()).toContain('WS_SILENT_RECONNECT')
    // 主动重连不抬升退避级别：连续多次静默仍按 15s 节奏立即重建
    let socketCount = 2
    for (let round = 0; round < 3; round += 1) {
      h.current().open()
      vi.advanceTimersByTime(15_002)
      socketCount += 1
      expect(h.sockets).toHaveLength(socketCount)
    }
  })

  it('持续有效通道事件重置静默看门狗：心跳不断则不重连', () => {
    const h = setup()
    h.source.connect()
    h.current().open()
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(10_000)
      h.current().serverMessage(heartbeatFrame(h.seq()))
    }
    expect(h.sockets).toHaveLength(1)
    expect(h.source.status).toBe('CONNECTING') // 一直无快照：未对齐
  })

  it('requestSnapshot：open 时发送适配器帧；适配器无法表达或不在线时不发送', () => {
    const h = setup()
    h.source.connect()
    h.current().open()
    // 打开时数据源已自动请求一次快照
    expect(h.current().sent).toEqual([frame({ type: 'snapshotRequest' })])
    h.source.requestSnapshot()
    expect(h.current().sent).toHaveLength(2)
    // 适配器无法表达快照请求：静默跳过
    const silent = setup({
      adapter: {
        decode: createTestProtocolAdapter(MAP).decode,
        encodeSnapshotRequest: () => null,
      },
    })
    silent.source.connect()
    silent.current().open()
    expect(silent.current().sent).toHaveLength(0)
    silent.source.requestSnapshot()
    expect(silent.current().sent).toHaveLength(0)
    // 未打开：不发送
    h.source.disconnect()
    h.source.requestSnapshot()
    expect(h.sockets[0]!.sent).toHaveLength(2)
  })
})

describe('连续解码失败与 ERROR 终态（§11.7）', () => {
  function sendBroken(h: Harness, times: number): void {
    for (let i = 0; i < times; i += 1) {
      h.current().serverMessage('{broken-json')
    }
  }

  it('连续 10 次解码失败进入 ERROR：关闭连接、停止重连、不再处理消息', () => {
    const h = setup()
    openAligned(h)
    sendBroken(h, 9)
    expect(h.source.status).toBe('OPEN') // 未达阈值：保持原状态
    sendBroken(h, 1)
    expect(h.source.status).toBe('ERROR')
    expect(h.current().closedWith?.code).toBe(4000)
    expect(h.diagCodes()).toContain('WS_ERROR')
    vi.advanceTimersByTime(10 * 60_000)
    expect(h.sockets).toHaveLength(1) // 无任何重连
    // 迟到的消息不再被处理
    h.current().serverMessage(snapshotFrame(h.seq(), ['late']))
    expect(h.events).toHaveLength(1) // 仅最初的对齐快照
  })

  it('中途一次成功解码清零计数：9+1+9 不触发，再失败一次才触发', () => {
    const h = setup()
    openAligned(h)
    sendBroken(h, 9)
    h.current().serverMessage(heartbeatFrame(h.seq()))
    sendBroken(h, 9)
    expect(h.source.status).toBe('OPEN')
    sendBroken(h, 1)
    expect(h.source.status).toBe('ERROR')
  })

  it('ERROR 后经 disconnect → connect 显式恢复', () => {
    const h = setup()
    openAligned(h)
    sendBroken(h, 10)
    expect(h.source.status).toBe('ERROR')
    h.source.disconnect()
    expect(h.source.status).toBe('CLOSED')
    h.source.connect()
    expect(h.source.status).toBe('CONNECTING')
    h.current().open()
    h.current().serverMessage(snapshotFrame(h.seq(), ['recovered']))
    expect(h.source.status).toBe('OPEN')
    expect(h.events).toHaveLength(2)
  })
})
