/**
 * WebGL 上下文丢失恢复 Hook（SPEC §7.4、§11.9、§12.5；TASK-016；Canvas 上下文控制）。
 *
 * 职责：把 contextRecovery 纯状态机接到真实浏览器事件上——在渲染器 canvas
 *       元素上对称挂载 webglcontextlost / webglcontextrestored 监听，丢失时
 *       preventDefault（保留恢复资格）并暂停帧提交（App 据 phase 声明
 *       frameloop），恢复后递增资源代驱动各 Feature 重建；每次重建提交由
 *       AgvMonitorScene 结算上抛，失败按 1s 延迟重试、连续三次失败记录结构
 *       化错误并永久停止渲染。诊断经注入通道上报（采样合并语义不变）。
 * 边界：本 Hook 只做事件接线、裁决副作用与重试计时；不触碰任何 GPU 资源、
 *       不感知 Feature 内部（重建由资源代经 React 提交声明式完成）、不渲染
 *       DOM、不自动刷新页面。渲染器以最小结构类型注入（App 由 Canvas
 *       onCreated 捕获；测试可注入 {domElement} 替身），null 为合法稳态。
 * 关键不变量：
 * 1. 状态转移与副作用分离：useReducer 语义下的状态计算全部在纯函数中完成，
 *       本 Hook 在事件回调内先算 decision 再提交，诊断与计时器只出现一次
 *       （StrictMode 双执行 reducer 不会重复上报）；
 * 2. 监听与计时器对称清理：渲染器更换（StrictMode 重挂）时旧监听随 effect
 *       清理摘除，重试计时器在卸载、新的丢失/恢复事件与结算时收敛为至多一
 *       个——任何时刻不存在重复监听或悬挂计时器；
 * 3. 恢复期帧提交保持暂停：phase 从 lost 到 settle 成功前恒非 running，
 *       frameloop 由 App 派生为 never（含重试等待期）；
 * 4. stopped 吸收态：放弃后 lost/restored/settle 全部忽略，诊断不再重复。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DiagnosticsReporter } from '@/shared/diagnostics'
import {
  applyContextLost,
  applyContextRestored,
  applyRecoverySettled,
  applyRetryAttempt,
  CONTEXT_RECOVERY_DIAGNOSTIC_CODES,
  CONTEXT_RECOVERY_RETRY_DELAY_MS,
  INITIAL_CONTEXT_RECOVERY_STATE,
  MAX_CONTEXT_RECOVERY_FAILURES,
  type ContextRecoveryDecision,
  type ContextRecoveryState,
} from './contextRecovery'

/** 渲染器最小结构类型：只需 canvas 元素挂监听（THREE.WebGLRenderer 天然满足） */
export interface ContextRecoveryRenderer {
  readonly domElement: HTMLCanvasElement
}

export interface UseWebGLContextRecoveryOptions {
  /** 渲染器（App 由 Canvas onCreated 捕获）；null 表示尚未创建，无监听 */
  renderer: ContextRecoveryRenderer | null
  /** 结构化诊断通道（丢失/恢复/重试/成功/放弃） */
  diagnostics: DiagnosticsReporter
}

export interface ContextRecoveryController {
  /** 当前恢复状态（phase 决定 frameloop；generation 驱动资源重建） */
  readonly state: ContextRecoveryState
  /** 各所有者重建提交完成后的结算入口（AgvMonitorScene 上抛） */
  settleContextRecovery(ok: boolean): void
}

export function useWebGLContextRecovery({
  renderer,
  diagnostics,
}: UseWebGLContextRecoveryOptions): ContextRecoveryController {
  const [state, setState] = useState<ContextRecoveryState>(INITIAL_CONTEXT_RECOVERY_STATE)
  // 状态镜像：事件回调内读最新值计算 decision，避免 reducer 双执行产生重复副作用
  const stateRef = useRef<ContextRecoveryState>(INITIAL_CONTEXT_RECOVERY_STATE)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearRetryTimer = useCallback((): void => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }, [])

  const commit = useCallback((decision: ContextRecoveryDecision): void => {
    stateRef.current = decision.state
    setState(decision.state)
  }, [])

  // 上下文丢失：preventDefault 保留恢复资格；进入恢复期（帧提交随之暂停）。
  // three.js 自身的 onContextLost 也执行 preventDefault，二者不冲突。
  const handleContextLost = useCallback(
    (event: Event): void => {
      event.preventDefault()
      clearRetryTimer()
      const decision = applyContextLost(stateRef.current)
      if (!decision.changed) {
        return
      }
      commit(decision)
      diagnostics.report(
        CONTEXT_RECOVERY_DIAGNOSTIC_CODES.LOST,
        'warn',
        'WebGL 上下文丢失，已暂停帧提交并等待恢复',
        { consecutiveFailures: decision.state.consecutiveFailures },
      )
    },
    [clearRetryTimer, commit, diagnostics],
  )

  // 上下文恢复：three.js 已重建 GL 上下文与内部缓存；递增资源代驱动各所有者
  // 按确定顺序重建。恢复事件可打断重试等待（以最新上下文为准）。
  const handleContextRestored = useCallback((): void => {
    clearRetryTimer()
    const decision = applyContextRestored(stateRef.current)
    if (!decision.changed) {
      return
    }
    commit(decision)
    diagnostics.report(
      CONTEXT_RECOVERY_DIAGNOSTIC_CODES.RESTORED,
      'info',
      'WebGL 上下文已恢复，开始按确定顺序重建场景资源',
      { generation: decision.state.generation },
    )
  }, [clearRetryTimer, commit, diagnostics])

  // 结算：成功恢复帧提交；失败重试（1s 后再次递增资源代重建）或达上限放弃。
  const settleContextRecovery = useCallback(
    (ok: boolean): void => {
      const decision = applyRecoverySettled(stateRef.current, ok)
      if (!decision.changed) {
        return
      }
      commit(decision)
      if (ok) {
        diagnostics.report(
          CONTEXT_RECOVERY_DIAGNOSTIC_CODES.SUCCEEDED,
          'info',
          'WebGL 上下文恢复完成，场景资源已按顺序重建',
          { generation: decision.state.generation },
        )
        return
      }
      if (decision.gaveUp) {
        diagnostics.report(
          CONTEXT_RECOVERY_DIAGNOSTIC_CODES.FAILED,
          'error',
          'WebGL 上下文连续恢复失败，已停止渲染（页面保留原 Canvas，无 DOM 兜底）',
          { attempts: MAX_CONTEXT_RECOVERY_FAILURES },
        )
        return
      }
      diagnostics.report(
        CONTEXT_RECOVERY_DIAGNOSTIC_CODES.RETRY,
        'warn',
        'WebGL 上下文恢复重建失败，已安排延迟重试',
        {
          attempt: decision.state.consecutiveFailures,
          delayMs: CONTEXT_RECOVERY_RETRY_DELAY_MS,
        },
      )
      clearRetryTimer()
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null
        commit(applyRetryAttempt(stateRef.current))
      }, CONTEXT_RECOVERY_RETRY_DELAY_MS)
    },
    [clearRetryTimer, commit, diagnostics],
  )

  // 渲染器 canvas 事件接线：渲染器实例更换（StrictMode 重挂）时旧监听随
  // 清理对称摘除，不产生重复回调。
  useEffect(() => {
    const domElement = renderer?.domElement
    if (domElement === undefined) {
      return
    }
    domElement.addEventListener('webglcontextlost', handleContextLost, false)
    domElement.addEventListener('webglcontextrestored', handleContextRestored, false)
    return () => {
      domElement.removeEventListener('webglcontextlost', handleContextLost, false)
      domElement.removeEventListener('webglcontextrestored', handleContextRestored, false)
    }
  }, [renderer, handleContextLost, handleContextRestored])

  // 卸载时收敛重试计时器（监听已随上方 effect 摘除）
  useEffect(() => clearRetryTimer, [clearRetryTimer])

  return { state, settleContextRecovery }
}
