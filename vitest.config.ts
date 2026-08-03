import { defineConfig } from 'vitest/config'

/**
 * 无浏览器自动测试入口（SPEC §15.1）。
 * `pnpm test` 固定 node 环境，不得隐式启动浏览器；
 * 覆盖率使用 v8 provider（`pnpm test --coverage` 时生效）。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
    },
  },
})
