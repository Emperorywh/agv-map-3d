/**
 * 发布产物完整性校验（SPEC §10.2 / E5；TASK-002）。
 *
 * 职责：校验 dist 包含可运行应用、公开配置模板与地图资源，且资源引用为
 *       相对路径（同一产物支持根路径与子路径部署）。
 * 边界：只做产物级静态检查，不启动服务器（冒烟见 scripts/smokeDist.mjs）、
 *       不解析地图业务字段。
 * 关键不变量：
 * 1. dist/index.html、dist/config.json、dist/json/map.json 缺一即失败；
 * 2. index.html 的脚本与样式引用不得以 / 开头（绝对根路径引用会破坏子路径部署）；
 * 3. config.json 顶层字段必须落在运行时配置白名单内且不含疑似凭据字段。
 */
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')

const failures = []
function check(condition, message) {
  if (condition) {
    console.log(`[verify-dist] 通过：${message}`)
  } else {
    failures.push(message)
    console.error(`[verify-dist] 失败：${message}`)
  }
}

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

// 1. 应用入口
const indexPath = path.join(DIST, 'index.html')
check(await exists(indexPath), 'dist/index.html 存在')
let indexHtml = ''
if (await exists(indexPath)) {
  indexHtml = await readFile(indexPath, 'utf8')
  check(indexHtml.includes('id="root"'), 'index.html 含 #root 挂载点')
  check(/<script[^>]+src=/.test(indexHtml), 'index.html 引用了打包脚本')
}

// 2. 资源引用必须是相对路径（子路径部署前提，SPEC E5）
const absoluteRefs = indexHtml.match(/(?:src|href)="\/[^/"]*"/g) ?? []
check(
  absoluteRefs.length === 0,
  absoluteRefs.length === 0
    ? 'index.html 资源引用全部为相对路径'
    : `index.html 存在绝对根路径引用：${absoluteRefs.join(', ')}`,
)

// 3. 运行时配置模板
const configPath = path.join(DIST, 'config.json')
check(await exists(configPath), 'dist/config.json 存在')
if (await exists(configPath)) {
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    // 白名单必须与 src/app/bootstrap/loadRuntimeConfig.ts 保持一致
    const allowedKeys = new Set([
      'dataSource',
      'mapUrl',
      'wsUrl',
      'maxVehicles',
      'staleAfterMs',
      'renderer',
      'coordinateTransform',
    ])
    const unknownKeys = Object.keys(config).filter((key) => !allowedKeys.has(key))
    check(unknownKeys.length === 0, `config.json 顶层字段在白名单内（未知字段：${unknownKeys.join(', ') || '无'}）`)
    check(
      config.dataSource === 'mock' || config.dataSource === 'ws',
      `config.json dataSource 合法（当前：${String(config.dataSource)}）`,
    )
    const credentialPattern = /(token|secret|password|apikey|api_key|credential)/i
    check(!credentialPattern.test(JSON.stringify(config)), 'config.json 不含疑似凭据字段')
  } catch (error) {
    check(false, `config.json 可解析（错误：${error.message}）`)
  }
}

// 4. 地图资源
const mapPath = path.join(DIST, 'json', 'map.json')
check(await exists(mapPath), 'dist/json/map.json 存在')
if (await exists(mapPath)) {
  const { size } = await stat(mapPath)
  check(size > 0, `map.json 非空（${size} 字节）`)
  try {
    const map = JSON.parse(await readFile(mapPath, 'utf8'))
    check(map !== null && typeof map === 'object', 'map.json 是合法 JSON 对象')
  } catch (error) {
    check(false, `map.json 可解析（错误：${error.message}）`)
  }
}

if (failures.length > 0) {
  console.error(`[verify-dist] 共 ${failures.length} 项检查失败`)
  process.exit(1)
}
console.log('[verify-dist] 发布产物完整性校验全部通过')
