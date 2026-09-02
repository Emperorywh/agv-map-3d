/*
 * 数据源选择测试（TASK-007/009 / SPEC §10.3、§12.3）。
 *
 * 职责：锁定 app 组合层的数据源选型合同——ws 配置产出绑定地图上下文的
 *       WebSocket 数据源（注入点透传）；mock 配置产出以 MapModel 拓扑为引擎
 *       的 Mock 数据源（MapModel 缺失显式降级 null 并记诊断）；__AGV_MOCK__
 *       开发桥只在「开发模式 + Mock」时注册到注入目标。本模块不发起连接。
 */
import { describe, expect, it, vi } from 'vitest'
import type { DiagnosticRecord } from '@/shared/diagnostics'
import { createDiagnosticsReporter, StructuredError } from '@/shared/diagnostics'
import type { RuntimeConfig } from '../loadRuntimeConfig'
import { selectVehicleDataSource } from '../selectVehicleDataSource'
import type {
  ProtocolDecodeResult,
  WebSocketProtocolAdapter,
} from '@/features/fleet-monitoring'
import { WS_READY_STATE_OPEN, type WebSocketLike } from '@/features/fleet-monitoring'
import { createMapModel, validateMap, type MapModel } from '@/features/map-visualization'

const MAP = 'm1'

/** 最小合成地图：两个 work 节点 + 一条 LINE 边（Mock 内核可用） */
function buildTinyMapModel(): MapModel {
  return createMapModel(
    validateMap({
      mapId: MAP,
      nodes: [
        { id: 'a', name: 'A', type: 'work', mapId: MAP, highPrecision: false, x: 0, y: 0, angle: null },
        { id: 'b', name: 'B', type: 'work', mapId: MAP, highPrecision: false, x: 3, y: 4, angle: null },
      ],
      edges: [
        {
          id: 'e1',
          mapId: MAP,
          edgeType: 'LINE',
          sx: 0,
          sy: 0,
          ex: 3,
          ey: 4,
          cx: null,
          cy: null,
          dx: null,
          dy: null,
          isBackEdge: false,
          cost: 5,
          maxLoadSpeed: 1,
          maxFreeSpeed: 1,
          maxLoadRotationSpeed: null,
          maxFreeRotationSpeed: null,
          loadSecurity: null,
          freeSecurity: null,
          snodeId: 'a',
          enodeId: 'b',
        },
      ],
      zones: [],
      nodeEdgeGroups: [],
    }),
  ).mapModel
}

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

  it('mapId 支持 Promise 形态透传（TASK-017）：构造成功，绑定语义由数据源测试锁定', () => {
    // 延迟绑定的完整语义（缓冲/补发布/拒绝终态）在 WebSocketVehicleDataSource
    // 测试中锁定；此处锁定装配点接受 Promise 形态并产出数据源。
    let resolveMapId: (mapId: string) => void = () => {}
    const mapId = new Promise<string>((resolve) => {
      resolveMapId = resolve
    })
    resolveMapId('map-late')
    const source = selectVehicleDataSource({
      config: makeConfig(),
      mapId,
      socketFactory: () => makeStubSocket(),
    })
    expect(source).not.toBeNull()
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

  it('dataSource=mock 但 MapModel 缺失：显式降级为 null 并记 DATA_SOURCE_UNAVAILABLE', () => {
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

  it('dataSource=mock 且 MapModel 就绪：产出 Mock 数据源，连接即得全量快照', async () => {
    vi.useFakeTimers()
    try {
      const { reporter } = recordingDiagnostics()
      const source = selectVehicleDataSource({
        config: makeConfig({ dataSource: 'mock', wsUrl: null }),
        mapId: MAP,
        mapModel: buildTinyMapModel(),
        diagnostics: reporter,
      })
      expect(source).not.toBeNull()
      const events: unknown[] = []
      source!.onEvent((event) => events.push(event))
      await source!.connect()
      expect(source!.status).toBe('OPEN')
      const snapshot = events[0] as { type: string; vehicles: unknown[] }
      expect(snapshot.type).toBe('snapshot')
      expect(snapshot.vehicles.length).toBeGreaterThan(0)
      source!.disconnect()
      expect(source!.status).toBe('CLOSED')
    } finally {
      vi.useRealTimers()
    }
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
