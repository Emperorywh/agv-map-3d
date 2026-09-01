/**
 * 结构化诊断通道（SPEC §12.2 shared/diagnostics；TASK-002）。
 *
 * 职责：为应用提供「稳定代码 + 级别 + 上下文 + 单调时间」的结构化记录上报，
 *       支持同码采样合并与可注入 sink；启动阶段耗时等性能指标也经由本通道输出。
 * 边界：不写任何 DOM、不弹 UI；默认只写控制台并按级别分流。业务模块依赖本
 *       抽象，不得散落直接调用 console.*。
 * 关键不变量：
 * 1. 记录的 time 必须来自单调时钟（默认 performance.now()），不受系统时间回拨影响；
 * 2. 同一 code 在采样窗口内的重复上报被合并：首条立即以 count=1 发出，窗口内
 *    后续次数被抑制，并在窗口关闭时（下一次同码上报或 flush）以一条
 *    count=被抑制次数 的合并记录补发——不使用定时器，行为完全确定性、可测；
 * 3. sink 抛出的异常必须被隔离：诊断失败绝不反噬业务调用方。
 */

export type DiagnosticLevel = 'info' | 'warn' | 'error'

export interface DiagnosticRecord {
  readonly code: string
  readonly level: DiagnosticLevel
  readonly message: string
  readonly context: Readonly<Record<string, unknown>>
  /** 单调时间（毫秒），来自 performance.now() 或注入时钟 */
  readonly time: number
  /** 本条记录代表的次数：窗口内首条恒为 1；窗口关闭补发的合并条为被抑制的次数 */
  readonly count: number
}

export type DiagnosticSink = (record: DiagnosticRecord) => void

export interface DiagnosticsReporter {
  report(
    code: string,
    level: DiagnosticLevel,
    message: string,
    context?: Record<string, unknown>,
  ): void
  /** 立即结算所有仍在采样窗口内的合并记录；进程退出前或测试断言前调用 */
  flush(): void
}

export interface CreateDiagnosticsReporterOptions {
  /** 记录落地目标；默认写控制台（按级别分流） */
  sink?: DiagnosticSink
  /** 单调时钟；默认 performance.now()，测试可注入虚拟时钟 */
  now?: () => number
  /** 同码采样窗口（毫秒）；默认 1000 */
  sampleWindowMs?: number
}

export const DEFAULT_SAMPLE_WINDOW_MS = 1000

/** 默认落地目标：控制台按级别分流；控制台自身异常同样被隔离 */
const defaultSink: DiagnosticSink = (record) => {
  try {
    const contextText = JSON.stringify(record.context)
    const line = `[AGV][${record.level}] ${record.code} x${record.count} ${record.message}${
      contextText && contextText !== '{}' ? ` ${contextText}` : ''
    }`
    if (record.level === 'error') {
      console.error(line)
    } else if (record.level === 'warn') {
      console.warn(line)
    } else {
      console.log(line)
    }
  } catch {
    // 控制台不可用时静默放弃：诊断不得反噬业务
  }
}

interface SamplingWindowState {
  windowStart: number
  suppressed: number
  level: DiagnosticLevel
  message: string
  context: Readonly<Record<string, unknown>>
  /** 窗口内最后一次发生的单调时间，作为合并补发记录的 time */
  time: number
}

export function createDiagnosticsReporter(
  options: CreateDiagnosticsReporterOptions = {},
): DiagnosticsReporter {
  const sink = options.sink ?? defaultSink
  const now = options.now ?? ((): number => performance.now())
  const sampleWindowMs = options.sampleWindowMs ?? DEFAULT_SAMPLE_WINDOW_MS

  // 每个 code 独立采样，互不影响；Map 只保存「已开启且未结算」的窗口
  const windows = new Map<string, SamplingWindowState>()

  const safeEmit = (record: DiagnosticRecord): void => {
    try {
      sink(record)
    } catch {
      // sink 异常隔离：诊断通道永不向业务调用方抛错
    }
  }

  const openWindow = (
    code: string,
    t: number,
    level: DiagnosticLevel,
    message: string,
    context: Readonly<Record<string, unknown>>,
  ): void => {
    windows.set(code, {
      windowStart: t,
      suppressed: 0,
      level,
      message,
      context,
      time: t,
    })
  }

  // 结算一个已关闭的窗口：仅当存在被抑制的上报时补发一条合并记录
  const settle = (code: string, state: SamplingWindowState): void => {
    if (state.suppressed > 0) {
      safeEmit({
        code,
        level: state.level,
        message: state.message,
        context: state.context,
        time: state.time,
        count: state.suppressed,
      })
    }
  }

  const reporter: DiagnosticsReporter = {
    report(code, level, message, context = {}) {
      const t = now()
      const snapshot: Readonly<Record<string, unknown>> = { ...context }
      const existing = windows.get(code)
      if (!existing) {
        // 窗口首条：立即发出，保证首个错误不被延迟
        safeEmit({ code, level, message, context: snapshot, time: t, count: 1 })
        openWindow(code, t, level, message, snapshot)
        return
      }
      if (t - existing.windowStart >= sampleWindowMs) {
        // 窗口已过期：先结算上一窗口，再以本条开启新窗口
        settle(code, existing)
        safeEmit({ code, level, message, context: snapshot, time: t, count: 1 })
        openWindow(code, t, level, message, snapshot)
        return
      }
      // 窗口内重复上报：抑制并保留最新内容，供合并补发
      existing.suppressed += 1
      existing.level = level
      existing.message = message
      existing.context = snapshot
      existing.time = t
    },
    flush() {
      for (const [code, state] of windows) {
        settle(code, state)
        windows.delete(code)
      }
    },
  }
  return reporter
}
