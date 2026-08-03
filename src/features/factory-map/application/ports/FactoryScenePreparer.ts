/**
 * 场景数据准备端口（SPEC §3.1、§5.1）：Worker 侧的解码、校验与场景数据构建。
 *
 * 由 infrastructure/worker/WorkerScenePreparer 实现（TASK-006）。
 * 取消语义（§5.1）：同步 JSON.parse 不能由取消消息中断，preparing 中被取代时
 * 只能直接 terminate 并创建新 Worker——因此本端口不提供 abort 消息通道，
 * 每次加载使用新的 preparer 实例，不复用。
 */

import type { FactorySceneModel } from '../factorySceneModel'

export interface FactoryScenePreparer {
  /**
   * 解码 UTF-8 payload → JSON 解析 → 信封解码 → §3.3 字段校验 → 领域规范化
   * → 场景数据构建，resolve 为 FactorySceneModel。
   *
   * - 输入 ArrayBuffer 的所有权随调用转移给 preparer（transferable）
   * - 成功后模型内 TypedArray 的底层 ArrayBuffer 以 transfer 方式回到主线程
   * - 校验/构建失败 reject 对应 §11 领域错误（MapParseError / MapEnvelopeError /
   *   MapValidationError / MapCapacityError / MapGeometryError / SceneBuildError）
   */
  decodeAndBuild(payload: ArrayBuffer): Promise<FactorySceneModel>

  /**
   * 直接终止底层 Worker。调用后未决的 decodeAndBuild 必须 reject 或永不 settle
   * （状态机已通过单调 requestId 丢弃其过期结果）；terminate 幂等，
   * 之后该实例不得再使用。
   */
  terminate(): void
}
