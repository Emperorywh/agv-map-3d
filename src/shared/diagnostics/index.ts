/**
 * shared/diagnostics 公开入口（SPEC §12.2）。
 *
 * 职责：导出结构化诊断通道与结构化错误这两个跨模块基础能力。
 * 边界：本目录不得出现任何 AGV 业务词汇；消费方按子目录 @/shared/diagnostics 导入。
 * 关键不变量：诊断永不阻塞、永不渲染 DOM；错误码是跨模块稳定合同。
 */
export {
  createDiagnosticsReporter,
  DEFAULT_SAMPLE_WINDOW_MS,
} from './reporter'
export type {
  CreateDiagnosticsReporterOptions,
  DiagnosticLevel,
  DiagnosticRecord,
  DiagnosticsReporter,
  DiagnosticSink,
} from './reporter'
export { describeError, isAbortError, StructuredError } from './structuredError'
export type { StructuredErrorInput } from './structuredError'
