/*
 * App DOM 外壳测试（与实现共置）。
 *
 * 职责：以 jsdom + Testing Library 校验应用组合根的 DOM 结构。
 * 因 jsdom 无 WebGL，本文件将 @react-three/fiber 的 Canvas 替换为
 * 等价 DOM 骨架（div > canvas），只断言外壳结构本身。
 * 关键不变量（TASK-001 / D2）：
 * 1. App 渲染的 DOM 中只存在一个 canvas 元素；
 * 2. Canvas 尺寸为 100vw × 100dvh；
 * 3. 不存在按钮、标题、面板等任何 DOM 覆盖层。
 * 真实浏览器行为（WebGL、清屏色、无滚动）由 tests/e2e 覆盖。
 */
import { StrictMode } from 'react'
import type React from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { App } from '@/app/App'

vi.mock('@react-three/fiber', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@react-three/fiber')>()
  return {
    ...actual,
    Canvas: ({
      style,
      children,
    }: {
      style?: React.CSSProperties
      children?: React.ReactNode
    }) => (
      <div data-testid="canvas-shell" style={style}>
        <canvas />
        {children}
      </div>
    ),
  }
})

describe('App DOM 外壳', () => {
  it('只挂载一个 canvas 且占满 100vw × 100dvh', () => {
    const { container } = render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    const canvases = container.querySelectorAll('canvas')
    expect(canvases).toHaveLength(1)

    const shell = container.querySelector<HTMLElement>(
      '[data-testid="canvas-shell"]',
    )
    expect(shell).not.toBeNull()
    // jsdom 会把视口单位解析为像素值，因此直接断言内联样式声明
    expect(shell!.style.width).toBe('100vw')
    expect(shell!.style.height).toBe('100dvh')
  })

  it('不存在任何 DOM 覆盖层元素', () => {
    const { container } = render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    expect(
      container.querySelector(
        'button, header, nav, aside, footer, dialog, input, select, textarea, [role="dialog"]',
      ),
    ).toBeNull()
  })
})
