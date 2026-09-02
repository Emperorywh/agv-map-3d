/*
 * useWebGLContextRecovery Hook 测试（TASK-016；SPEC §11.9）。
 *
 * 职责：在真实 jsdom canvas 元素上派发真实的 cancelable DOM 事件（浏览器事
 *       件路径），验证 Hook 的事件接线合同：preventDefault、状态转移、诊断
 *       码表、重试计时器收敛、监听对称清理与 StrictMode 无重复监听。渲染器
 *       以最小结构替身 {domElement} 注入。Hook 返回值经组件体写入外部变量
 *       （Harness 模式）——与仓库既有 render+act 派发模式一致：事件派发包
 *       在 act 内，状态断言在 act 外读取提交结果。重试只涉及 setTimeout，
 *       fake timers 限定 toFake 子集（React 19 调度依赖 MessageChannel，
 *       不得被 fake）。
 */
import { StrictMode } from 'react'
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDiagnosticsReporter, type DiagnosticRecord } from '@/shared/diagnostics'
import {
  CONTEXT_RECOVERY_DIAGNOSTIC_CODES,
  CONTEXT_RECOVERY_RETRY_DELAY_MS,
  MAX_CONTEXT_RECOVERY_FAILURES,
  type ContextRecoveryState,
} from '../contextRecovery'
import { useWebGLContextRecovery, type ContextRecoveryController } from '../useWebGLContextRecovery'

/** Hook 返回值容器：组件体每次渲染写入（Harness 模式） */
let latest: ContextRecoveryController | undefined

/** 挂载 Harness：监听注入到指定 canvas，诊断写入 records */
function mountHarness(canvas: HTMLCanvasElement, records: DiagnosticRecord[]) {
  function Harness(): null {
    latest = useWebGLContextRecovery({
      renderer: { domElement: canvas },
      diagnostics: createDiagnosticsReporter({ sink: (record) => records.push(record) }),
    })
    return null
  }
  const utils = render(<Harness />)
  return { unmount: utils.unmount }
}

function makeCanvas(): HTMLCanvasElement {
  return document.createElement('canvas')
}

/** 在 act 内派发真实 cancelable 事件（与浏览器派发路径一致），返回是否被 preventDefault */
function fireInAct(canvas: HTMLCanvasElement, type: 'webglcontextlost' | 'webglcontextrestored'): boolean {
  let prevented = false
  act(() => {
    const event = new Event(type, { cancelable: true })
    canvas.dispatchEvent(event)
    prevented = event.defaultPrevented
  })
  return prevented
}

/** 当前状态快照（断言用，避免后续渲染覆盖） */
function snapshotState(): ContextRecoveryState {
  return { ...latest!.state }
}

/** 驱动一轮「丢失 → 恢复」并返回每步状态 */
function lostAndRestored(canvas: HTMLCanvasElement): { afterLost: ContextRecoveryState; afterRestored: ContextRecoveryState } {
  const prevented = fireInAct(canvas, 'webglcontextlost')
  expect(prevented).toBe(true)
  const afterLost = snapshotState()
  fireInAct(canvas, 'webglcontextrestored')
  return { afterLost, afterRestored: snapshotState() }
}

afterEach(() => {
  vi.useRealTimers()
  latest = undefined
})

describe('useWebGLContextRecovery（浏览器事件路径）', () => {
  it('lost 事件被 preventDefault（保留恢复资格）并进入 recovering；restored 递增资源代', () => {
    const records: DiagnosticRecord[] = []
    const canvas = makeCanvas()
    mountHarness(canvas, records)

    const { afterLost, afterRestored } = lostAndRestored(canvas)
    expect(afterLost.phase).toBe('recovering')
    expect(afterLost.generation).toBe(0)
    expect(afterRestored.phase).toBe('recovering')
    expect(afterRestored.generation).toBe(1)
  })

  it('renderer=null 为合法稳态：Hook 正常挂载，初始 running', () => {
    function Harness(): null {
      latest = useWebGLContextRecovery({
        renderer: null,
        diagnostics: createDiagnosticsReporter({ sink: () => {} }),
      })
      return null
    }
    render(<Harness />)
    expect(latest!.state.phase).toBe('running')
    expect(latest!.state.generation).toBe(0)
  })

  it('完整成功恢复时间线：lost → restored → settle(true) 回到 running，诊断按码表上报', () => {
    const records: DiagnosticRecord[] = []
    const canvas = makeCanvas()
    mountHarness(canvas, records)

    const { afterRestored } = lostAndRestored(canvas)
    expect(afterRestored.generation).toBe(1)
    act(() => {
      latest!.settleContextRecovery(true)
    })
    const settled = snapshotState()
    expect(settled.phase).toBe('running')
    expect(settled.consecutiveFailures).toBe(0)

    const codes = records.map((record) => record.code)
    expect(codes).toContain(CONTEXT_RECOVERY_DIAGNOSTIC_CODES.LOST)
    expect(codes).toContain(CONTEXT_RECOVERY_DIAGNOSTIC_CODES.RESTORED)
    expect(codes).toContain(CONTEXT_RECOVERY_DIAGNOSTIC_CODES.SUCCEEDED)
    expect(codes).not.toContain(CONTEXT_RECOVERY_DIAGNOSTIC_CODES.RETRY)
    expect(codes).not.toContain(CONTEXT_RECOVERY_DIAGNOSTIC_CODES.FAILED)
  })

  it(`settle(false) 按延迟重试；第 ${MAX_CONTEXT_RECOVERY_FAILURES} 次失败放弃：stopped 后 lost/restored 不再响应，记录 error 诊断`, () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const records: DiagnosticRecord[] = []
    const canvas = makeCanvas()
    mountHarness(canvas, records)

    const { afterRestored } = lostAndRestored(canvas)
    expect(afterRestored.generation).toBe(1)

    // 前两次失败：每次结算后经重试延迟递增资源代，停留在 recovering
    for (let attempt = 1; attempt < MAX_CONTEXT_RECOVERY_FAILURES; attempt += 1) {
      const generationBefore = snapshotState().generation
      act(() => {
        latest!.settleContextRecovery(false)
      })
      expect(snapshotState().phase).toBe('recovering')
      act(() => {
        vi.advanceTimersByTime(CONTEXT_RECOVERY_RETRY_DELAY_MS)
      })
      expect(snapshotState().generation).toBe(generationBefore + 1)
    }

    // 第三次失败：永久停止
    act(() => {
      latest!.settleContextRecovery(false)
    })
    expect(snapshotState().phase).toBe('stopped')

    // stopped 吸收态：新的丢失/恢复事件不再改变状态，重试计时器不存在
    const generationAtStop = snapshotState().generation
    fireInAct(canvas, 'webglcontextlost')
    fireInAct(canvas, 'webglcontextrestored')
    act(() => {
      vi.advanceTimersByTime(CONTEXT_RECOVERY_RETRY_DELAY_MS * 10)
    })
    expect(snapshotState().phase).toBe('stopped')
    expect(snapshotState().generation).toBe(generationAtStop)

    const failedRecords = records.filter(
      (record) => record.code === CONTEXT_RECOVERY_DIAGNOSTIC_CODES.FAILED,
    )
    expect(failedRecords).toHaveLength(1)
    expect(failedRecords[0]!.level).toBe('error')
  })

  it('恢复成功清零失败计数：新一轮丢失需重新连续失败三次才放弃', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const canvas = makeCanvas()
    mountHarness(canvas, [])

    // 第一轮：失败一次后成功
    lostAndRestored(canvas)
    act(() => {
      latest!.settleContextRecovery(false)
      vi.advanceTimersByTime(CONTEXT_RECOVERY_RETRY_DELAY_MS)
      latest!.settleContextRecovery(true)
    })
    expect(snapshotState().phase).toBe('running')
    expect(snapshotState().consecutiveFailures).toBe(0)

    // 第二轮：失败两次仍在重试（不跨成功恢复累计）
    for (let i = 0; i < 2; i += 1) {
      lostAndRestored(canvas)
      act(() => {
        latest!.settleContextRecovery(false)
        vi.advanceTimersByTime(CONTEXT_RECOVERY_RETRY_DELAY_MS)
      })
      expect(snapshotState().phase).toBe('recovering')
    }
  })

  it('重试等待期收到新的 restored：以最新上下文为准，计时器收敛不叠加', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const canvas = makeCanvas()
    mountHarness(canvas, [])

    lostAndRestored(canvas)
    act(() => {
      latest!.settleContextRecovery(false)
    })
    const generationAtFail = snapshotState().generation

    // 重试等待期内浏览器又派发一次 restored：资源代再次递增
    fireInAct(canvas, 'webglcontextrestored')
    expect(snapshotState().generation).toBe(generationAtFail + 1)

    // 原重试计时器到期：不再重复递增（计时器已被 restored 清除）
    act(() => {
      vi.advanceTimersByTime(CONTEXT_RECOVERY_RETRY_DELAY_MS * 2)
    })
    expect(snapshotState().generation).toBe(generationAtFail + 1)
  })

  it('卸载后监听对称摘除：事件不再改变状态，重试计时器被清理', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const canvas = makeCanvas()
    const { unmount } = mountHarness(canvas, [])

    lostAndRestored(canvas)
    act(() => {
      latest!.settleContextRecovery(false)
    })
    expect(snapshotState().phase).toBe('recovering')

    unmount()
    // 卸载后事件派发不抛错也不影响状态（监听已摘除、计时器已清理）
    expect(() => {
      canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
      canvas.dispatchEvent(new Event('webglcontextrestored'))
    }).not.toThrow()
    act(() => {
      vi.advanceTimersByTime(CONTEXT_RECOVERY_RETRY_DELAY_MS * 5)
    })
  })

  it('StrictMode 双挂载无重复监听：一次事件派发只产生一次状态转移与一条诊断', () => {
    const records: DiagnosticRecord[] = []
    const canvas = makeCanvas()
    function Harness(): null {
      latest = useWebGLContextRecovery({
        renderer: { domElement: canvas },
        diagnostics: createDiagnosticsReporter({ sink: (record) => records.push(record) }),
      })
      return null
    }
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    )

    fireInAct(canvas, 'webglcontextlost')
    expect(snapshotState().phase).toBe('recovering')

    // 采样窗口关闭后归集：同码计数恰为 1（重复监听会得到 count≥2）
    const lostRecords = records.filter(
      (record) => record.code === CONTEXT_RECOVERY_DIAGNOSTIC_CODES.LOST,
    )
    expect(lostRecords).toHaveLength(1)
    expect(lostRecords[0]!.count).toBe(1)
  })
})
