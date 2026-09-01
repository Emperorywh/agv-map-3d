/*
 * 结构化诊断通道测试（与实现共置）。
 *
 * 职责：锁定诊断记录结构与采样合并行为的确定性边界。
 * 关键不变量（TASK-002）：
 * 1. 记录携带稳定代码、级别、上下文与单调时间（注入虚拟时钟验证）；
 * 2. 同码采样：窗口内首条立即发出 count=1，后续被抑制，窗口关闭时以
 *    count=被抑制次数 的合并条补发；不同 code 互不影响；
 * 3. sink 异常被完全隔离，诊断失败不影响业务调用方；
 * 4. 默认 sink 写控制台且按级别分流，不产生任何 DOM。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDiagnosticsReporter,
  type DiagnosticRecord,
  type DiagnosticSink,
} from '@/shared/diagnostics'

/** 记录型 sink，便于断言 */
function recordingSink(): { records: DiagnosticRecord[]; sink: DiagnosticSink } {
  const records: DiagnosticRecord[] = []
  return { records, sink: (record) => void records.push(record) }
}

describe('结构化诊断通道', () => {
  it('记录携带稳定代码、级别、上下文、单调时间与 count=1', () => {
    const { records, sink } = recordingSink()
    let current = 100
    const reporter = createDiagnosticsReporter({ sink, now: () => current })

    reporter.report('SOME_CODE', 'warn', '发生了某事', { key: 'value' })
    current = 250
    reporter.report('SOME_CODE', 'warn', '窗口内重复', { key: 'value' })

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      code: 'SOME_CODE',
      level: 'warn',
      message: '发生了某事',
      time: 100,
      count: 1,
    })
    expect(records[0].context).toEqual({ key: 'value' })
  })

  it('窗口内重复上报被抑制，flush 补发合并条且携带最新内容', () => {
    const { records, sink } = recordingSink()
    let current = 0
    const reporter = createDiagnosticsReporter({ sink, now: () => current })

    reporter.report('DUP', 'error', '第一次')
    current = 10
    reporter.report('DUP', 'error', '第二次', { attempt: 2 })
    current = 20
    reporter.report('DUP', 'error', '第三次', { attempt: 3 })
    expect(records).toHaveLength(1)

    reporter.flush()
    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({
      code: 'DUP',
      message: '第三次',
      time: 20,
      count: 2,
    })
    expect(records[1].context).toEqual({ attempt: 3 })

    // flush 已结算：再次 flush 不重复补发
    reporter.flush()
    expect(records).toHaveLength(2)
  })

  it('窗口过期后先结算上一窗口再以新窗口发出首条', () => {
    const { records, sink } = recordingSink()
    let current = 0
    const reporter = createDiagnosticsReporter({
      sink,
      now: () => current,
      sampleWindowMs: 1000,
    })

    reporter.report('E', 'error', 't0') // 记录 1：count=1
    current = 500
    reporter.report('E', 'error', 't500') // 窗口内，抑制
    current = 1500
    reporter.report('E', 'error', 't1500') // 窗口过期：结算 + 新首条

    expect(records).toHaveLength(3)
    expect(records[1]).toMatchObject({ message: 't500', time: 500, count: 1 })
    expect(records[2]).toMatchObject({ message: 't1500', time: 1500, count: 1 })
  })

  it('不同 code 采样互不影响', () => {
    const { records, sink } = recordingSink()
    const reporter = createDiagnosticsReporter({ sink, now: () => 0 })

    reporter.report('A', 'info', 'a1')
    reporter.report('B', 'info', 'b1')
    reporter.report('A', 'info', 'a2')
    reporter.report('B', 'info', 'b2')

    expect(records.map((record) => `${record.code}:${record.count}`)).toEqual(['A:1', 'B:1'])
  })

  it('sink 抛出的异常被隔离，不影响调用方与后续上报', () => {
    let calls = 0
    const throwingSink: DiagnosticSink = () => {
      calls += 1
      throw new Error('sink 崩溃')
    }
    const reporter = createDiagnosticsReporter({ sink: throwingSink, now: () => 0 })

    expect(() => reporter.report('X', 'error', 'x1')).not.toThrow()
    expect(() => reporter.flush()).not.toThrow()
    expect(calls).toBe(1)
  })

  describe('默认 sink（控制台）', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>
    let warnSpy: ReturnType<typeof vi.spyOn>
    let logSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('按级别分流到 console.error / warn / log，输出包含代码与次数', () => {
      const reporter = createDiagnosticsReporter({ now: () => 0 })
      reporter.report('ERR_CODE', 'error', '出错了')
      reporter.report('WARN_CODE', 'warn', '警告')
      reporter.report('INFO_CODE', 'info', '提示')

      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls[0][0]).toContain('ERR_CODE')
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(logSpy).toHaveBeenCalledTimes(1)
    })
  })
})
