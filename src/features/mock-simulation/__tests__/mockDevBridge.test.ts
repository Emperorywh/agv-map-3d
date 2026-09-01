/**
 * Mock 开发桥注册测试（TASK-009 / SPEC §9.3「window.__AGV_MOCK__ 只在开发
 * 和 Mock 模式暴露」）。
 *
 * 覆盖：dev=true 挂载到注入目标、dev=false 绝不写入（生产路径）、注入目标
 *       隔离（不污染真实 globalThis）。
 */
import { describe, expect, it } from 'vitest'
import {
  MOCK_DEV_BRIDGE_KEY,
  registerMockDevBridge,
} from '@/features/mock-simulation'

describe('registerMockDevBridge', () => {
  it('dev=true：把控制接口挂载到注入目标', () => {
    const target: Record<string, unknown> = {}
    const control = { getStats: () => ({}) }
    registerMockDevBridge(control, { dev: true, target })
    expect(target[MOCK_DEV_BRIDGE_KEY]).toBe(control)
  })

  it('dev=false：绝不写入目标对象（生产构建路径）', () => {
    const target: Record<string, unknown> = {}
    registerMockDevBridge({ getStats: () => ({}) }, { dev: false, target })
    expect(target[MOCK_DEV_BRIDGE_KEY]).toBeUndefined()
    expect(Object.keys(target)).toHaveLength(0)
  })
})
