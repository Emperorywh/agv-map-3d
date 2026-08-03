/**
 * mapBuild Worker 组合根薄入口（SPEC §3.1、§5.1、§12）。
 *
 * 唯一职责：onmessage → runMapBuild → postMessage(result, transfer)。
 * 解码、校验、场景构建与错误映射全部收敛在可测的 mapBuildRunner.ts，
 * 本文件不含任何分支逻辑，不纳入覆盖率测量。
 */

import { runMapBuild } from './mapBuildRunner'

/**
 * Dedicated Worker 全局的最小结构类型。
 * 不引入 WebWorker lib（与 tsconfig 的 DOM lib 存在重复定义），只声明用到的成员。
 */
interface MapBuildWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  postMessage(message: unknown, transfer: Transferable[]): void
}

const scope = self as unknown as MapBuildWorkerScope

scope.onmessage = (event: MessageEvent<unknown>): void => {
  const { message, transfer } = runMapBuild(event.data)
  scope.postMessage(message, transfer)
}
