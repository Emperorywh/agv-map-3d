/*
 * Vitest 全局 setup。
 * 职责：注册 Testing Library 的 DOM 断言匹配器，并补齐 jsdom 缺失的浏览器 API。
 * 关键不变量：ResizeObserver stub 只服务测试环境——@react-three/fiber 的 Canvas
 * 依赖它监听尺寸变化；jsdom 未内置，必须在渲染前以最小实现补齐。
 */
import '@testing-library/jest-dom/vitest'

type ResizeObserverLike = {
  observe(): void
  unobserve(): void
  disconnect(): void
}

const globalScope = globalThis as unknown as {
  ResizeObserver?: new () => ResizeObserverLike
}

class ResizeObserverStub implements ResizeObserverLike {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (globalScope.ResizeObserver === undefined) {
  globalScope.ResizeObserver = ResizeObserverStub
}
