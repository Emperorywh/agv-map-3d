import { defineConfig } from '@playwright/test'

/**
 * 性能基准测试入口（SPEC §10.2 / §15.2）。
 * 由验收人员在参考展厅机器上显式执行 `pnpm test:perf`，驱动 PerformanceHarness。
 * 画布固定 3840 × 2160 CSS 像素、deviceScaleFactor=1（对应 §1.3 的 dpr=1 验收口径）。
 * webServer 为唯一被测服务入口：command 自启、url 就绪检查、测试结束自动回收，
 * 不依赖任何既有长期运行的服务。
 */
export default defineConfig({
  testDir: './tests/perf',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4174',
    viewport: { width: 3840, height: 2160 },
    deviceScaleFactor: 1,
  },
  webServer: {
    command: 'pnpm build && pnpm preview --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
