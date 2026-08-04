/**
 * 验收 harness 构建配置（SPEC §10.2/§15.2，测试专用）。
 *
 * 与生产 vite.config.ts 相同的插件与 worker 格式（module worker，§3.1），
 * 差异仅在打包边界：root 为 tests/harness（入口 index.html 与测试桥），
 * publicDir/envDir 显式指回仓库根——基准 /map.json 与 VITE_MAP_URL 语义
 * 与生产完全一致；产物输出到 dist-harness/（index.html 位于其根，
 * vite preview 直接以 / 提供服务）。
 * Playwright webServer 以 `vite preview --config tests/harness/vite.config.ts`
 * 提供被测服务。生产构建（pnpm build → dist/）不经过本配置，
 * harness 标识不进入生产包。
 */

import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: fileURLToPath(new URL('../../public', import.meta.url)),
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: [react()],
  // 与生产一致：mapBuild.worker 为 module worker，多 chunk 依赖图要求 ES 格式产物
  worker: { format: 'es' },
  build: {
    outDir: fileURLToPath(new URL('../../dist-harness', import.meta.url)),
    emptyOutDir: true,
  },
})
