import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite 构建配置。
// 职责：定义唯一路径别名 @/ -> src/；所有构建与测试工具必须复用同一别名约定。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
