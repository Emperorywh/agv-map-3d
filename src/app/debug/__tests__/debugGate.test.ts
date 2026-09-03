/*
 * 调试面板门控判定测试（与实现共置）。
 *
 * 职责：校验 DEBUG MODE 的开发环境前置、URL 显式开/关与会话记忆行为，以及
 *       存储不可用时的静默降级（开发宪法 §8；生产死代码消除的前提是
 *       dev=false 恒 false）。
 * 关键不变量：
 * 1. dev=false 时无论 URL/会话状态如何恒为 false；
 * 2. ?debug=0/false 强制关闭并清除会话记忆；其余非空值开启并写入记忆；
 * 3. 无 URL 参数时回退会话记忆；存储异常静默降级为「仅 URL 控制」。
 */
import { describe, expect, it } from 'vitest'
import {
  DEBUG_SESSION_KEY,
  DEBUG_URL_PARAM,
  resolveDebugPanelEnabled,
  type DebugSessionStore,
} from '../debugGate'

/** 内存会话存储：记录写入/清除调用，可注入异常 */
function memorySession(initial: Record<string, string> = {}, options: { throwOnAccess?: boolean } = {}): {
  store: DebugSessionStore
  removed: string[]
} {
  const map = new Map(Object.entries(initial))
  const removed: string[] = []
  const guard = (): void => {
    if (options.throwOnAccess) {
      throw new DOMException('存储不可用', 'SecurityError')
    }
  }
  return {
    removed,
    store: {
      getItem(key) {
        guard()
        return map.get(key) ?? null
      },
      setItem(key, value) {
        guard()
        map.set(key, value)
      },
      removeItem(key) {
        guard()
        map.delete(key)
        removed.push(key)
      },
    },
  }
}

function query(value: string | null): URLSearchParams {
  const params = new URLSearchParams()
  if (value !== null) {
    params.set(DEBUG_URL_PARAM, value)
  }
  return params
}

describe('resolveDebugPanelEnabled', () => {
  it('dev=false 时恒为 false，且不触碰会话存储', () => {
    const { store, removed } = memorySession({ [DEBUG_SESSION_KEY]: '1' })
    expect(resolveDebugPanelEnabled(false, { query: query('1'), session: store })).toBe(false)
    expect(resolveDebugPanelEnabled(false, { query: query(null), session: store })).toBe(false)
    expect(removed).toEqual([])
  })

  it('URL ?debug=1 显式开启并写入会话记忆', () => {
    const { store } = memorySession()
    expect(resolveDebugPanelEnabled(true, { query: query('1'), session: store })).toBe(true)
    expect(store.getItem(DEBUG_SESSION_KEY)).toBe('1')
  })

  it('URL 非空任意值均视为开启', () => {
    const { store } = memorySession()
    expect(resolveDebugPanelEnabled(true, { query: query('true'), session: store })).toBe(true)
    expect(resolveDebugPanelEnabled(true, { query: query(''), session: store })).toBe(true)
    void store
  })

  it('URL ?debug=0 / false 强制关闭并清除会话记忆', () => {
    const off0 = memorySession({ [DEBUG_SESSION_KEY]: '1' })
    expect(resolveDebugPanelEnabled(true, { query: query('0'), session: off0.store })).toBe(false)
    expect(off0.removed).toEqual([DEBUG_SESSION_KEY])

    const offFalse = memorySession({ [DEBUG_SESSION_KEY]: '1' })
    expect(resolveDebugPanelEnabled(true, { query: query('false'), session: offFalse.store })).toBe(false)
    expect(offFalse.removed).toEqual([DEBUG_SESSION_KEY])
  })

  it('无 URL 参数时回退会话记忆', () => {
    const withMemory = memorySession({ [DEBUG_SESSION_KEY]: '1' })
    expect(resolveDebugPanelEnabled(true, { query: query(null), session: withMemory.store })).toBe(true)

    const withoutMemory = memorySession()
    expect(resolveDebugPanelEnabled(true, { query: query(null), session: withoutMemory.store })).toBe(false)
  })

  it('会话存储不可用时静默降级为「仅 URL 控制」', () => {
    expect(resolveDebugPanelEnabled(true, { query: query('1'), session: null })).toBe(true)
    expect(resolveDebugPanelEnabled(true, { query: query(null), session: null })).toBe(false)

    const throwing = memorySession({}, { throwOnAccess: true })
    expect(resolveDebugPanelEnabled(true, { query: query('1'), session: throwing.store })).toBe(true)
    expect(resolveDebugPanelEnabled(true, { query: query(null), session: throwing.store })).toBe(false)
  })
})
