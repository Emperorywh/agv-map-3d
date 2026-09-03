/**
 * 调试面板开关判定（项目开发宪法 §8「必须提供 DEBUG MODE」；Leva 仅开发
 * 环境使用）。
 *
 * 职责：判定当前会话是否挂载 Canvas 内调试面板——开发模式（import.meta.env
 *       .DEV 由调用方注入）为前置条件，再按「URL ?debug= 显式开/关 + 会话
 *       存储记忆」决定，避免开发期截图取证时面板常驻遮挡画面。
 * 边界：本模块不导入 React、不创建任何 UI；生产构建中调用点被 DEV=false
 *       静态替换后整段死代码消除（与 mock dev bridge 同一模式），面板与
 *       leva 依赖不进产物。URL 显式开关时会话记忆随之写入/清除（仅开发期
 *       执行，失败静默）。
 * 关键不变量：
 * 1. dev=false 恒为 false（生产、测试渲染器默认不挂载）；
 * 2. URL 显式 ?debug=0/false 表示强制关闭并清除会话记忆；其余非空值为开启
 *    并记忆；无 URL 参数时回退读会话记忆（刷新后保持上次选择）；
 * 3. 会话存储不可用（隐私模式/无 DOM 环境）时静默降级为「仅 URL 控制」。
 */

/** URL 查询参数键：?debug=1 开启、?debug=0 强制关闭 */
export const DEBUG_URL_PARAM = 'debug'

/** 会话存储键：URL 开启后记忆本次会话选择（刷新保持） */
export const DEBUG_SESSION_KEY = 'agv.debugPanel'

/** 会话存储最小形态（Storage 的只写子集，测试可注入隔离对象） */
export interface DebugSessionStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface DebugGateInput {
  /** 会话存储；null 表示不可用（无 DOM/隐私模式） */
  session: DebugSessionStore | null
  /** 当前 URL 查询参数（调用方解析一次传入） */
  query: URLSearchParams
}

/** 判定调试面板是否挂载；dev=false 恒 false（生产死代码消除的前提） */
export function resolveDebugPanelEnabled(dev: boolean, input: DebugGateInput): boolean {
  if (!dev) {
    return false
  }
  const raw = input.query.get(DEBUG_URL_PARAM)
  if (raw === '0' || raw === 'false') {
    persistDebugPanelEnabled(false, input.session)
    return false
  }
  if (raw !== null) {
    persistDebugPanelEnabled(true, input.session)
    return true
  }
  try {
    return input.session?.getItem(DEBUG_SESSION_KEY) === '1'
  } catch {
    // 会话存储读取失败：降级为「仅 URL 控制」
    return false
  }
}

/** 会话记忆写入（仅开发期由面板开关调用；失败静默，不影响渲染） */
export function persistDebugPanelEnabled(enabled: boolean, session: DebugSessionStore | null): void {
  if (session === null) {
    return
  }
  try {
    if (enabled) {
      session.setItem(DEBUG_SESSION_KEY, '1')
    } else {
      session.removeItem(DEBUG_SESSION_KEY)
    }
  } catch {
    // 写入失败静默放弃：调试便利性不得反噬页面
  }
}
