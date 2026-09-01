/**
 * 结构化错误（TASK-002：稳定代码、级别、上下文、单调时间）。
 *
 * 职责：为启动、配置等可预期失败提供携带稳定错误码与结构化上下文的 Error，
 *       使调用方可以按代码编程化分支处理，诊断通道可以按级别采样上报。
 * 边界：本类只负责「携带结构化信息」，不做上报；上报由 DiagnosticsReporter
 *       完成，二者组合构成完整的结构化诊断能力。
 * 关键不变量：
 * 1. code 一旦创建不可变，必须是调用方可 switch 的稳定字符串字面量合同；
 * 2. time 使用 performance.now() 单调时钟（或注入时钟），不受系统时间回拨影响；
 * 3. AbortError 一类「取消」不是失败：调用方必须先用 isAbortError 区分，
 *    取消不应作为错误级别进入诊断通道。
 */

export interface StructuredErrorInput {
  /** 稳定错误码，如 'CONFIG_JSON_PARSE'；跨模块合同，不得复用语义 */
  code: string
  /** 诊断级别；默认 'error' */
  level?: DiagnosticLevel
  message: string
  context?: Record<string, unknown>
  /** 原始底层错误（如 fetch 抛出的 TypeError） */
  cause?: unknown
  /** 单调时钟；默认 performance.now()，测试可注入 */
  now?: () => number
}

import type { DiagnosticLevel } from './reporter'

export class StructuredError extends Error {
  readonly code: string
  readonly level: DiagnosticLevel
  readonly context: Readonly<Record<string, unknown>>
  /** 错误创建时的单调时间（毫秒） */
  readonly time: number

  constructor(input: StructuredErrorInput) {
    super(input.message, { cause: input.cause })
    this.name = 'StructuredError'
    this.code = input.code
    this.level = input.level ?? 'error'
    this.context = input.context ?? {}
    this.time = (input.now ?? ((): number => performance.now()))()
  }
}

/** 判断错误是否为取消（AbortError）；取消不是失败，不进入错误诊断 */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

/** 以单行文本描述任意抛出值，用于进入错误上下文 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
