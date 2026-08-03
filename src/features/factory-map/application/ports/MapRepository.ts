/**
 * 地图 payload 拉取端口（SPEC §3.1、§5.1）。
 *
 * 单向数据流起点：MapRepository.fetchPayload(url, signal) → ArrayBuffer。
 * 由 infrastructure/HttpMapRepository 实现（TASK-004）；换数据源时新增适配器，
 * 仍输出 §3.1 唯一信封语义，领域层与场景构建层不识别传输协议差异。
 */
export interface MapRepository {
  /**
   * 拉取 url 的完整响应体，resolve 为可转移给 Worker 的 ArrayBuffer。
   *
   * 实现方契约：
   * - Content-Length 或流式累计字节超过 MAX_MAP_BYTES 时立即中止并 reject MapCapacityError
   * - HTTP 非 2xx reject MapHttpError；网络失败/单次请求超时 reject MapNetworkError
   * - signal 中止时 reject（AbortError 语义）；不得把中止误报为其他错误
   * - 除中止语义外，reject 一律为 §11 领域错误（FactoryMapError 子类）
   */
  fetchPayload(url: string, signal: AbortSignal): Promise<ArrayBuffer>
}
