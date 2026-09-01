import { mergeConfig, defineConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

// Vitest 单元测试配置。
// 职责：以 jsdom 环境运行 src 下与实现共置的单元/集成测试。
// 关键不变量：通过 mergeConfig 复用 vite.config.ts，保证 @/ 别名在测试中与构建完全一致。
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
      setupFiles: ['./vitest.setup.ts'],
    },
  }),
)
