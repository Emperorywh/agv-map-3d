/**
 * WorkerScenePreparer 单元测试（SPEC §3.1、§5.1、§10.3、§11）。
 *
 * 以注入的 FakeWorker 覆盖：成功 transfer、requestId 单调递增、过期结果丢弃、
 * cancel=terminate（同步 JSON.parse 不可由取消消息中断，故不发取消消息）、
 * Worker 崩溃、协议非法、§11 错误映射、postMessage 失败、不自动重试、
 * terminate 幂等，以及 createMapBuildWorker 的 Vite module worker 接线。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FactorySceneModel } from '../../application/factorySceneModel'
import {
  MapParseError,
  MapValidationError,
} from '../../domain/errors'
import type { SceneBuildOptions } from './builders/buildFactorySceneModel'
import { runMapBuild } from './mapBuildRunner'
import {
  createMapBuildWorker,
  createWorkerScenePreparer,
} from './WorkerScenePreparer'
import type { MapBuildWorkerLike } from './WorkerScenePreparer'
import {
  createMapBuildErrorResult,
  createMapBuildSuccessResult,
} from './workerProtocol'
import type { MapBuildRequest } from './workerProtocol'

// §13 固定值内联注入（与 TASK-005 测试同一口径）
const OPTIONS: SceneBuildOptions = {
  factoryMargin: 10,
  labelAnchorY: 0.5,
  path: {
    pathWidth: 0.12,
    curveMaxError: 0.01,
    curveMaxSegment: 0.25,
    miterLimit: 2,
    chevronSpacing: 6,
    chevronMinPathLength: 1.0,
  },
  nodes: {
    stationColors: { work: '#2196F3', charge: '#8BC34A', park: '#F44336' },
  },
}

const SMALL_MAP = JSON.stringify({
  code: 200,
  message: 'ok',
  data: {
    currentMapInfoVersion: {
      mapJson: {
        nodes: [
          { id: 'n1', name: '节点1', type: 'node', x: 0, y: 0, angle: null },
          { id: 'n2', name: '节点2', type: 'node', x: 3, y: 0, angle: null },
        ],
        edges: [
          {
            id: 'e1', name: '路径1', edgeType: 'LINE',
            sx: 0, sy: 0, ex: 0.5, ey: 0,
            cx: null, cy: null, dx: null, dy: null,
            isBackEdge: false, snodeId: 'n1', enodeId: 'n2',
          },
        ],
      },
    },
  },
})

function encodeSmallMap(): ArrayBuffer {
  return new TextEncoder().encode(SMALL_MAP).buffer as ArrayBuffer
}

class FakeWorker implements MapBuildWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly posted: Array<{ message: unknown; transfer: Transferable[] }> = []
  terminateCalls = 0
  failOnPost = false

  postMessage(message: unknown, transfer: Transferable[]): void {
    if (this.failOnPost) throw new Error('postMessage failed')
    this.posted.push({ message, transfer })
  }

  terminate(): void {
    this.terminateCalls += 1
  }

  /** 模拟 Worker 回发消息 */
  emitMessage(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>)
  }

  /** 模拟 Worker 崩溃（onerror） */
  emitCrash(): void {
    this.onerror?.({ message: 'worker crashed' } as unknown as ErrorEvent)
  }

  /** 取出最近一个构建请求 */
  lastRequest(): MapBuildRequest {
    return this.posted[this.posted.length - 1].message as MapBuildRequest
  }
}

function makePreparer() {
  const worker = new FakeWorker()
  const factoryCalls: FakeWorker[] = []
  const preparer = createWorkerScenePreparer({
    createWorker: () => {
      factoryCalls.push(worker)
      return worker
    },
    buildOptions: OPTIONS,
  })
  return { preparer, worker, factoryCalls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('成功路径与 transfer（§3.1、§5.1）', () => {
  it('请求携带单调 requestId 与 options，payload 列入 transfer；经真实 runner 回环后 resolve 完整模型', async () => {
    const { preparer, worker } = makePreparer()
    const payload = encodeSmallMap()

    const promise = preparer.decodeAndBuild(payload)
    expect(worker.posted).toHaveLength(1)
    const request = worker.lastRequest()
    expect(request.type).toBe('build')
    expect(request.requestId).toBeGreaterThan(0)
    expect(request.payload).toBe(payload)
    expect(request.options).toBe(OPTIONS)
    expect(worker.posted[0].transfer).toEqual([payload])

    // 回环：真实 runner 处理请求（解码→校验→构建→错误映射），结果回发主线程
    const { message } = runMapBuild(worker.posted[0].message)
    worker.emitMessage(message)

    const model = await promise
    expect(model.stats).toEqual({ nodeCount: 2, edgeCount: 1, arrowCount: 0, labelMetadataCount: 3 })
    preparer.terminate()
  })

  it('requestId 跨 preparer 实例单调递增、不复用（§5.1）', async () => {
    const first = makePreparer()
    const second = makePreparer()
    const p1 = first.preparer.decodeAndBuild(encodeSmallMap())
    const p2 = second.preparer.decodeAndBuild(encodeSmallMap())
    const a1 = expect(p1).rejects.toMatchObject({ code: 'MAP_WORKER_TERMINATED' })
    const a2 = expect(p2).rejects.toMatchObject({ code: 'MAP_WORKER_TERMINATED' })
    const id1 = first.worker.lastRequest().requestId
    const id2 = second.worker.lastRequest().requestId
    expect(id2).toBeGreaterThan(id1)
    first.preparer.terminate()
    second.preparer.terminate()
    await Promise.all([a1, a2])
  })
})

describe('过期结果丢弃（§5.1）', () => {
  it('未知 requestId 的结果被丢弃，正确 requestId 的结果正常 resolve', async () => {
    const { preparer, worker } = makePreparer()
    const promise = preparer.decodeAndBuild(encodeSmallMap())
    let settled = false
    void promise.then(
      () => { settled = true },
      () => { settled = true },
    )

    const request = worker.lastRequest()
    worker.emitMessage({ type: 'success', requestId: request.requestId + 100, model: {} })
    await Promise.resolve()
    expect(settled).toBe(false)

    const model = buildModelFor(request)
    worker.emitMessage(createMapBuildSuccessResult(request.requestId, model).message)
    await expect(promise).resolves.toBe(model)
    preparer.terminate()
  })
})

describe('取消语义：terminate 即中断，不发取消消息（§5.1）', () => {
  it('pending 时 terminate：Worker 被 terminate，未决请求 reject SceneBuildError（MAP_WORKER_TERMINATED）', async () => {
    const { preparer, worker } = makePreparer()
    const promise = preparer.decodeAndBuild(encodeSmallMap())
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'SceneBuildError',
      code: 'MAP_WORKER_TERMINATED',
    })

    preparer.terminate()
    expect(worker.terminateCalls).toBe(1)
    // 未发送任何取消消息：同步 JSON.parse 不可由取消消息中断（§5.1）
    expect(worker.posted).toHaveLength(1)
    await assertion
  })

  it('terminate 幂等：重复调用不再 terminate Worker', () => {
    const { preparer, worker } = makePreparer()
    preparer.terminate()
    preparer.terminate()
    expect(worker.terminateCalls).toBe(1)
  })

  it('terminate 后 decodeAndBuild 立即 reject，不再 postMessage', async () => {
    const { preparer, worker } = makePreparer()
    preparer.terminate()
    await expect(preparer.decodeAndBuild(encodeSmallMap())).rejects.toMatchObject({
      name: 'SceneBuildError',
      code: 'MAP_WORKER_TERMINATED',
    })
    expect(worker.posted).toHaveLength(0)
  })
})

describe('Worker 崩溃与协议非法（§11 SceneBuildError 行）', () => {
  it('onerror → 未决请求 reject SceneBuildError（MAP_WORKER_CRASHED），且不自动重试', async () => {
    const { preparer, worker, factoryCalls } = makePreparer()
    const promise = preparer.decodeAndBuild(encodeSmallMap())
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'SceneBuildError',
      code: 'MAP_WORKER_CRASHED',
    })
    worker.emitCrash()
    await assertion
    // 不自动重试：Worker 工厂只被调用一次（§11：用户点击重试时才创建新 Worker）
    expect(factoryCalls).toHaveLength(1)
    preparer.terminate()
  })

  it('onerror 使全部未决请求失败', async () => {
    const { preparer, worker } = makePreparer()
    const p1 = preparer.decodeAndBuild(encodeSmallMap())
    const p2 = preparer.decodeAndBuild(encodeSmallMap())
    const a1 = expect(p1).rejects.toMatchObject({ code: 'MAP_WORKER_CRASHED' })
    const a2 = expect(p2).rejects.toMatchObject({ code: 'MAP_WORKER_CRASHED' })
    worker.emitCrash()
    await Promise.all([a1, a2])
    preparer.terminate()
  })

  it('协议非法结果 → SceneBuildError（MAP_WORKER_PROTOCOL_INVALID）', async () => {
    const { preparer, worker } = makePreparer()
    const promise = preparer.decodeAndBuild(encodeSmallMap())
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'SceneBuildError',
      code: 'MAP_WORKER_PROTOCOL_INVALID',
    })
    worker.emitMessage('garbage')
    await assertion
    preparer.terminate()
  })

  it('结果消息字段被 poison（getter 抛非领域错误）→ 包装为 MAP_WORKER_PROTOCOL_INVALID', async () => {
    const { preparer, worker } = makePreparer()
    const promise = preparer.decodeAndBuild(encodeSmallMap())
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'SceneBuildError',
      code: 'MAP_WORKER_PROTOCOL_INVALID',
    })
    const poisoned = Object.defineProperty({}, 'requestId', {
      get() {
        throw new TypeError('poisoned')
      },
    })
    worker.emitMessage(poisoned)
    await assertion
    preparer.terminate()
  })

  it('postMessage 抛错 → reject SceneBuildError（MAP_WORKER_CRASHED），后续请求不受影响', async () => {
    const { preparer, worker } = makePreparer()
    worker.failOnPost = true
    await expect(preparer.decodeAndBuild(encodeSmallMap())).rejects.toMatchObject({
      name: 'SceneBuildError',
      code: 'MAP_WORKER_CRASHED',
    })

    worker.failOnPost = false
    const promise = preparer.decodeAndBuild(encodeSmallMap())
    const request = worker.lastRequest()
    const model = buildModelFor(request)
    worker.emitMessage(createMapBuildSuccessResult(request.requestId, model).message)
    await expect(promise).resolves.toBe(model)
    preparer.terminate()
  })
})

describe('错误结果映射（§11：跨线程恢复错误类型）', () => {
  it('MapValidationError：instanceof、code、fieldPath、totalCount 保真', async () => {
    const { preparer, worker } = makePreparer()
    const promise = preparer.decodeAndBuild(encodeSmallMap())
    const request = worker.lastRequest()
    const { message } = createMapBuildErrorResult(
      request.requestId,
      new MapValidationError('MAP_NODE_TYPE_INVALID', '节点类型非法', {
        fieldPath: 'nodes[17].type',
        totalCount: 5,
      }),
    )
    worker.emitMessage(message)

    let caught: unknown
    try {
      await promise
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(MapValidationError)
    const validation = caught as MapValidationError
    expect(validation.code).toBe('MAP_NODE_TYPE_INVALID')
    expect(validation.fieldPath).toBe('nodes[17].type')
    expect(validation.totalCount).toBe(5)
    preparer.terminate()
  })

  it('MapParseError：reject 值是 FactoryMapError（用例透传 §11 错误，不误报 Worker 崩溃）', async () => {
    const { preparer, worker } = makePreparer()
    const promise = preparer.decodeAndBuild(encodeSmallMap())
    const request = worker.lastRequest()
    const { message } = runMapBuild({
      ...request,
      payload: new TextEncoder().encode('{ not json').buffer as ArrayBuffer,
    })
    worker.emitMessage(message)
    await expect(promise).rejects.toBeInstanceOf(MapParseError)
    preparer.terminate()
  })
})

describe('createMapBuildWorker（浏览器组合根接线）', () => {
  it('以 new URL + type: module 构造 Vite module worker', () => {
    class StubWorker {
      static instances: Array<{ url: string; options: { type: string } }> = []

      constructor(url: URL, options: { type: string }) {
        StubWorker.instances.push({ url: String(url), options })
      }
    }
    vi.stubGlobal('Worker', StubWorker)

    createMapBuildWorker()

    expect(StubWorker.instances).toHaveLength(1)
    expect(StubWorker.instances[0].url).toContain('mapBuild.worker')
    expect(StubWorker.instances[0].options).toEqual({ type: 'module' })
  })
})

/** 用真实 runner 为请求构建成功模型（保持测试与实现同一条构建管线） */
function buildModelFor(request: MapBuildRequest): FactorySceneModel {
  const { message } = runMapBuild(request)
  if (message.type !== 'success') throw new Error('夹具构建失败')
  return message.model
}
