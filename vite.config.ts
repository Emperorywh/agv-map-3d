import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Vite 构建配置。
// 职责：
// 1. 定义唯一路径别名 @/ -> src/；所有构建与测试工具必须复用同一别名约定；
// 2. base './' 让同一构建产物的资源引用全部为相对路径，根路径与子路径部署
//    共用一个 dist（SPEC §10.1 / E5），运行时配置经 document.baseURI 解析；
// 3. 开发服务器显式把仓库根目录 json/ 映射为 ./json/map.json（SPEC §10.2），
//    不依赖 Vite 默认 public 目录的偶然可见性。
// 关键不变量：生产构建流程由 scripts/copyStaticAssets.mjs 显式复制地图到
// dist/json/map.json，并由 scripts/verifyDist.mjs 校验产物完整性。
const ROOT_DIR = __dirname

/** 允许经开发服务器访问的仓库根目录 json 资源（白名单防目录穿越） */
const DEV_JSON_FILES = new Set(['/map.json', '/vehicle.json'])

/**
 * 开发服务器中间件：把 /json/map.json、/json/vehicle.json 映射到仓库根目录
 * json/ 下的同名文件，使本地开发与生产部署的资源 URL 完全一致。
 */
function serveDevJsonAssets(): Plugin {
  return {
    name: 'agv-serve-dev-json-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/json', (req, res, next) => {
        const requestPath = path.posix.normalize(new URL(req.url ?? '/', 'http://localhost').pathname)
        if (!DEV_JSON_FILES.has(requestPath)) {
          next()
          return
        }
        const filePath = path.resolve(ROOT_DIR, 'json', `.${requestPath}`)
        try {
          const data = fs.readFileSync(filePath)
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Cache-Control', 'no-cache')
          res.end(data)
        } catch {
          res.statusCode = 404
          res.end()
        }
      })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), serveDevJsonAssets()],
  resolve: {
    alias: {
      '@': path.resolve(ROOT_DIR, 'src'),
    },
  },
})
