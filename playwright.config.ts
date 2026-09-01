import { defineConfig } from '@playwright/test'

// Playwright E2E 配置。
// 职责：针对真实浏览器验证启动生命周期、单 Canvas 与禁止 DOM 覆盖层约束。
// 关键不变量：webServer 指向开发服务器；headless Chromium 使用软件 WebGL 以保证场景可初始化。
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1920, height: 1080 },
    launchOptions: {
      args: ['--enable-unsafe-swiftshader'],
    },
  },
  webServer: {
    command: 'pnpm dev --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
