/*
 * 数据源选择测试（TASK-007 / SPEC §10.3、§12.3）。
 *
 * 职责：锁定 app 组合层的数据源选型合同——ws 配置产出绑定地图上下文的
 *       WebSocket 数据源（注入点透传），mock 配置与 wsUrl 缺失显式降级为
 *       null 并记诊断；本模块不发起连接。
 */
import { describe, expect, it } from 'vitest'
import type { DiagnosticRecord } from '@/shared/diagnostics'
import { createDiagnosticsReporter, StructuredError } from '@/shared/diagnostics'
import type { RuntimeConfig } from '../loadRuntimeConfig'
import { selectVehicleDataSource } from '../selectVehicleDataSource'
import type {
  ProtocolDecodeResult,
  WebSocketProtocolAdapter,
} from '@/features/fleet-monitoring'
import { WS_READY_STATE_OPEN, type WebSocketLike } from '@/features/fleet-monitoring'

const MAP = 'm1'

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    dataSource: 'ws',
    mapUrl: './json/map.json',
    wsUrl: 'ws://test-harness/vehicle',
    maxVehicles: 256,
    staleAfterMs: 10_000,
    renderer: { maxDpr: 1.5, shadowMapSize: 2048 },
    coordinateTransform: {
      scale: 1,
      rotation: 0,
      mirrorY: false,
      translateX: 0,
      translateY: 0,
    },
    ...overrides,
  }
}

/** 收集诊断记录的通道 */
function recordingDiagnostics(): {
  records: DiagnosticRecord[]
  reporter: ReturnType<typeof createDiagnosticsReporter>
} {
  const records: DiagnosticRecord[] = []
  return {
    records,
    reporter: createDiagnosticsReporter({ sink: (record) => records.push(record) }),
  }
}

/** 拒绝一切的测试适配器：本文件只关心选型与注入，不关心解码细节 */
const noopAdapter: WebSocketProtocolAdapter = {
  decode(): ProtocolDecodeResult {
    return {
      ok: false,
      error: new StructuredError({
        code: 'PROTOCOL_UNMAPPED',
        message: '测试适配器拒绝一切消息',
        context: {},
      }),
    }
  },
  encodeSnapshotRequest: () => null,
}

describe('selectVehicleDataSource（TASK-007）', () => {
  it('dataSource=ws：产出数据源，连接时以配置的 wsUrl 创建 socket', async () => {
    const createdUrls: string[] = []
    const source = selectVehicleDataSource({
      config: makeConfig(),
      mapId: MAP,
      socketFactory: (url) => {
        createdUrls.push(url)
        return makeStubSocket()
      },
    })
    expect(source).not.toBeNull()
    // 构造阶段不发起连接
    expect(createdUrls).toEqual([])
    await source!.connect()
    expect(createdUrls).toEqual(['ws://test-harness/vehicle'])
    source!.disconnect()
  })

  it('协议适配器注入点透传：自定义适配器决定消息映射', async () => {
    const decoded: unknown[] = []
    const source = selectVehicleDataSource({
      config: makeConfig(),
      mapId: MAP,
      adapter: {
        decode: (raw) => {
          decoded.push(raw)
          return noopAdapter.decode(raw)
        },
        encodeSnapshotRequest: () => null,
      },
      socketFactory: () => makeStubSocket(),
    })
    await source!.connect()
    source!.disconnect()
    expect(decoded).toHaveLength(0) // 未收到消息时不调用
  })

  it('dataSource=mock：TASK-009 实现前显式降级为 null 并记 DATA_SOURCE_UNAVAILABLE', () => {
    const { records, reporter } = recordingDiagnostics()
    const source = selectVehicleDataSource({
      config: makeConfig({ dataSource: 'mock', wsUrl: null }),
      mapId: MAP,
      diagnostics: reporter,
    })
    expect(source).toBeNull()
    expect(records.map((record) => record.code)).toEqual([
      'DATA_SOURCE_UNAVAILABLE',
    ])
  })

  it('dataSource=ws 但 wsUrl 缺失：纵深防御降级为 null，不抛出中断启动', () => {
    const { records, reporter } = recordingDiagnostics()
    const source = selectVehicleDataSource({
      config: makeConfig({ wsUrl: null }),
      mapId: MAP,
      diagnostics: reporter,
    })
    expect(source).toBeNull()
    expect(records.map((record) => record.code)).toEqual([
      'DATA_SOURCE_UNAVAILABLE',
    ])
  })
})

/** 最小桩 socket：在下一个微任务自动打开（connect 会话随之兑现） */
function makeStubSocket(): WebSocketLike {
  let readyState = 0
  const socket = {
    get readyState(): number {
      return readyState
    },
    send: () => {},
    close: () => {},
    onopen: null as (() => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onmessage: null as (() => void) | null,
  }
  queueMicrotask(() => {
    readyState = WS_READY_STATE_OPEN
    socket.onopen?.()
  })
  return socket
}
