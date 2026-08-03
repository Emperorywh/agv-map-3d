/**
 * FactoryScenePreparer 端口的 Worker 实现（SPEC §3.1、§5.1、§10.3、§11）。
 *
 * - 每个 preparer 实例独占一个 Worker（构造时经注入工厂创建）；每次加载由
 *   用例创建新 preparer，被取代/卸载时 terminate——同步 JSON.parse 不能由
 *   取消消息中断，取消语义就是 terminate + 新建（§5.1），本模块不提供
 *   取消消息通道
 * - requestId 进程内单调递增（跨实例不复用）；结果按 requestId 匹配，
 *   过期或未知 requestId 的结果一律丢弃（§5.1）
 * - Worker onerror（崩溃）与协议非法结果 → SceneBuildError（§11）；
 *   崩溃后不自动重试——重试由用户触发，状态机创建新 preparer/Worker（§11）
 * - terminate 幂等；terminate 时未决的 decodeAndBuild 以 SceneBuildError
 *   （MAP_WORKER_TERMINATED）reject，之后该实例拒绝新请求（§10.3）
 *
 * 主线程 binder 的逐字段再校验（§5.1）在 rendering/core（后续任务），
 * 本模块只保证协议形状合法。
 */

import type { FactoryScenePreparer } from '../../application/ports/FactoryScenePreparer'
import type { FactorySceneModel } from '../../application/factorySceneModel'
import { SceneBuildError } from '../../domain/errors'
import type { SceneBuildOptions } from './builders/buildFactorySceneModel'
import { createMapBuildRequest, deserializeMapError, parseMapBuildResult } from './workerProtocol'

/**
 * 与 Dedicated Worker 通信所需的最小结构。
 * 浏览器组合根注入 createMapBuildWorker 的真实 Worker；测试注入 fake，
 * 保持 node 环境可测（不依赖 Worker 全局）。
 */
export interface MapBuildWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: unknown, transfer: Transferable[]): void
  terminate(): void
}

export interface WorkerScenePreparerOptions {
  /** 创建本次加载独占的 Worker（每次调用必须返回新实例） */
  readonly createWorker: () => MapBuildWorkerLike
  /** §13 场景构建选项（presentation 从 config 层注入；infrastructure 不反向依赖 config） */
  readonly buildOptions: SceneBuildOptions
}

/**
 * 浏览器组合根使用的真实 Worker 工厂（Vite module worker 打包入口）。
 * 测试经 WorkerScenePreparerOptions.createWorker 注入 fake，不调用本函数。
 */
export function createMapBuildWorker(): MapBuildWorkerLike {
  return new Worker(new URL('./mapBuild.worker.ts', import.meta.url), { type: 'module' })
}

/** 进程内单调递增 requestId：跨 preparer 实例保持单调，绝不复用（§5.1） */
let lastMapBuildRequestId = 0

interface PendingBuild {
  readonly resolve: (model: FactorySceneModel) => void
  readonly reject: (error: unknown) => void
}

export function createWorkerScenePreparer(options: WorkerScenePreparerOptions): FactoryScenePreparer {
  const worker = options.createWorker()
  const pending = new Map<number, PendingBuild>()
  let terminated = false

  /** 使全部未决请求失败（崩溃/协议非法/终止场景） */
  const failAllPending = (error: SceneBuildError): void => {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }

  worker.onmessage = (event: MessageEvent<unknown>): void => {
    let result
    try {
      result = parseMapBuildResult(event.data)
    } catch (error) {
      failAllPending(
        error instanceof SceneBuildError
          ? error
          : new SceneBuildError('MAP_WORKER_PROTOCOL_INVALID', 'Worker 构建结果无法解析', {
              cause: error,
            }),
      )
      return
    }
    const entry = pending.get(result.requestId)
    if (entry === undefined) {
      // 过期或未知 requestId：竞态结果一律丢弃（§5.1）
      return
    }
    pending.delete(result.requestId)
    if (result.type === 'success') {
      entry.resolve(result.model)
    } else {
      entry.reject(deserializeMapError(result.error))
    }
  }

  worker.onerror = (event: ErrorEvent): void => {
    // §11 SceneBuildError 行：Worker 崩溃；不自动重试，重试由用户触发并新建 Worker
    failAllPending(new SceneBuildError('MAP_WORKER_CRASHED', '场景构建 Worker 崩溃', { cause: event }))
  }

  return {
    decodeAndBuild(payload: ArrayBuffer): Promise<FactorySceneModel> {
      if (terminated) {
        return Promise.reject(
          new SceneBuildError('MAP_WORKER_TERMINATED', '场景构建 Worker 已终止，不能再接收新请求'),
        )
      }
      lastMapBuildRequestId += 1
      const requestId = lastMapBuildRequestId
      const { message, transfer } = createMapBuildRequest(requestId, payload, options.buildOptions)
      return new Promise<FactorySceneModel>((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        try {
          worker.postMessage(message, transfer)
        } catch (error) {
          pending.delete(requestId)
          reject(new SceneBuildError('MAP_WORKER_CRASHED', '向场景构建 Worker 发送请求失败', { cause: error }))
        }
      })
    },

    terminate(): void {
      if (terminated) return
      terminated = true
      try {
        worker.terminate()
      } finally {
        failAllPending(new SceneBuildError('MAP_WORKER_TERMINATED', '场景构建 Worker 已被取代或卸载而终止'))
      }
    },
  }
}
