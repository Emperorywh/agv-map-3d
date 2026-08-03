import { describe, expect, it } from 'vitest'

import { deriveFactoryBounds } from '../domain/bounds'
import { MapHttpError, MapNetworkError, MapValidationError } from '../domain/errors'
import type { FactorySceneModel, GeometryBatchDto } from './factorySceneModel'
import { toFactoryBoundsDto } from './factorySceneModel'
import type { FactoryMapPageState } from './factoryMapPageState'
import {
  canRetryFactoryMap,
  createFactoryMapPageStateMachine,
} from './factoryMapPageState'
import type { FactoryScenePreparer } from './ports/FactoryScenePreparer'
import type { MapRepository } from './ports/MapRepository'

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  let reject: (reason: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 宏任务冲刷：排空全部挂起的微任务链（非定时等待，不依赖系统时间） */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

class FakePreparer implements FactoryScenePreparer {
  readonly decodeDeferred = deferred<FactorySceneModel>()
  decodePayloads: ArrayBuffer[] = []
  terminated = false

  decodeAndBuild(payload: ArrayBuffer): Promise<FactorySceneModel> {
    this.decodePayloads.push(payload)
    return this.decodeDeferred.promise
  }

  terminate(): void {
    this.terminated = true
  }
}

interface FetchCall {
  url: string
  signal: AbortSignal
  deferred: Deferred<ArrayBuffer>
  /** 本次 fetch 发起时，此前全部请求信号均已中止（验证"新加载先 abort 前一请求"） */
  previousSignalsAborted: boolean
}

function makeHarness() {
  const fetchCalls: FetchCall[] = []
  const repository: MapRepository = {
    fetchPayload(url, signal) {
      const previousSignalsAborted = fetchCalls.every((call) => call.signal.aborted)
      const call: FetchCall = { url, signal, deferred: deferred<ArrayBuffer>(), previousSignalsAborted }
      fetchCalls.push(call)
      return call.deferred.promise
    },
  }
  const preparers: FakePreparer[] = []
  const machine = createFactoryMapPageStateMachine({
    repository,
    createPreparer: () => {
      const preparer = new FakePreparer()
      preparers.push(preparer)
      return preparer
    },
  })
  const states: FactoryMapPageState[] = []
  machine.subscribe((next) => {
    states.push(next)
  })
  return { machine, fetchCalls, preparers, states }
}

function makeSceneModel(nodeCount: number, edgeCount: number): FactorySceneModel {
  const geometry: GeometryBatchDto = {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
  }
  return {
    bounds: { innerMinX: -10, innerMaxX: 10, innerMinZ: -5, innerMaxZ: 5, centerX: 0, centerZ: 0 },
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

/** 空态模型：批次为空且 bounds 为 60×40m（domain/bounds.ts 空场景尺寸，§6.1、§11） */
function makeEmptySceneModel(): FactorySceneModel {
  const model = makeSceneModel(0, 0)
  // FACTORY_MARGIN=10（config/sceneMetrics.ts），测试内联固定值；空态 bounds 与 margin 无关
  return { ...model, bounds: toFactoryBoundsDto(deriveFactoryBounds(null, 10)) }
}

// ---------------------------------------------------------------------------
// 判别联合结构（SPEC §5.1：无多个布尔值组合隐式状态）
// ---------------------------------------------------------------------------

describe('页面状态判别联合结构（SPEC §5.1）', () => {
  it('初始状态为 idle，仅含 status 判别字段，对象冻结', () => {
    const { machine, states } = makeHarness()
    expect(machine.getState()).toEqual({ status: 'idle' })
    expect(Object.keys(machine.getState())).toEqual(['status'])
    expect(Object.isFrozen(machine.getState())).toBe(true)
    expect(canRetryFactoryMap(machine.getState())).toBe(false)
    expect(states).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 合法转换：idle → loading → preparing → ready / empty / error
// ---------------------------------------------------------------------------

describe('状态转换主链（SPEC §5.1、§15.1 page state 行）', () => {
  it('idle → loading → preparing → ready：ready 携带完整 FactorySceneModel', async () => {
    const { machine, fetchCalls, preparers, states } = makeHarness()

    machine.startLoad('/map.json')
    const loading = machine.getState()
    expect(loading).toEqual({ status: 'loading', requestId: 1 })
    expect(Object.keys(loading).sort()).toEqual(['requestId', 'status'])
    expect(canRetryFactoryMap(loading)).toBe(false)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('/map.json')
    expect(fetchCalls[0].signal.aborted).toBe(false)

    const payload = new ArrayBuffer(16)
    fetchCalls[0].deferred.resolve(payload)
    await flush()
    const preparing = machine.getState()
    expect(preparing).toEqual({ status: 'preparing', requestId: 1 })
    expect(preparers).toHaveLength(1)
    expect(preparers[0].decodePayloads[0]).toBe(payload)

    const model = makeSceneModel(3, 2)
    preparers[0].decodeDeferred.resolve(model)
    await flush()
    const ready = machine.getState()
    if (ready.status !== 'ready') throw new Error('应为 ready 状态')
    expect(ready.model).toBe(model)
    expect(Object.keys(ready).sort()).toEqual(['model', 'status'])
    expect(preparers[0].terminated).toBe(true) // Worker 单次使用：ready 后释放（§10.3）
    expect(states.map((s) => s.status)).toEqual(['loading', 'preparing', 'ready'])
  })

  it('空图 → empty：携带完整模型，批次为空且 bounds 为 60×40m（§11、§6.1）', async () => {
    const { machine, fetchCalls, preparers } = makeHarness()
    machine.startLoad('/map.json')
    fetchCalls[0].deferred.resolve(new ArrayBuffer(2))
    await flush()

    const emptyModel = makeEmptySceneModel()
    preparers[0].decodeDeferred.resolve(emptyModel)
    await flush()

    const state = machine.getState()
    if (state.status !== 'empty') throw new Error('应为 empty 状态')
    expect(state.model).toBe(emptyModel)
    const { bounds } = state.model
    expect(bounds.innerMaxX - bounds.innerMinX).toBe(60)
    expect(bounds.innerMaxZ - bounds.innerMinZ).toBe(40)
    expect(bounds.centerX).toBe(0)
    expect(bounds.centerZ).toBe(0)
    expect(state.model.paths.forward.positions).toHaveLength(0)
    expect(state.model.paths.backward.indices).toHaveLength(0)
    expect(state.model.arrows.forward.matrices).toHaveLength(0)
    expect(state.model.nodes.dots.matrices).toHaveLength(0)
    expect(state.model.nodes.rings.colors).toHaveLength(0)
    expect(state.model.labels).toHaveLength(0)
  })

  it('fetch 失败 → error：携带 §11 错误对象与失败 URL，fetch 失败不创建 Worker', async () => {
    const { machine, fetchCalls, preparers } = makeHarness()
    machine.startLoad('/map.json')

    const error = new MapHttpError('MAP_HTTP_NON_2XX', 'HTTP 404', { fieldPath: '/map.json' })
    fetchCalls[0].deferred.reject(error)
    await flush()

    const state = machine.getState()
    if (state.status !== 'error') throw new Error('应为 error 状态')
    expect(state.error).toBe(error)
    expect(state.url).toBe('/map.json')
    expect(Object.keys(state).sort()).toEqual(['error', 'status', 'url'])
    expect(preparers).toHaveLength(0)
    expect(canRetryFactoryMap(state)).toBe(true)
  })

  it('prepare 失败 → error 并终止当前 Worker（§11：不渲染部分地图）', async () => {
    const { machine, fetchCalls, preparers } = makeHarness()
    machine.startLoad('/map.json')
    fetchCalls[0].deferred.resolve(new ArrayBuffer(4))
    await flush()

    const error = new MapValidationError('MAP_NODE_TYPE_INVALID', '非法节点类型', {
      fieldPath: 'nodes[17].type',
      totalCount: 1,
    })
    preparers[0].decodeDeferred.reject(error)
    await flush()

    const state = machine.getState()
    if (state.status !== 'error') throw new Error('应为 error 状态')
    expect(state.error).toBe(error)
    expect(preparers[0].terminated).toBe(true)
  })

  it('当前请求被非当前流程意外中断 → error(MapNetworkError MAP_REQUEST_INTERRUPTED)（§11）', async () => {
    const { machine, fetchCalls } = makeHarness()
    machine.startLoad('/map.json')

    // 外部中断：状态机未中止 signal，但 fetch 以 AbortError reject
    fetchCalls[0].deferred.reject(new DOMException('The operation was aborted', 'AbortError'))
    await flush()

    const state = machine.getState()
    if (state.status !== 'error') throw new Error('应为 error 状态')
    expect(state.error).toBeInstanceOf(MapNetworkError)
    expect(state.error.code).toBe('MAP_REQUEST_INTERRUPTED')
    expect(state.url).toBe('/map.json')
  })
})

// ---------------------------------------------------------------------------
// 取代语义：abort 前请求、terminate Worker、单调 requestId 丢弃过期结果
// ---------------------------------------------------------------------------

describe('新加载取代前请求（SPEC §5.1）', () => {
  it('loading 中新加载：先 abort 前一请求再发起新请求，旧请求迟到结果被丢弃', async () => {
    const { machine, fetchCalls, preparers } = makeHarness()
    machine.startLoad('/a.json')
    machine.startLoad('/b.json')

    expect(fetchCalls).toHaveLength(2)
    expect(fetchCalls[1].previousSignalsAborted).toBe(true)
    expect(fetchCalls[0].signal.aborted).toBe(true)
    expect(fetchCalls[1].signal.aborted).toBe(false)
    expect(machine.getState()).toEqual({ status: 'loading', requestId: 2 })

    // 旧请求的迟到中止回执被单调 requestId 丢弃，不影响新请求、不误报错误
    fetchCalls[0].deferred.reject(new DOMException('已中止', 'AbortError'))
    await flush()
    expect(machine.getState()).toEqual({ status: 'loading', requestId: 2 })

    // 新请求完整走完；旧请求 fetch 未完成，不曾创建 Worker
    const model = makeSceneModel(1, 1)
    fetchCalls[1].deferred.resolve(new ArrayBuffer(4))
    await flush()
    preparers[0].decodeDeferred.resolve(model)
    await flush()
    const state = machine.getState()
    if (state.status !== 'ready') throw new Error('应为 ready 状态')
    expect(state.model).toBe(model)
    expect(preparers).toHaveLength(1)
  })

  it('loading 中新加载：旧请求迟到的 fetch 成功同样被丢弃，且不为旧请求创建 Worker', async () => {
    const { machine, fetchCalls, preparers } = makeHarness()
    machine.startLoad('/a.json')
    machine.startLoad('/b.json')

    fetchCalls[0].deferred.resolve(new ArrayBuffer(4))
    await flush()
    expect(machine.getState()).toEqual({ status: 'loading', requestId: 2 })
    expect(preparers).toHaveLength(0)

    fetchCalls[1].deferred.resolve(new ArrayBuffer(8))
    await flush()
    expect(preparers).toHaveLength(1)
    expect(machine.getState()).toEqual({ status: 'preparing', requestId: 2 })
  })

  it('preparing 中新加载：同步 terminate 当前 Worker、新建 Worker 服务新请求，旧结果丢弃', async () => {
    const { machine, fetchCalls, preparers } = makeHarness()
    machine.startLoad('/a.json')
    fetchCalls[0].deferred.resolve(new ArrayBuffer(4))
    await flush()
    expect(machine.getState()).toEqual({ status: 'preparing', requestId: 1 })
    expect(preparers).toHaveLength(1)

    machine.startLoad('/b.json')
    // terminate 是新加载的同步前置动作（§5.1：同步 JSON.parse 不可由取消消息中断）
    expect(preparers[0].terminated).toBe(true)
    expect(fetchCalls[0].signal.aborted).toBe(true)
    expect(machine.getState()).toEqual({ status: 'loading', requestId: 2 })

    // 被 terminate 的旧 Worker 即使迟到 resolve，结果也被 requestId 丢弃
    preparers[0].decodeDeferred.resolve(makeSceneModel(9, 9))
    await flush()
    expect(machine.getState()).toEqual({ status: 'loading', requestId: 2 })

    // 新请求使用全新 Worker 完成（不复用，§5.1）
    const model = makeSceneModel(2, 2)
    fetchCalls[1].deferred.resolve(new ArrayBuffer(8))
    await flush()
    expect(preparers).toHaveLength(2)
    expect(preparers[1]).not.toBe(preparers[0])
    preparers[1].decodeDeferred.resolve(model)
    await flush()
    const state = machine.getState()
    if (state.status !== 'ready') throw new Error('应为 ready 状态')
    expect(state.model).toBe(model)
  })

  it('requestId 随每次新加载单调递增', () => {
    const { machine } = makeHarness()
    machine.startLoad('/a.json')
    expect(machine.getState()).toEqual({ status: 'loading', requestId: 1 })
    machine.startLoad('/b.json')
    expect(machine.getState()).toEqual({ status: 'loading', requestId: 2 })
    machine.startLoad('/c.json')
    expect(machine.getState()).toEqual({ status: 'loading', requestId: 3 })
  })
})

// ---------------------------------------------------------------------------
// 重试（§11：每次只启一个新请求；loading/preparing 中禁用）
// ---------------------------------------------------------------------------

describe('重试（SPEC §11）', () => {
  it('error 态 retry：复用失败 URL 且每次只启动一个新请求', async () => {
    const { machine, fetchCalls } = makeHarness()
    machine.startLoad('/map.json')
    fetchCalls[0].deferred.reject(new MapHttpError('MAP_HTTP_NON_2XX', 'HTTP 500'))
    await flush()
    expect(machine.getState().status).toBe('error')

    machine.retry()
    expect(fetchCalls).toHaveLength(2)
    expect(fetchCalls[1].url).toBe('/map.json')
    // 前一请求已失败结束（不在途），无需 abort；新请求信号未被中止
    expect(fetchCalls[1].signal.aborted).toBe(false)
    expect(machine.getState()).toEqual({ status: 'loading', requestId: 2 })

    fetchCalls[1].deferred.reject(new MapNetworkError('MAP_NETWORK_FAILURE', '网络失败'))
    await flush()
    expect(machine.getState().status).toBe('error')

    machine.retry()
    expect(fetchCalls).toHaveLength(3)
    expect(machine.getState()).toEqual({ status: 'loading', requestId: 3 })
  })

  it('loading/preparing 中 retry 禁用：不产生新请求、不改变状态、不新建 Worker', async () => {
    const { machine, fetchCalls, preparers } = makeHarness()
    machine.startLoad('/map.json')

    const loading = machine.getState()
    machine.retry()
    expect(fetchCalls).toHaveLength(1)
    expect(machine.getState()).toBe(loading)

    fetchCalls[0].deferred.resolve(new ArrayBuffer(4))
    await flush()
    const preparing = machine.getState()
    machine.retry()
    expect(fetchCalls).toHaveLength(1)
    expect(preparers).toHaveLength(1)
    expect(machine.getState()).toBe(preparing)
  })

  it('idle/ready 态 retry 无效（重试按钮只存在于 error 视图）', async () => {
    const idleHarness = makeHarness()
    idleHarness.machine.retry()
    expect(idleHarness.fetchCalls).toHaveLength(0)
    expect(idleHarness.machine.getState().status).toBe('idle')

    const { machine, fetchCalls, preparers } = makeHarness()
    machine.startLoad('/map.json')
    fetchCalls[0].deferred.resolve(new ArrayBuffer(4))
    await flush()
    preparers[0].decodeDeferred.resolve(makeSceneModel(1, 1))
    await flush()
    const ready = machine.getState()
    expect(ready.status).toBe('ready')

    machine.retry()
    expect(fetchCalls).toHaveLength(1)
    expect(machine.getState()).toBe(ready)
  })

  it('dispose 后 retry 无效', async () => {
    const { machine, fetchCalls } = makeHarness()
    machine.startLoad('/map.json')
    fetchCalls[0].deferred.reject(new MapNetworkError('MAP_NETWORK_FAILURE', '网络失败'))
    await flush()
    machine.dispose()
    machine.retry()
    expect(fetchCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 生命周期与订阅
// ---------------------------------------------------------------------------

describe('dispose 与订阅（SPEC §10.3）', () => {
  it('loading 中 dispose：abort 在途请求，迟到结果被忽略；dispose 幂等；此后 startLoad 无效', async () => {
    const { machine, fetchCalls, preparers, states } = makeHarness()
    machine.startLoad('/map.json')
    machine.dispose()
    machine.dispose()

    expect(fetchCalls[0].signal.aborted).toBe(true)
    expect(preparers).toHaveLength(0)

    fetchCalls[0].deferred.resolve(new ArrayBuffer(4))
    await flush()
    expect(machine.getState()).toEqual({ status: 'loading', requestId: 1 })

    machine.startLoad('/other.json')
    expect(fetchCalls).toHaveLength(1)
    expect(states.map((s) => s.status)).toEqual(['loading'])
  })

  it('preparing 中 dispose：terminate 当前 Worker，旧 Worker 迟到结果被忽略', async () => {
    const { machine, fetchCalls, preparers } = makeHarness()
    machine.startLoad('/map.json')
    fetchCalls[0].deferred.resolve(new ArrayBuffer(4))
    await flush()

    machine.dispose()
    expect(preparers[0].terminated).toBe(true)
    expect(fetchCalls[0].signal.aborted).toBe(true)

    preparers[0].decodeDeferred.resolve(makeSceneModel(1, 1))
    await flush()
    expect(machine.getState()).toEqual({ status: 'preparing', requestId: 1 })
  })

  it('subscribe 推送每次状态变化，退订后停止', async () => {
    const { machine, fetchCalls } = makeHarness()
    const seen: string[] = []
    const unsubscribe = machine.subscribe((next) => {
      seen.push(next.status)
    })

    machine.startLoad('/map.json')
    fetchCalls[0].deferred.reject(new MapNetworkError('MAP_NETWORK_FAILURE', '网络失败'))
    await flush()
    expect(seen).toEqual(['loading', 'error'])

    unsubscribe()
    machine.retry()
    expect(seen).toEqual(['loading', 'error'])
  })
})
