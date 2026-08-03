import { describe, expect, it } from 'vitest'

import type { FactoryMapError } from '../domain/errors'
import {
  MapCapacityError,
  MapEnvelopeError,
  MapGeometryError,
  MapHttpError,
  MapNetworkError,
  MapParseError,
  MapValidationError,
  SceneBuildError,
  WebGLUnavailableError,
} from '../domain/errors'
import type { FactorySceneModel, GeometryBatchDto } from './factorySceneModel'
import type { FactoryMapLoadEvent } from './loadFactoryMap'
import { loadFactoryMap } from './loadFactoryMap'
import type { FactoryScenePreparer } from './ports/FactoryScenePreparer'
import type { MapRepository } from './ports/MapRepository'

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

const TEST_URL = '/map.json'

function makeSceneModel(nodeCount: number, edgeCount: number): FactorySceneModel {
  const geometry: GeometryBatchDto = {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
  }
  return {
    bounds: { innerMinX: -30, innerMaxX: 30, innerMinZ: -20, innerMaxZ: 20, centerX: 0, centerZ: 0 },
    paths: { forward: geometry, backward: geometry },
    arrows: { forward: { matrices: new Float32Array(0) }, backward: { matrices: new Float32Array(0) } },
    nodes: {
      dots: { matrices: new Float32Array(0) },
      rings: { matrices: new Float32Array(0), colors: new Float32Array(0) },
      directions: { matrices: new Float32Array(0), colors: new Float32Array(0) },
    },
    labels: [],
    stats: { nodeCount, edgeCount, arrowCount: 0, labelMetadataCount: 0 },
  }
}

class FakePreparer implements FactoryScenePreparer {
  decodePayloads: ArrayBuffer[] = []
  terminated = false
  private readonly behavior: (payload: ArrayBuffer) => Promise<FactorySceneModel>

  constructor(behavior: (payload: ArrayBuffer) => Promise<FactorySceneModel>) {
    this.behavior = behavior
  }

  decodeAndBuild(payload: ArrayBuffer): Promise<FactorySceneModel> {
    this.decodePayloads.push(payload)
    return this.behavior(payload)
  }

  terminate(): void {
    this.terminated = true
  }
}

function makeRepository(behavior: (url: string, signal: AbortSignal) => Promise<ArrayBuffer>) {
  const calls: { url: string; signal: AbortSignal }[] = []
  const repository: MapRepository = {
    fetchPayload(url, signal) {
      calls.push({ url, signal })
      return behavior(url, signal)
    },
  }
  return { repository, calls }
}

function collectEvents() {
  const events: FactoryMapLoadEvent[] = []
  return { events, emit: (event: FactoryMapLoadEvent) => events.push(event) }
}

function requireFailed(events: FactoryMapLoadEvent[]) {
  for (const event of events) {
    if (event.type === 'failed') return event
  }
  throw new Error('缺少 failed 事件')
}

function runUseCase(
  repository: MapRepository,
  preparer: FactoryScenePreparer,
  emit: (event: FactoryMapLoadEvent) => void,
  signal: AbortSignal = new AbortController().signal,
  requestId = 1,
): Promise<void> {
  return loadFactoryMap(
    { repository, createPreparer: () => preparer },
    { url: TEST_URL, requestId, signal },
    emit,
  )
}

/** 宏任务冲刷：排空全部挂起的微任务链（非定时等待，不依赖系统时间） */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------------
// 成功与空图
// ---------------------------------------------------------------------------

describe('loadFactoryMap 成功编排（SPEC §5.1 单向数据流）', () => {
  it('fetch → createPreparer → decodeAndBuild → succeeded，payload/model 原样透传', async () => {
    const order: string[] = []
    const payload = new ArrayBuffer(8)
    const model = makeSceneModel(2, 1)
    const preparer = new FakePreparer(() => {
      order.push('decodeAndBuild')
      return Promise.resolve(model)
    })
    const { repository, calls } = makeRepository(() => {
      order.push('fetchPayload')
      return Promise.resolve(payload)
    })
    const { events, emit } = collectEvents()

    await loadFactoryMap(
      {
        repository,
        createPreparer: () => {
          order.push('createPreparer')
          return preparer
        },
      },
      { url: TEST_URL, requestId: 7, signal: new AbortController().signal },
      emit,
    )

    // Worker 在 fetch 完成后才创建（失败快速路径零 Worker 开销）
    expect(order).toEqual(['fetchPayload', 'createPreparer', 'decodeAndBuild'])
    expect(calls[0].url).toBe(TEST_URL)
    expect(preparer.decodePayloads[0]).toBe(payload)
    expect(events.map((event) => event.type)).toEqual(['preparing', 'succeeded'])
    expect(events[0]).toMatchObject({ type: 'preparing', requestId: 7, preparer })
    const succeeded = events[1]
    if (succeeded.type !== 'succeeded') throw new Error('缺少 succeeded 事件')
    expect(succeeded.requestId).toBe(7)
    expect(succeeded.model).toBe(model)
  })

  it('空图模型透传 succeeded（empty 页面状态由状态机判定，用例不吞数据）', async () => {
    const emptyModel = makeSceneModel(0, 0)
    const preparer = new FakePreparer(() => Promise.resolve(emptyModel))
    const { repository } = makeRepository(() => Promise.resolve(new ArrayBuffer(2)))
    const { events, emit } = collectEvents()

    await runUseCase(repository, preparer, emit)

    expect(events.map((event) => event.type)).toEqual(['preparing', 'succeeded'])
    const succeeded = events[1]
    if (succeeded.type !== 'succeeded') throw new Error('缺少 succeeded 事件')
    expect(succeeded.model).toBe(emptyModel)
    expect(succeeded.model.stats).toEqual({
      nodeCount: 0,
      edgeCount: 0,
      arrowCount: 0,
      labelMetadataCount: 0,
    })
  })
})

// ---------------------------------------------------------------------------
// §11 领域错误映射
// ---------------------------------------------------------------------------

const DOMAIN_ERRORS: ReadonlyArray<readonly [string, () => FactoryMapError]> = [
  ['MapNetworkError', () => new MapNetworkError('MAP_REQUEST_TIMEOUT', '地图请求超过 15 秒未响应')],
  ['MapHttpError', () => new MapHttpError('MAP_HTTP_NON_2XX', 'HTTP 404', { fieldPath: TEST_URL })],
  ['MapParseError', () => new MapParseError('MAP_JSON_PARSE_FAILED', 'JSON 语法错误')],
  ['MapEnvelopeError', () => new MapEnvelopeError('MAP_ENVELOPE_CODE_INVALID', '信封 code 非 200', { fieldPath: 'code' })],
  ['MapValidationError', () => new MapValidationError('MAP_NODE_TYPE_INVALID', '非法节点类型', { fieldPath: 'nodes[17].type', totalCount: 3 })],
  ['MapCapacityError', () => new MapCapacityError('MAP_BYTES_EXCEEDED', 'payload 超过 20MiB', { actual: 21 * 1024 * 1024, limit: 20 * 1024 * 1024 })],
  ['MapGeometryError', () => new MapGeometryError('MAP_CURVE_SUBDIVISION_FAILED', '贝塞尔自适应细分失败')],
  ['SceneBuildError', () => new SceneBuildError('MAP_WORKER_CRASHED', 'Worker 崩溃')],
  ['WebGLUnavailableError', () => new WebGLUnavailableError('WEBGL2_UNAVAILABLE', 'WebGL2 不可用')],
]

describe('loadFactoryMap §11 错误映射', () => {
  it.each(DOMAIN_ERRORS)('fetch reject %s → failed 事件原样透传进入 error 载荷', async (_name, makeError) => {
    const error = makeError()
    const { repository } = makeRepository(() => Promise.reject(error))
    const preparer = new FakePreparer(() => Promise.resolve(makeSceneModel(1, 1)))
    const { events, emit } = collectEvents()

    await runUseCase(repository, preparer, emit, new AbortController().signal, 3)

    expect(events).toHaveLength(1)
    const failed = requireFailed(events)
    expect(failed.error).toBe(error)
    expect(failed.requestId).toBe(3)
    expect(failed.url).toBe(TEST_URL)
    // fetch 阶段失败不创建 Worker
    expect(preparer.decodePayloads).toHaveLength(0)
  })

  it('prepare reject 领域错误 → 先发 preparing，再 failed 原样透传', async () => {
    const error = new MapValidationError('MAP_EDGE_REFERENCE_UNKNOWN', '边引用不存在的节点', {
      fieldPath: 'edges[3].snodeId',
    })
    const preparer = new FakePreparer(() => Promise.reject(error))
    const { repository } = makeRepository(() => Promise.resolve(new ArrayBuffer(4)))
    const { events, emit } = collectEvents()

    await runUseCase(repository, preparer, emit)

    expect(events.map((event) => event.type)).toEqual(['preparing', 'failed'])
    expect(requireFailed(events).error).toBe(error)
  })

  it('fetch 抛出未知异常 → failed(MapNetworkError MAP_NETWORK_UNEXPECTED)，cause 保留', async () => {
    const cause = new TypeError('socket closed')
    const { repository } = makeRepository(() => Promise.reject(cause))
    const preparer = new FakePreparer(() => Promise.resolve(makeSceneModel(1, 1)))
    const { events, emit } = collectEvents()

    await runUseCase(repository, preparer, emit)

    const failed = requireFailed(events)
    expect(failed.error).toBeInstanceOf(MapNetworkError)
    expect(failed.error.code).toBe('MAP_NETWORK_UNEXPECTED')
    expect(failed.error.cause).toBe(cause)
  })

  it('fetch 抛出非 Error 值（数字/null/无名对象）→ 同样映射为 MapNetworkError', async () => {
    for (const junk of [42, null, { reason: 'unknown' }]) {
      const { repository } = makeRepository(() => Promise.reject(junk))
      const preparer = new FakePreparer(() => Promise.resolve(makeSceneModel(1, 1)))
      const { events, emit } = collectEvents()

      await runUseCase(repository, preparer, emit)

      const failed = requireFailed(events)
      expect(failed.error).toBeInstanceOf(MapNetworkError)
      expect(failed.error.code).toBe('MAP_NETWORK_UNEXPECTED')
    }
  })

  it('decodeAndBuild 抛出未知异常 → failed(SceneBuildError MAP_WORKER_CRASHED)，cause 保留', async () => {
    const cause = new RangeError('offset out of bounds')
    const preparer = new FakePreparer(() => Promise.reject(cause))
    const { repository } = makeRepository(() => Promise.resolve(new ArrayBuffer(4)))
    const { events, emit } = collectEvents()

    await runUseCase(repository, preparer, emit)

    const failed = requireFailed(events)
    expect(failed.error).toBeInstanceOf(SceneBuildError)
    expect(failed.error.code).toBe('MAP_WORKER_CRASHED')
    expect(failed.error.cause).toBe(cause)
  })

  it('createPreparer 抛出异常 → failed(SceneBuildError)，不进入 preparing、不调用 decodeAndBuild', async () => {
    const cause = new Error('Worker 构造失败')
    const { repository } = makeRepository(() => Promise.resolve(new ArrayBuffer(4)))
    const { events, emit } = collectEvents()

    await loadFactoryMap(
      {
        repository,
        createPreparer: () => {
          throw cause
        },
      },
      { url: TEST_URL, requestId: 5, signal: new AbortController().signal },
      emit,
    )

    expect(events).toHaveLength(1)
    const failed = requireFailed(events)
    expect(failed.error).toBeInstanceOf(SceneBuildError)
    expect(failed.error.code).toBe('MAP_WORKER_CRASHED')
    expect(failed.error.cause).toBe(cause)
    expect(failed.requestId).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// 中止语义：abort 不误报错误（§5.1）
// ---------------------------------------------------------------------------

describe('loadFactoryMap 中止语义', () => {
  it('fetch 挂起期间 signal 中止 → 只发 aborted，不发 failed', async () => {
    const controller = new AbortController()
    const { repository } = makeRepository((_url, signal) =>
      new Promise<ArrayBuffer>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('已中止', 'AbortError')), {
          once: true,
        })
      }),
    )
    const preparer = new FakePreparer(() => Promise.resolve(makeSceneModel(1, 1)))
    const { events, emit } = collectEvents()

    const run = runUseCase(repository, preparer, emit, controller.signal)
    controller.abort()
    await run

    expect(events).toEqual([{ type: 'aborted', requestId: 1, url: TEST_URL }])
    expect(preparer.decodePayloads).toHaveLength(0)
  })

  it('fetch 完成时请求已被中止 → aborted，且不创建 Worker（§5.1）', async () => {
    const controller = new AbortController()
    const { repository } = makeRepository(() => {
      controller.abort()
      return Promise.resolve(new ArrayBuffer(4))
    })
    const preparer = new FakePreparer(() => Promise.resolve(makeSceneModel(1, 1)))
    const { events, emit } = collectEvents()

    await runUseCase(repository, preparer, emit, controller.signal)

    expect(events).toEqual([{ type: 'aborted', requestId: 1, url: TEST_URL }])
    expect(preparer.decodePayloads).toHaveLength(0)
  })

  it('prepare 期间中止（Worker 被 terminate 后 reject AbortError）→ preparing 后只发 aborted', async () => {
    const controller = new AbortController()
    const preparer = new FakePreparer(
      () =>
        new Promise<FactorySceneModel>((_resolve, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new DOMException('Worker 已终止', 'AbortError')),
            { once: true },
          )
        }),
    )
    const { repository } = makeRepository(() => Promise.resolve(new ArrayBuffer(4)))
    const { events, emit } = collectEvents()

    const run = runUseCase(repository, preparer, emit, controller.signal)
    await flush() // fetch 完成并进入 preparing
    expect(events.map((event) => event.type)).toEqual(['preparing'])
    controller.abort()
    await run

    expect(events.map((event) => event.type)).toEqual(['preparing', 'aborted'])
  })

  it('decodeAndBuild 完成时请求已被中止 → aborted，不发 succeeded（过期结果丢弃）', async () => {
    const controller = new AbortController()
    const preparer = new FakePreparer(() => {
      controller.abort()
      return Promise.resolve(makeSceneModel(1, 1))
    })
    const { repository } = makeRepository(() => Promise.resolve(new ArrayBuffer(4)))
    const { events, emit } = collectEvents()

    await runUseCase(repository, preparer, emit, controller.signal)

    expect(events.map((event) => event.type)).toEqual(['preparing', 'aborted'])
  })

  it('信号未中止但 fetch 以 AbortError reject（外部意外中断）→ 按中止处理，不误报失败', async () => {
    const { repository } = makeRepository(() =>
      Promise.reject(new DOMException('The operation was aborted', 'AbortError')),
    )
    const preparer = new FakePreparer(() => Promise.resolve(makeSceneModel(1, 1)))
    const { events, emit } = collectEvents()

    await runUseCase(repository, preparer, emit)

    expect(events).toEqual([{ type: 'aborted', requestId: 1, url: TEST_URL }])
  })

  it('signal 已中止时普通错误也按中止处理（abort 优先，绝不误报错误）', async () => {
    const controller = new AbortController()
    const { repository } = makeRepository(() => {
      controller.abort()
      return Promise.reject(new Error('boom'))
    })
    const preparer = new FakePreparer(() => Promise.resolve(makeSceneModel(1, 1)))
    const { events, emit } = collectEvents()

    await runUseCase(repository, preparer, emit, controller.signal)

    expect(events).toEqual([{ type: 'aborted', requestId: 1, url: TEST_URL }])
  })
})
