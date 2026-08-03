import { defineConfig } from '@playwright/test'

/**
 * 浏览器验收测试入口（SPEC §15.2）。
 * 由验收人员显式执行 `pnpm test:browser`，`pnpm build/lint/test` 不经过本配置。
 * webServer 为唯一被测服务入口：command 自启、url 就绪检查、测试结束自动回收，
 * 不依赖任何既有长期运行的服务。
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: {
    command: 'pnpm build && pnpm preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
