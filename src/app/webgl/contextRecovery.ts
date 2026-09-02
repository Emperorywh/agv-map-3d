/**
 * WebGL 上下文丢失恢复状态机（SPEC §7.4、§11.9；TASK-016；app 恢复编排）。
 *
 * 职责：以纯函数描述唯一 Canvas 从「正常运行 → 上下文丢失（暂停帧提交）→
 *       恢复事件（各所有者重建 GPU 资源）→ 结算（成功/重试/放弃）」的完整
 *       生命周期。本模块不触碰 DOM、计时器与诊断通道——副作用全部由
 *       useWebGLContextRecovery 注入，状态转移本身完全确定、可表驱动测试。
 * 边界：只服务 app 组合层的恢复编排；不感知任何 Feature 内部资源细节（各
 *       所有者的重建由资源代 contextGeneration 驱动，属声明式 React 提交，
 *       不在本状态机建模）；不创建第二 Canvas、DOM 兜底或自动刷新。
 * 关键不变量：
 * 1. 失败计数作用域：属于当前 Canvas 实例的一次「连续失败序列」——恢复成功
 *    即清零，达到 MAX_CONTEXT_RECOVERY_FAILURES 次连续失败进入 stopped 终态；
 *    App 卸载重挂（含 StrictMode）重新计数，绝不跨成功恢复累计；
 * 2. stopped 是吸收态：之后的 lost/restored/settled 一律忽略——连续三次恢复
 *    失败后安全停止渲染（frameloop 恒为 never），页面仍只有原 Canvas，恢复
 *    的唯一出口是重新挂载应用（不自动刷新页面）；
 * 3. 恢复期（recovering）内帧提交保持暂停：无论等待浏览器恢复事件、等待各
 *    所有者重建提交，还是等待重试延迟，frameloop 都不得回到 always；
 * 4. generation 是「资源代」序号：restored 与重试都使它递增，驱动各 Feature
 *    在一次 React 提交内按「地图 → 环境 → 车辆 → 标签 → 环 → 交通资源」的
 *    确定顺序强制重建 GPU 资源；0 表示初始挂载（各所有者的首次创建，不算
 *    恢复重建，也不触发结算）。
 */

/** 恢复阶段：running 正常渲染；recovering 丢失后暂停提交等待重建；stopped 终态 */
export type ContextRecoveryPhase = 'running' | 'recovering' | 'stopped'

/** 恢复状态机的不可变状态快照 */
export interface ContextRecoveryState {
  readonly phase: ContextRecoveryPhase
  /** GPU 资源代：初始 0，每次要求所有者重建（restored/重试）递增 */
  readonly generation: number
  /** 当前连续失败次数：成功恢复清零；作用域见模块注释不变量 1 */
  readonly consecutiveFailures: number
}

/** 连续恢复失败上限：达到即记录结构化错误并永久停止渲染（SPEC §11.9） */
export const MAX_CONTEXT_RECOVERY_FAILURES = 3

/** 恢复重建失败后的重试间隔（毫秒）：上下文已在手，重建自身可短暂退避重试 */
export const CONTEXT_RECOVERY_RETRY_DELAY_MS = 1000

/** 初始状态：正常运行、资源代 0、无失败累计 */
export const INITIAL_CONTEXT_RECOVERY_STATE: ContextRecoveryState = {
  phase: 'running',
  generation: 0,
  consecutiveFailures: 0,
}

/** 恢复诊断码表：稳定合同，测试与排障共同依赖 */
export const CONTEXT_RECOVERY_DIAGNOSTIC_CODES = {
  /** 上下文丢失（已 preventDefault，进入恢复期并暂停帧提交） */
  LOST: 'WEBGL_CONTEXT_LOST',
  /** 浏览器报告上下文已恢复：开始按确定顺序重建各所有者资源 */
  RESTORED: 'WEBGL_CONTEXT_RESTORED',
  /** 一次恢复重建失败，已安排延迟重试 */
  RETRY: 'WEBGL_RECOVERY_RETRY',
  /** 恢复重建成功，恢复帧提交 */
  SUCCEEDED: 'WEBGL_RECOVERY_SUCCEEDED',
  /** 连续三次恢复失败：记录结构化错误并永久停止渲染 */
  FAILED: 'WEBGL_RECOVERY_FAILED',
} as const

/** 单次状态转移的完整结果：下一状态 + 供 Hook 执行副作用的行为标记 */
export interface ContextRecoveryDecision {
  readonly state: ContextRecoveryState
  /** 状态是否发生变化；false 时 Hook 不上报诊断、不调度计时器 */
  readonly changed: boolean
  /** 本次结算失败后是否应安排延迟重试（未达连续失败上限） */
  readonly shouldRetry: boolean
  /** 本次结算失败是否触发放弃（连续失败达上限，进入 stopped） */
  readonly gaveUp: boolean
}

const unchanged = (state: ContextRecoveryState): ContextRecoveryDecision => ({
  state,
  changed: false,
  shouldRetry: false,
  gaveUp: false,
})

/**
 * 浏览器报告 webglcontextlost：running 进入恢复期；调用方必须先对事件执行
 * preventDefault（保留恢复资格）。recovering 中重复丢失（restore 未及发生）
 * 视为同一次丢失会话，不重复计数；stopped 吸收一切。
 */
export function applyContextLost(state: ContextRecoveryState): ContextRecoveryDecision {
  if (state.phase !== 'running') {
    return unchanged(state)
  }
  return {
    state: { ...state, phase: 'recovering' },
    changed: true,
    shouldRetry: false,
    gaveUp: false,
  }
}

/**
 * 浏览器报告 webglcontextrestored：three.js 已重建 GL 上下文与内部缓存，
 * 资源代递增以驱动各所有者重建。仅 recovering 态响应（无丢失的 restored
 * 视为驱动噪声，忽略）；重试等待期收到新的 restored 同样有效——以最新
 * 上下文为准，重试计时器由 Hook 取消。
 */
export function applyContextRestored(state: ContextRecoveryState): ContextRecoveryDecision {
  if (state.phase !== 'recovering') {
    return unchanged(state)
  }
  return {
    state: { ...state, generation: state.generation + 1 },
    changed: true,
    shouldRetry: false,
    gaveUp: false,
  }
}

/**
 * 恢复重试：一次重建结算失败（未达连续失败上限）后，延迟重试再次递增资源
 * 代驱动全部所有者重建。仅 recovering 态有效；重试不改变失败计数——计数只
 * 在结算时推进，连续 N 次失败以「结算失败次数」为准。
 */
export function applyRetryAttempt(state: ContextRecoveryState): ContextRecoveryDecision {
  if (state.phase !== 'recovering') {
    return unchanged(state)
  }
  return {
    state: { ...state, generation: state.generation + 1 },
    changed: true,
    shouldRetry: false,
    gaveUp: false,
  }
}

/**
 * 恢复重建结算：AgvMonitorScene 在资源代提交完成后上抛（子所有者 effect 先
 * 于父结算 effect 执行，故此刻全部所有者已重建完毕）。成功清零计数并恢复
 * 渲染；失败累计计数——未达上限安排重试（再次递增资源代），达上限永久停止。
 */
export function applyRecoverySettled(
  state: ContextRecoveryState,
  ok: boolean,
): ContextRecoveryDecision {
  if (state.phase !== 'recovering') {
    return unchanged(state)
  }
  if (ok) {
    return {
      state: { ...state, phase: 'running', consecutiveFailures: 0 },
      changed: true,
      shouldRetry: false,
      gaveUp: false,
    }
  }
  const consecutiveFailures = state.consecutiveFailures + 1
  if (consecutiveFailures >= MAX_CONTEXT_RECOVERY_FAILURES) {
    return {
      state: { ...state, phase: 'stopped', consecutiveFailures },
      changed: true,
      shouldRetry: false,
      gaveUp: true,
    }
  }
  return {
    state: { ...state, consecutiveFailures },
    changed: true,
    shouldRetry: true,
    gaveUp: false,
  }
}
