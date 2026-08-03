/**
 * 工厂地图页面状态机（SPEC §5.1、§11、§15.1 page state 行）。
 *
 * 页面状态为单一显式判别联合 idle | loading | preparing | ready | empty | error，
 * 不使用多个布尔值组合隐式状态；loading=网络请求中，preparing=Worker 校验构建中。
 *
 * 合法转换：
 * - 任意 → loading：startLoad（首次加载/地图切换）。进入新一轮加载前必须先
 *   abort 前一请求的 fetch、terminate 正在 preparing 的 Worker（同步 JSON.parse
 *   不可由取消消息中断，§5.1），不保留旧 SceneModel 作为隐式 fallback（§11）
 * - loading → preparing：fetch 完成，用例注册本次新建的 Worker 句柄
 * - preparing → ready | empty：构建完成；nodes 与 edges 同时为空 → empty
 *   （empty 携带完整 FactorySceneModel：批次为空且 bounds 为 60×40m）
 * - loading/preparing → error：§11 领域错误；请求被非当前流程意外中断 →
 *   MapNetworkError（MAP_REQUEST_INTERRUPTED）
 * - error → loading：retry。重试仅 error 态可用（loading/preparing 中禁用，
 *   §11），每次只启动一个新请求
 *
 * 竞态防护：requestId 单调递增，非当前 requestId 的用例事件一律丢弃；
 * 用例保证每次执行恰好一个终止事件（见 loadFactoryMap.ts）。
 * 资源所有权（§10.3）：Worker 单次使用——请求结束（成功/失败/中断）即 terminate，
 * 被取代或 dispose 时 terminate；dispose 幂等。
 */

import { MapNetworkError } from '../domain/errors'
import type { FactoryMapError } from '../domain/errors'
import { isEmptySceneModel } from './factorySceneModel'
import type { FactorySceneModel } from './factorySceneModel'
import type { FactoryMapLoadEvent, LoadFactoryMapPorts } from './loadFactoryMap'
import { loadFactoryMap } from './loadFactoryMap'
import type { FactoryScenePreparer } from './ports/FactoryScenePreparer'

// ---------------------------------------------------------------------------
// 显式判别联合（§5.1）
// ---------------------------------------------------------------------------

export interface FactoryMapPageIdleState {
  readonly status: 'idle'
}

export interface FactoryMapPageLoadingState {
  readonly status: 'loading'
  readonly requestId: number
}

export interface FactoryMapPagePreparingState {
  readonly status: 'preparing'
  readonly requestId: number
}

export interface FactoryMapPageReadyState {
  readonly status: 'ready'
  readonly model: FactorySceneModel
}

export interface FactoryMapPageEmptyState {
  readonly status: 'empty'
  readonly model: FactorySceneModel
}

export interface FactoryMapPageErrorState {
  readonly status: 'error'
  /** §11 统一错误信息：稳定错误码、字段路径与简体中文摘要 */
  readonly error: FactoryMapError
  /** 本次失败的请求 URL，重试原样复用 */
  readonly url: string
}

export type FactoryMapPageState =
  | FactoryMapPageIdleState
  | FactoryMapPageLoadingState
  | FactoryMapPagePreparingState
  | FactoryMapPageReadyState
  | FactoryMapPageEmptyState
  | FactoryMapPageErrorState

export type FactoryMapPageStatus = FactoryMapPageState['status']

export const initialFactoryMapPageState: FactoryMapPageState = Object.freeze({ status: 'idle' })

/** §11：重试按钮仅 error 态可用；loading/preparing 中禁用，避免并发隐式状态 */
export function canRetryFactoryMap(state: FactoryMapPageState): boolean {
  return state.status === 'error'
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

export type FactoryMapPageStateMachinePorts = LoadFactoryMapPorts

export interface FactoryMapPageStateMachine {
  /** 当前状态快照（与 subscribe 组合即 useSyncExternalStore 语义） */
  getState(): FactoryMapPageState
  /** 订阅状态变化；返回退订函数 */
  subscribe(listener: (state: FactoryMapPageState) => void): () => void
  /**
   * 开始新一轮加载（首次加载或地图切换）：先 abort 前一请求、terminate 正在
   * preparing 的 Worker，再以单调递增 requestId 进入 loading。
   */
  startLoad(url: string): void
  /** 重试：仅 error 态生效（§11），每次调用只启动一个新请求 */
  retry(): void
  /** 页面卸载：abort 请求、terminate Worker；幂等（§10.3） */
  dispose(): void
}

export function createFactoryMapPageStateMachine(
  ports: FactoryMapPageStateMachinePorts,
): FactoryMapPageStateMachine {
  let state: FactoryMapPageState = initialFactoryMapPageState
  let lastRequestId = 0
  // 在途请求句柄：controller 非 null ⟺ 存在在途请求；
  // preparer 非 null ⟺ 已进入 preparing（存在需要 terminate 的 Worker，§5.1 标记语义）
  let controller: AbortController | null = null
  let preparer: FactoryScenePreparer | null = null
  let disposed = false
  const listeners = new Set<(state: FactoryMapPageState) => void>()

  const setState = (next: FactoryMapPageState): void => {
    state = Object.freeze(next)
    for (const listener of listeners) listener(state)
  }

  /** 中止在途请求（§5.1：新加载/重试/卸载前必须执行） */
  const cancelInFlight = (): void => {
    controller?.abort()
    preparer?.terminate()
    controller = null
    preparer = null
  }

  /** 请求结束：Worker 单次使用，使命完成即 terminate，等待下次加载新建 */
  const settleInFlight = (): void => {
    preparer?.terminate()
    controller = null
    preparer = null
  }

  const applyEvent = (event: FactoryMapLoadEvent): void => {
    if (disposed) return
    if (event.requestId !== lastRequestId) {
      // 竞态过期结果：非当前 requestId 的事件一律丢弃（§5.1）
      return
    }
    switch (event.type) {
      case 'preparing':
        // 标记：此后取消须 terminate 该 Worker（§5.1）
        preparer = event.preparer
        setState({ status: 'preparing', requestId: event.requestId })
        break
      case 'succeeded': {
        const { model } = event
        settleInFlight()
        // §11：nodes 与 edges 同时为空 → empty；empty 批次为空且 bounds 60×40m
        setState(isEmptySceneModel(model) ? { status: 'empty', model } : { status: 'ready', model })
        break
      }
      case 'failed':
        settleInFlight()
        setState({ status: 'error', error: event.error, url: event.url })
        break
      case 'aborted':
        // 状态机只中止被取代/卸载的请求（其 requestId 已过期，不会走到这里）；
        // 当前在途请求收到 aborted 说明请求被非当前流程意外中断（§11 MapNetworkError 行）
        settleInFlight()
        setState({
          status: 'error',
          error: new MapNetworkError('MAP_REQUEST_INTERRUPTED', '地图请求被意外中断'),
          url: event.url,
        })
        break
    }
  }

  const beginLoad = (url: string): void => {
    cancelInFlight()
    lastRequestId += 1
    const requestId = lastRequestId
    controller = new AbortController()
    setState({ status: 'loading', requestId })
    void loadFactoryMap(
      ports,
      { url, requestId, signal: controller.signal },
      applyEvent,
    )
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    startLoad(url: string) {
      if (disposed) return
      beginLoad(url)
    },
    retry() {
      if (disposed) return
      if (state.status !== 'error') return
      beginLoad(state.url)
    },
    dispose() {
      if (disposed) return
      disposed = true
      cancelInFlight()
      listeners.clear()
    },
  }
}
