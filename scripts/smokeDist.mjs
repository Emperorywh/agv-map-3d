/**
 * 部署冒烟测试（SPEC §10.1 / E5；TASK-002）。
 *
 * 职责：以静态服务器从根路径「/」与子路径「/monitor/」提供同一个 dist，
 *       断言应用入口、运行时配置与地图资源在两种部署形态下均可用；另提供
 *       「/broken/」挂载（config.json 返回 500）用于浏览器自测「配置失败仍
 *       保持唯一清屏 Canvas」的场景。
 * 边界：HTTP 层冒烟，不解析地图业务字段、不做浏览器行为断言（后者由执行
 *       Task 的 Coding Agent 用浏览器自动化技能完成）。
 * 关键不变量：
 * 1. 三种挂载共用同一 dist 目录，不产生第二份构建产物；
 * 2. /monitor/ 下的所有资源都通过同一前缀访问，验证相对路径引用成立；
 * 3. 默认执行完检查即退出（exit 0/1）；传入 --hold 时检查通过后保持服务器
 *    运行，供浏览器自动化自测使用，Ctrl+C 结束。
 */
import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')

/** 挂载描述：prefix 为 URL 前缀；failPaths 内的路径强制返回 500 */
const MOUNTS = [
  { prefix: '/', failPaths: [] },
  { prefix: '/monitor/', failPaths: [] },
  { prefix: '/broken/', failPaths: ['/config.json'] },
]

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function createStaticServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const mount = MOUNTS.find(
        (item) => url.pathname === item.prefix || (item.prefix !== '/' && url.pathname.startsWith(item.prefix)),
      ) ?? MOUNTS[0]
      const relativePath = mount.prefix === '/' ? url.pathname : url.pathname.slice(mount.prefix.length - 1)
      const requestPath = path.posix.normalize(decodeURIComponent(relativePath))
      if (mount.failPaths.includes(requestPath)) {
        res.statusCode = 500
        res.end('simulated config failure')
        return
      }
      const filePath = path.resolve(DIST, `.${path.posix.join('/', requestPath)}`)
      // 目录穿越防护：解析结果必须仍在 dist 内
      if (!filePath.startsWith(DIST + path.sep) && filePath !== DIST) {
        res.statusCode = 403
        res.end()
        return
      }
      // 目录请求回退到 index.html，模拟静态主机的 SPA 行为
      let target = filePath
      if (!existsSync(target) || !(await stat(target)).isFile()) {
        target = path.join(filePath, 'index.html')
      }
      if (!existsSync(target) || !(await stat(target)).isFile()) {
        res.statusCode = 404
        res.end()
        return
      }
      res.setHeader('Content-Type', MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream')
      createReadStream(target).pipe(res)
    } catch {
      res.statusCode = 500
      res.end()
    }
  })
}

async function checkUrl(base, pathname, expectations) {
  const response = await fetch(`${base}${pathname}`)
  const body = await response.text()
  const problems = []
  if (response.status !== (expectations.status ?? 200)) {
    problems.push(`状态码 ${response.status}（期望 ${expectations.status ?? 200}）`)
  }
  // 仅当期望该路径返回正常 JSON 时才校验内容（/broken/ 的 500 属于预期行为）
  if (response.status === 200 && expectations.json) {
    try {
      JSON.parse(body)
    } catch {
      problems.push('响应不是合法 JSON')
    }
  }
  if (response.status === 200 && expectations.includes && !body.includes(expectations.includes)) {
    problems.push(`响应不包含「${expectations.includes}」`)
  }
  const label = `${base}${pathname}`
  if (problems.length === 0) {
    console.log(`[smoke-dist] 通过：${label}`)
    return true
  }
  console.error(`[smoke-dist] 失败：${label} -> ${problems.join('；')}`)
  return false
}

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error('[smoke-dist] dist/index.html 不存在，请先执行 pnpm build')
  process.exit(1)
}

const server = createStaticServer()
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const base = `http://127.0.0.1:${port}`

let ok = true
for (const mount of MOUNTS) {
  const prefix = mount.prefix
  const mountRoot = prefix === '/' ? '/' : prefix
  ok = (await checkUrl(base, mountRoot, { includes: 'id="root"' })) && ok
  ok = (await checkUrl(base, `${mountRoot}config.json`, {
    json: true,
    includes: '"dataSource"',
    status: mount.failPaths.includes('/config.json') ? 500 : 200,
  })) && ok
  ok = (await checkUrl(base, `${mountRoot}json/map.json`, { json: true })) && ok
}

if (!ok) {
  server.close()
  console.error('[smoke-dist] 冒烟检查存在失败项')
  process.exit(1)
}
console.log('[smoke-dist] 根路径与子路径静态冒烟全部通过')

if (process.argv.includes('--hold')) {
  console.log(`[smoke-dist] 保持服务器运行供浏览器自测：${base}/（根路径）、${base}/monitor/（子路径）、${base}/broken/（配置失败）`)
  console.log('[smoke-dist] 按 Ctrl+C 结束')
  process.on('SIGINT', () => {
    server.close()
    process.exit(0)
  })
} else {
  server.close()
}
