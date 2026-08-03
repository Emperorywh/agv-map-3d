import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // mapBuild.worker 为 module worker（SPEC §3.1：解码/校验/构建移出主线程）；
  // 多 chunk 依赖图要求 ES 格式产物（默认 iife 无法承载 module worker 的代码分割）
  worker: { format: 'es' },
})
