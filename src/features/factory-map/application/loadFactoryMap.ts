/**
 * 加载工厂地图用例：fetch → prepare 单一编排（SPEC §5.1、§11）。
 *
 * 端口注入，不依赖 React/Three/infrastructure 实现；
 * 输出状态转换事件（FactoryMapLoadEvent），由页面状态机消费：
 * - fetch 完成前不创建 Worker（失败快速路径零 Worker 开销）
 * - preparing 事件把 preparer 句柄注册给状态机，此后取代/卸载由状态机 terminate
 * - 中止（AbortError 语义）只发 aborted 事件，绝不误报为错误（§5.1）
 * - 端口 reject 的 §11 领域错误原样透传；未知异常按阶段映射为
 *   MapNetworkError（fetch）/ SceneBuildError（prepare）
 *
 * 每次执行恰好发出一个终止事件（succeeded / failed / aborted 之一），
 * 之前至多发出一个 preparing 事件；emit 不得抛出。requestId 的竞态丢弃由
 * 状态机负责，用例自身不 reject。
 */

import { FactoryMapError, MapNetworkError, SceneBuildError } from '../domain/errors'
import type { FactorySceneModel } from './factorySceneModel'
import type { FactoryScenePreparer } from './ports/FactoryScenePreparer'
import type { MapRepository } from './ports/MapRepository'

export interface LoadFactoryMapPorts {
  readonly repository: MapRepository
  /** 每次加载创建新 preparer（§5.1：被取代的 Worker 直接 terminate，不复用） */
  readonly createPreparer: () => FactoryScenePreparer
}

export interface LoadFactoryMapOptions {
  readonly url: string
  /** 单调递增请求号，由状态机分配；事件原样携带，供丢弃竞态过期结果 */
  readonly requestId: number
  /** 状态机持有的中止信号：新加载/重试/卸载时中止本请求 */
  readonly signal: AbortSignal
}

/** 用例输出的状态转换事件（SPEC §5.1 状态语义：loading=网络请求中，preparing=Worker 校验构建中） */
export type FactoryMapLoadEvent =
  | {
      readonly type: 'preparing'
      readonly requestId: number
      /** 本次加载新建的 Worker 句柄，注册给状态机用于取代时 terminate */
      readonly preparer: FactoryScenePreparer
    }
  | { readonly type: 'succeeded'; readonly requestId: number; readonly model: FactorySceneModel }
  | {
      readonly type: 'failed'
      readonly requestId: number
      readonly error: FactoryMapError
      /** 失败的请求 URL，供错误态展示与重试复用 */
      readonly url: string
    }
  | {
      readonly type: 'aborted'
      readonly requestId: number
      readonly url: string
    }

export type FactoryMapLoadEventEmitter = (event: FactoryMapLoadEvent) => void

type LoadPhase = 'fetch' | 'prepare'

/** 中止识别：信号已中止，或 reject 值为 AbortError（含信号不可观察的外部中止） */
function isAbortRejection(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

/** 未知异常按阶段映射为 §11 领域错误；领域错误原样透传 */
function toFactoryMapError(error: unknown, phase: LoadPhase): FactoryMapError {
  if (error instanceof FactoryMapError) return error
  if (phase === 'fetch') {
    return new MapNetworkError('MAP_NETWORK_UNEXPECTED', '地图数据请求发生意外错误', { cause: error })
  }
  return new SceneBuildError('MAP_WORKER_CRASHED', '场景构建发生意外错误（Worker 崩溃或协议异常）', {
    cause: error,
  })
}

/** 执行一次 fetch → prepare 编排；结局与事件契约见文件头 */
export async function loadFactoryMap(
  ports: LoadFactoryMapPorts,
  options: LoadFactoryMapOptions,
  emit: FactoryMapLoadEventEmitter,
): Promise<void> {
  const { repository, createPreparer } = ports
  const { url, requestId, signal } = options

  const emitRejection = (error: unknown, phase: LoadPhase): void => {
    if (isAbortRejection(error, signal)) {
      emit({ type: 'aborted', requestId, url })
      return
    }
    emit({ type: 'failed', requestId, error: toFactoryMapError(error, phase), url })
  }

  let payload: ArrayBuffer
  try {
    payload = await repository.fetchPayload(url, signal)
  } catch (error) {
    emitRejection(error, 'fetch')
    return
  }

  // fetch 完成后请求才被取代：不创建 Worker，直接按中止收尾（§5.1）
  if (signal.aborted) {
    emit({ type: 'aborted', requestId, url })
    return
  }

  // 每次加载创建新 Worker；preparing 事件把句柄注册给状态机，
  // 此后取代/页面卸载由状态机 terminate（§5.1、§10.3）
  let preparer: FactoryScenePreparer
  try {
    preparer = createPreparer()
  } catch (error) {
    emitRejection(error, 'prepare')
    return
  }
  emit({ type: 'preparing', requestId, preparer })

  try {
    const model = await preparer.decodeAndBuild(payload)
    if (signal.aborted) {
      // prepare 期间被取代：过期结果不发 succeeded
      emit({ type: 'aborted', requestId, url })
      return
    }
    emit({ type: 'succeeded', requestId, model })
  } catch (error) {
    emitRejection(error, 'prepare')
  }
}
