/**
 * 静态资源复制（SPEC §10.2；TASK-002）。
 *
 * 职责：生产构建后把仓库根目录 json/map.json 显式复制到 dist/json/map.json，
 *       并把 public/config.json 复制到 dist/config.json。
 * 边界：只做复制，不修改内容、不解析地图业务字段；不手工编辑 dist 中的
 *       构建产物（assets、index.html 由 Vite 生成）。
 * 关键不变量：地图进入 dist 必须经过本脚本，不依赖 Vite 默认 public 目录的
 *       偶然可见性；config.json 为公开运行时模板，禁止写入任何凭据。
 */
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')

const COPIES = [
  { source: path.join(ROOT, 'json', 'map.json'), target: path.join(DIST, 'json', 'map.json') },
  { source: path.join(ROOT, 'public', 'config.json'), target: path.join(DIST, 'config.json') },
]

for (const { source, target } of COPIES) {
  await mkdir(path.dirname(target), { recursive: true })
  await copyFile(source, target)
  const { size } = await stat(target)
  // 简单完整性交叉验证：源与目标字节数一致
  const sourceStat = await stat(source)
  if (size !== sourceStat.size) {
    console.error(`[copy-static-assets] 复制后大小不一致：${target}`)
    process.exit(1)
  }
  console.log(`[copy-static-assets] ${path.relative(ROOT, target)}（${size} 字节）`)
}

// config.json 是公开配置模板：这里做一次凭据字段静态防线检查
const configText = await readFile(path.join(DIST, 'config.json'), 'utf8')
const forbiddenKeyPattern = /(token|secret|password|apikey|api_key|credential)/i
if (forbiddenKeyPattern.test(configText)) {
  console.error('[copy-static-assets] config.json 疑似包含密钥或令牌字段，拒绝发布')
  process.exit(1)
}
console.log('[copy-static-assets] 完成')
