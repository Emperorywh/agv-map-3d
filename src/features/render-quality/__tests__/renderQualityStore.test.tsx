/*
 * 质量等级低频 Store 与只读视图测试（TASK-014）。
 *
 * 职责：锁定质量 store 的幂等写语义与只读消费面——同值写入不通知订阅者、
 *       越界值被钳制、useQualityLevel 精确订阅、subscribeQualityLevel 登记
 *       即回调且退订对称。
 */
import { act, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  subscribeQualityLevel,
  useQualityLevel,
} from '@/features/render-quality'
import { useRenderQualityStore } from '@/features/render-quality/model/renderQualityStore'

describe('renderQualityStore 与只读视图', () => {
  it('同值写入是 no-op：不通知订阅者', () => {
    useRenderQualityStore.getState().setQualityLevel(0)
    const listener = vi.fn()
    const unsubscribe = useRenderQualityStore.subscribe(listener)
    try {
      useRenderQualityStore.getState().setQualityLevel(0)
      expect(listener).not.toHaveBeenCalled()
      useRenderQualityStore.getState().setQualityLevel(2)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(useRenderQualityStore.getState().qualityLevel).toBe(2)
    } finally {
      unsubscribe()
      useRenderQualityStore.getState().setQualityLevel(0)
    }
  })

  it('越界等级被钳制进 [0, 4]', () => {
    try {
      useRenderQualityStore.getState().setQualityLevel(9)
      expect(useRenderQualityStore.getState().qualityLevel).toBe(4)
      useRenderQualityStore.getState().setQualityLevel(-3)
      expect(useRenderQualityStore.getState().qualityLevel).toBe(0)
    } finally {
      useRenderQualityStore.getState().setQualityLevel(0)
    }
  })

  it('useQualityLevel 精确订阅等级跃迁；subscribeQualityLevel 登记即回调且退订对称', () => {
    let observed: number | null = null
    function Probe(): null {
      observed = useQualityLevel()
      return null
    }
    try {
      render(<Probe />)
      expect(observed).toBe(0)

      const listener = vi.fn()
      const unsubscribe = subscribeQualityLevel(listener)
      // 登记即以当前等级回调一次
      expect(listener).toHaveBeenLastCalledWith(0)

      act(() => {
        useRenderQualityStore.getState().setQualityLevel(3)
      })
      expect(observed).toBe(3)
      expect(listener).toHaveBeenLastCalledWith(3)

      unsubscribe()
      act(() => {
        useRenderQualityStore.getState().setQualityLevel(0)
      })
      expect(listener).toHaveBeenCalledTimes(2) // 登记回调 + 一次跃迁
    } finally {
      useRenderQualityStore.getState().setQualityLevel(0)
    }
  })
})
