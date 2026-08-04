import { defineConfig } from '@playwright/test'

/**
 * 显式验收测试统一入口（SPEC §15.2/§15.3）。
 *
 * 三个项目均由验收人员显式启动，`pnpm build/lint/test` 不经过本配置：
 *   pnpm test:browser  —— §15.2 五项浏览器用例（tests/browser）
 *   pnpm test:perf     —— §10.2 PerformanceHarness 性能基准（tests/perf，4K dpr=1）
 *   pnpm test:visual   —— §15.3 视觉基线三机位截图（tests/visual，4K dpr=1）
 *
 * webServer 为唯一被测服务入口（单入口自管理生命周期）：先构建验收 harness
 * （完整应用 + 测试桥 → dist-harness/，harness 标识不进入生产包 dist/），
 * 再以 vite preview 提供被测服务；command 自启、url 就绪检查、测试结束自动回收，
 * 不依赖任何既有长期运行的服务。perf/visual 固定 3840×2160 CSS 画布与
 * deviceScaleFactor=1（§1.3/§10.2 的 dpr=1 验收口径）。
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  projects: [
    {
      name: 'browser',
      testDir: './tests/browser',
      use: {
        baseURL: 'http://127.0.0.1:4173',
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
      },
    },
    {
      name: 'perf',
      testDir: './tests/perf',
      use: {
        baseURL: 'http://127.0.0.1:4173',
        viewport: { width: 3840, height: 2160 },
        deviceScaleFactor: 1,
      },
    },
    {
      name: 'visual',
      testDir: './tests/visual',
      use: {
        baseURL: 'http://127.0.0.1:4173',
        viewport: { width: 3840, height: 2160 },
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: {
    command:
      'pnpm build:harness && pnpm exec vite preview --config tests/harness/vite.config.ts --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 300_000,
  },
})
