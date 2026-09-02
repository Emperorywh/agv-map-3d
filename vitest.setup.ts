/*
 * Vitest 全局 setup。
 * 职责：注册 Testing Library 的 DOM 断言匹配器，并补齐 jsdom 缺失的浏览器 API。
 * 关键不变量：ResizeObserver stub 只服务测试环境——@react-three/fiber 的 Canvas
 * 依赖它监听尺寸变化；jsdom 未内置，必须在渲染前以最小实现补齐。指针捕获 API
 * 同理——three OrbitControls 在 pointerdown 处理器里调用 setPointerCapture，
 * jsdom 未实现会抛错中断同一事件上的其他监听器（相机拖拽测试依赖完整派发）。
 */
import '@testing-library/jest-dom/vitest'

type ResizeObserverLike = {
  observe(): void
  unobserve(): void
  disconnect(): void
}

const globalScope = globalThis as unknown as {
  ResizeObserver?: new () => ResizeObserverLike
  Element?: { prototype: Record<string, unknown> }
}

class ResizeObserverStub implements ResizeObserverLike {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (globalScope.ResizeObserver === undefined) {
  globalScope.ResizeObserver = ResizeObserverStub
}

// jsdom 未实现指针捕获：以无操作实现补齐（仅测试环境，行为等同「未捕获」）
if (globalScope.Element !== undefined) {
  const prototype = globalScope.Element.prototype
  if (typeof prototype.hasPointerCapture !== 'function') {
    prototype.hasPointerCapture = () => false
  }
  if (typeof prototype.setPointerCapture !== 'function') {
    prototype.setPointerCapture = () => {}
  }
  if (typeof prototype.releasePointerCapture !== 'function') {
    prototype.releasePointerCapture = () => {}
  }
}
