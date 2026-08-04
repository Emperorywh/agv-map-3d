/**
 * FactoryMapPageController 单元测试（SPEC §5.1、§10.3、§11；§15.1 page state 行）。
 *
 * fake ports（repository / createPreparer）注入，不依赖真实网络、Worker 与系统时间。
 * 覆盖控制器职责：URL 透传与状态机驱动、新加载取代在途请求（abort + terminate +
 * requestId 丢弃过期结果）、单次重试、dispose 幂等、WebGL 终态错误通道、
 * StrictMode start→dispose→start 序列不残留重复请求/Worker。
 */

import { describe, expect, it } from 'vitest'

import type { FactoryMapPageState } from '../application/factoryMapPageState'
import type { FactorySceneModel, GeometryBatchDto } from '../application/factorySceneModel'
import type { MapRepository } from '../application/ports/MapRepository'
import type { FactoryScenePreparer } from '../application/ports/FactoryScenePreparer'
import { MapHttpError, WebGLUnavailableError } from '../domain/errors'
import { createFactoryMapPageController } from './FactoryMapPageController'

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
  terminated = false

  decodeAndBuild(): Promise<FactorySceneModel> {
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
}

const TEST_URL = '/map.json'

function makeHarness() {
  const fetchCalls: FetchCall[] = []
  const repository: MapRepository = {
    fetchPayload(url, signal) {
      const call: FetchCall = { url, signal, deferred: deferred<ArrayBuffer>() }
      fetchCalls.push(call)
      return call.deferred.promise
    },
  }
  const preparers: FakePreparer[] = []
  const controller = createFactoryMapPageController({
    url: TEST_URL,
    ports: {
      repository,
      createPreparer: () => {
        const preparer = new FakePreparer()
        preparers.push(preparer)
        return preparer
      },
    },
  })
  const states: FactoryMapPageState[] = []
  const unsubscribe = controller.subscribe((next) => {
    states.push(next)
  })
  return { controller, fetchCalls, preparers, states, unsubscribe }
}

function makeSceneModel(nodeCount: number): FactorySceneModel {
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
    stats: { nodeCount, edgeCount: 0, arrowCount: 0, labelMetadataCount: 0 },
  }
}

/** 驱动控制器走完 loading → preparing 直至 Worker 构建挂起 */
async function driveToPreparing(harness: ReturnType<typeof makeHarness>): Promise<void> {
  harness.controller.start()
  harness.fetchCalls[0].deferred.resolve(new ArrayBuffer(8))
  await flush()
}

// ---------------------------------------------------------------------------
// 主链：URL 透传与状态机驱动
// ---------------------------------------------------------------------------

describe('控制器主链（§5.1）', () => {
  it('初始为 idle；start 后以注入 URL 发起请求，loading → preparing → ready', async () => {
    const { controller, fetchCalls, preparers, states } = makeHarness()
    expect(controller.getState()).toEqual({ status: 'idle' })
    expect(fetchCalls).toHaveLength(0)

    controller.start()
    expect(controller.getState()).toEqual({ status: 'loading', requestId: 1 })
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe(TEST_URL)

    fetchCalls[0].deferred.resolve(new ArrayBuffer(8))
    await flush()
    expect(controller.getState()).toEqual({ status: 'preparing', requestId: 1 })
    expect(preparers).toHaveLength(1)

    const model = makeSceneModel(3)
    preparers[0].decodeDeferred.resolve(model)
    await flush()
    expect(controller.getState()).toEqual({ status: 'ready', model })
    // 请求结束 Worker 单次使用即 terminate（§10.3）
    expect(preparers[0].terminated).toBe(true)

    expect(states.map((s) => s.status)).toEqual(['loading', 'preparing', 'ready'])
  })

  it('状态快照为冻结对象（useSyncExternalStore getSnapshot 缓存语义）', () => {
    const { controller } = makeHarness()
    expect(Object.isFrozen(controller.getState())).toBe(true)
    controller.start()
    expect(Object.isFrozen(controller.getState())).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 错误与重试（§11：每次只启动一个新请求）
// ---------------------------------------------------------------------------

describe('错误与单次重试（§11）', () => {
  it('fetch 失败进入 error（携带失败 URL 与 §11 错误）；retry 以同一 URL 只启动一个新请求', async () => {
    const { controller, fetchCalls } = makeHarness()
    controller.start()
    fetchCalls[0].deferred.reject(new MapHttpError('MAP_HTTP_NON_2XX', '地图请求失败：HTTP 500（/map.json）'))
    await flush()

    const errorState = controller.getState()
    expect(errorState.status).toBe('error')
    if (errorState.status !== 'error') return
    expect(errorState.error).toBeInstanceOf(MapHttpError)
    expect(errorState.url).toBe(TEST_URL)

    controller.retry()
    expect(fetchCalls).toHaveLength(2)
    expect(fetchCalls[1].url).toBe(TEST_URL)
    expect(controller.getState().status).toBe('loading')
    // loading 中再次 retry 无效：仍只有一个新请求（§11 单次重试）
    controller.retry()
    expect(fetchCalls).toHaveLength(2)
  })

  it('非 error 态 retry 无效', () => {
    const { controller, fetchCalls } = makeHarness()
    controller.retry()
    expect(fetchCalls).toHaveLength(0)
    controller.start()
    controller.retry()
    expect(fetchCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 新加载取代在途请求（§5.1、§10.3）
// ---------------------------------------------------------------------------

describe('新加载取代在途请求（§5.1 竞态规则）', () => {
  it('loading 中再次 start：abort 前一请求，过期 requestId 的结果被丢弃', async () => {
    const { controller, fetchCalls, states } = makeHarness()
    controller.start()
    controller.start()
    expect(fetchCalls).toHaveLength(2)
    expect(fetchCalls[0].signal.aborted).toBe(true)
    expect(fetchCalls[1].signal.aborted).toBe(false)

    // 旧请求迟到 resolve：requestId 已过期，不得影响新请求（§5.1）
    fetchCalls[0].deferred.resolve(new ArrayBuffer(8))
    await flush()
    expect(controller.getState()).toEqual({ status: 'loading', requestId: 2 })
    expect(states.filter((s) => s.status === 'ready')).toHaveLength(0)
  })

  it('preparing 中再次 start：terminate 旧 Worker 并为新请求新建 preparer', async () => {
    const harness = makeHarness()
    await driveToPreparing(harness)
    expect(harness.preparers).toHaveLength(1)

    harness.controller.start()
    expect(harness.preparers[0].terminated).toBe(true)
    expect(harness.fetchCalls[1].signal.aborted).toBe(false)

    harness.fetchCalls[1].deferred.resolve(new ArrayBuffer(8))
    await flush()
    expect(harness.preparers).toHaveLength(2)
    expect(harness.controller.getState()).toEqual({ status: 'preparing', requestId: 2 })

    // 旧 Worker 迟到 resolve：过期结果丢弃（§5.1）
    harness.preparers[0].decodeDeferred.resolve(makeSceneModel(9))
    await flush()
    expect(harness.controller.getState().status).toBe('preparing')
  })
})

// ---------------------------------------------------------------------------
// dispose（§10.3：页面卸载 terminate Worker；幂等）
// ---------------------------------------------------------------------------

describe('dispose 生命周期（§10.3）', () => {
  it('preparing 中 dispose：abort 请求并 terminate Worker、状态复位 idle；dispose 幂等', async () => {
    const harness = makeHarness()
    await driveToPreparing(harness)

    harness.controller.dispose()
    expect(harness.fetchCalls[0].signal.aborted).toBe(true)
    expect(harness.preparers[0].terminated).toBe(true)
    expect(harness.controller.getState()).toEqual({ status: 'idle' })

    // 幂等：再次 dispose 不重复释放、不新建资源
    harness.controller.dispose()
    expect(harness.preparers).toHaveLength(1)
    expect(harness.fetchCalls).toHaveLength(1)

    // 非活跃周期内 retry 无效（不启动新请求）
    harness.controller.retry()
    expect(harness.fetchCalls).toHaveLength(1)
  })

  it('StrictMode 序列 start → dispose → start：不残留重复请求/Worker/监听器', async () => {
    const harness = makeHarness()
    harness.controller.start()
    harness.controller.dispose()
    harness.controller.start()

    // 任一时刻至多一个在途请求：旧请求已 abort，新请求为唯一活跃者
    expect(harness.fetchCalls).toHaveLength(2)
    expect(harness.fetchCalls[0].signal.aborted).toBe(true)
    expect(harness.fetchCalls[1].signal.aborted).toBe(false)
    expect(harness.controller.getState()).toEqual({ status: 'loading', requestId: 1 })

    harness.fetchCalls[1].deferred.resolve(new ArrayBuffer(8))
    await flush()
    // 新挂载周期重建状态机：Worker 恰好一个（旧周期未进入 preparing，无遗留 Worker）
    expect(harness.preparers).toHaveLength(1)
    harness.preparers[0].decodeDeferred.resolve(makeSceneModel(2))
    await flush()
    expect(harness.controller.getState().status).toBe('ready')
    // 单一订阅通道按序收到两个挂载周期的全部转换，无丢失无重复
    expect(harness.states.map((s) => s.status)).toEqual(['loading', 'loading', 'preparing', 'ready'])
  })

  it('unsubscribe 后不再接收通知', () => {
    const { controller, states, unsubscribe } = makeHarness()
    unsubscribe()
    controller.start()
    expect(states).toHaveLength(0)
    expect(controller.getState().status).toBe('loading')
  })
})

// ---------------------------------------------------------------------------
// WebGL 终态错误通道（§11 WebGLUnavailableError 行）
// ---------------------------------------------------------------------------

describe('WebGL 终态错误（§11）', () => {
  it('reportWebGLUnavailable：进入 error 终态（携带错误与 URL），状态机就此终止', async () => {
    const harness = makeHarness()
    await driveToPreparing(harness)
    harness.preparers[0].decodeDeferred.resolve(makeSceneModel(1))
    await flush()
    expect(harness.controller.getState().status).toBe('ready')

    const webglError = new WebGLUnavailableError('WEBGL_CONTEXT_LOST', 'WebGL 渲染上下文已丢失，请刷新页面')
    harness.controller.reportWebGLUnavailable(webglError)

    const state = harness.controller.getState()
    expect(state.status).toBe('error')
    if (state.status !== 'error') return
    expect(state.error).toBe(webglError)
    expect(state.url).toBe(TEST_URL
    )
    expect(Object.isFrozen(state)).toBe(true)
    expect(harness.states.at(-1)).toBe(state)
  })

  it('首个错误优先（幂等）；此后 start/retry 无效，不再发起新请求', async () => {
    const harness = makeHarness()
    await driveToPreparing(harness)

    const first = new WebGLUnavailableError('WEBGL_CONTEXT_INIT_FAILED', '当前浏览器或硬件不支持 WebGL2')
    const second = new WebGLUnavailableError('WEBGL_CONTEXT_LOST', 'WebGL 渲染上下文已丢失')
    harness.controller.reportWebGLUnavailable(first)
    harness.controller.reportWebGLUnavailable(second)

    const state = harness.controller.getState()
    expect(state.status).toBe('error')
    if (state.status !== 'error') return
    expect(state.error).toBe(first)

    // 终态：start/retry 均不启动新请求（页面只提供「刷新页面」，§11）
    harness.controller.start()
    harness.controller.retry()
    expect(harness.fetchCalls).toHaveLength(1)
  })

  it('dispose 后 reportWebGLUnavailable 被忽略', () => {
    const { controller, states } = makeHarness()
    controller.dispose()
    controller.reportWebGLUnavailable(
      new WebGLUnavailableError('WEBGL_CONTEXT_LOST', 'WebGL 渲染上下文已丢失'),
    )
    expect(controller.getState()).toEqual({ status: 'idle' })
    expect(states).toHaveLength(0)
  })
})
