#!/usr/bin/env node
/**
 * factory-map 架构依赖方向静态检查（SPEC §12）。
 *
 * 层依赖方向（功能目录 src/features/factory-map 内）：
 *   domain         → 不依赖任何其他层，也不依赖任何外部包（无 React/Three/DOM/fetch）
 *   application    → 只依赖 domain；不依赖 React/Three/fiber/drei
 *   infrastructure → 实现 application ports；可依赖 application/domain；禁止导入 React
 *   rendering      → 只消费 application 的 FactorySceneModel 契约与 domain 坐标语义，可依赖 config
 *   presentation   → 组合 application / rendering，并组装 infrastructure 适配器；禁止直接 fetch
 *   config         → 纯常量叶子层，不依赖任何层与外部包
 *
 * 另禁止：
 *   - presentation 出现 fetch 调用
 *   - rendering/scene 组件解析原始 JSON（JSON.parse）
 *   - 功能目录外的文件深层导入 factory-map 内部实现（只允许经 index.ts 公开出口）
 *   - 功能模块内文件导入功能目录外的实现
 *
 * *.test.ts(x) 测试文件不参与检查。
 *
 * 用法：
 *   node scripts/check-architecture.mjs                 检查仓库 src（默认）
 *   node scripts/check-architecture.mjs --root <目录>   检查指定源码根（目录下须含 features/factory-map）
 *   node scripts/check-architecture.mjs --self-test     负例自测：在临时目录生成含各方向违规导入的
 *                                                       夹具，断言检查以非零退出拒绝，不改动 src
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = dirname(dirname(scriptPath))

const FEATURE_ROOT_PARTS = ['features', 'factory-map']
const KNOWN_LAYERS = new Set([
  'domain',
  'application',
  'infrastructure',
  'rendering',
  'presentation',
  'config',
])

/** 各层允许依赖的功能内目标层（source → targets） */
const ALLOWED_LAYER_DEPS = {
  root: new Set(['root', ...KNOWN_LAYERS]),
  domain: new Set(['domain']),
  application: new Set(['application', 'domain']),
  infrastructure: new Set(['infrastructure', 'application', 'domain']),
  rendering: new Set(['rendering', 'application', 'domain', 'config']),
  presentation: new Set(['presentation', 'application', 'rendering', 'infrastructure', 'domain', 'config']),
  config: new Set(['config']),
}

/** application 禁止依赖的框架包（SPEC §12：application 不依赖 React/Three） */
const APPLICATION_FORBIDDEN_PACKAGES = new Set([
  'react',
  'react-dom',
  'three',
  '@react-three/fiber',
  '@react-three/drei',
])

/** infrastructure 禁止导入的包（SPEC §12：infrastructure 禁止导入 React） */
const INFRASTRUCTURE_FORBIDDEN_PACKAGES = new Set(['react', 'react-dom'])

const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts']
const CODE_SPECIFIER_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/
const SOURCE_FILE_RE = /\.(?:ts|tsx)$/
const TEST_FILE_RE = /\.test\.tsx?$/
const TYPE_ONLY_FILE_RE = /\.d\.ts$/

const IMPORT_PATTERNS = [
  /\b(?:import|export)\s+[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

/**
 * 去掉行注释与块注释，保留字符串字面量原样。
 * 注释字符替换为空格、换行保留，保证行列位置不变。
 * 简化假设：模板字面量内不嵌套含反引号的 ${} 表达式（本仓库与夹具均满足）。
 */
function stripComments(source) {
  const chars = source.split('')
  const n = source.length
  let state = 'code'
  let i = 0
  while (i < n) {
    const c = source[i]
    const next = i + 1 < n ? source[i + 1] : ''
    if (state === 'code') {
      if (c === '/' && next === '/') {
        chars[i] = ' '
        chars[i + 1] = ' '
        state = 'line'
        i += 2
        continue
      }
      if (c === '/' && next === '*') {
        chars[i] = ' '
        chars[i + 1] = ' '
        state = 'block'
        i += 2
        continue
      }
      if (c === "'") state = 'single'
      else if (c === '"') state = 'double'
      else if (c === '`') state = 'template'
      i += 1
      continue
    }
    if (state === 'line') {
      if (c === '\n') state = 'code'
      else chars[i] = ' '
      i += 1
      continue
    }
    if (state === 'block') {
      if (c === '*' && next === '/') {
        chars[i] = ' '
        chars[i + 1] = ' '
        state = 'code'
        i += 2
        continue
      }
      if (c !== '\n') chars[i] = ' '
      i += 1
      continue
    }
    if (c === '\\') {
      i += 2
      continue
    }
    if (state === 'single' && c === "'") state = 'code'
    else if (state === 'double' && c === '"') state = 'code'
    else if (state === 'template' && c === '`') state = 'code'
    i += 1
  }
  return chars.join('')
}

function lineOf(source, index) {
  let line = 1
  for (let i = 0; i < index; i += 1) {
    if (source[i] === '\n') line += 1
  }
  return line
}

/** 提取 import / export-from / 动态 import 的模块说明符及其位置 */
function extractImports(source) {
  const imports = []
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0
    let match = pattern.exec(source)
    while (match !== null) {
      imports.push({ specifier: match[1], index: match.index })
      match = pattern.exec(source)
    }
  }
  return imports
}

function packageNameOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

function isBareSpecifier(specifier) {
  return !specifier.startsWith('.') && !specifier.startsWith('/')
}

/** 带非代码扩展名的相对导入（css/svg/png 等资源）不参与依赖方向检查 */
function isAssetSpecifier(specifier) {
  const last = specifier.split('/').pop() ?? ''
  return last.includes('.') && !CODE_SPECIFIER_RE.test(last)
}

function resolveImport(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier)
  if (existsSync(base) && statSync(base).isFile()) return base
  for (const ext of CODE_EXTENSIONS) {
    const candidate = base + ext
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  for (const ext of CODE_EXTENSIONS) {
    const candidate = join(base, `index${ext}`)
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/**
 * 文件归类：external（功能目录外）或 internal（功能目录内，含层名）。
 * 功能根目录正下方的文件（index.ts）归为 root 层。
 */
function classifyFile(filePath, featureRoot) {
  if (!filePath.startsWith(featureRoot + sep)) return { scope: 'external', layer: null, rel: null }
  const rel = filePath.slice(featureRoot.length + 1).split(sep).join('/')
  if (!rel.includes('/')) return { scope: 'internal', layer: 'root', rel }
  const layer = rel.slice(0, rel.indexOf('/'))
  if (!KNOWN_LAYERS.has(layer)) return { scope: 'internal', layer: null, rel }
  return { scope: 'internal', layer, rel }
}

function listSourceFiles(srcRoot) {
  const out = []
  const stack = [srcRoot]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        stack.push(full)
        continue
      }
      if (!SOURCE_FILE_RE.test(entry.name)) continue
      if (TEST_FILE_RE.test(entry.name) || TYPE_ONLY_FILE_RE.test(entry.name)) continue
      out.push(full)
    }
  }
  return out.sort()
}

/**
 * 对指定源码根执行检查，返回 { violations, fileCount }。
 * violations 元素：{ file, line, rule, message }，file 为相对 srcRoot 的 POSIX 路径。
 */
function runCheck(srcRoot) {
  const violations = []
  const featureRoot = join(srcRoot, ...FEATURE_ROOT_PARTS)
  if (!existsSync(featureRoot)) {
    violations.push({
      file: FEATURE_ROOT_PARTS.join('/'),
      line: 1,
      rule: 'feature-missing',
      message: '缺少 src/features/factory-map 功能目录（SPEC §12）',
    })
    return { violations, fileCount: 0 }
  }

  const push = (file, source, index, rule, message) => {
    violations.push({
      file: relative(srcRoot, file).split(sep).join('/'),
      line: lineOf(source, index),
      rule,
      message,
    })
  }

  const files = listSourceFiles(srcRoot)
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'))
    const from = classifyFile(file, featureRoot)

    if (from.scope === 'internal' && from.layer === null) {
      push(file, source, 0, 'unknown-layer', `未知分层目录：${from.rel}（SPEC §12 固定了层清单）`)
      continue
    }

    for (const { specifier, index } of extractImports(source)) {
      if (isBareSpecifier(specifier)) {
        if (from.scope !== 'internal') continue
        const pkg = packageNameOf(specifier)
        if (from.layer === 'domain') {
          push(file, source, index, 'domain-external-dependency',
            `domain 不依赖任何外部包（无 React/Three/DOM/fetch），却导入 "${specifier}"`)
        } else if (from.layer === 'config') {
          push(file, source, index, 'config-external-dependency',
            `config 为纯常量叶子层，不得导入外部包 "${specifier}"`)
        } else if (from.layer === 'application' && APPLICATION_FORBIDDEN_PACKAGES.has(pkg)) {
          push(file, source, index, 'application-framework-dependency',
            `application 不依赖 React/Three，却导入 "${specifier}"`)
        } else if (from.layer === 'infrastructure' && INFRASTRUCTURE_FORBIDDEN_PACKAGES.has(pkg)) {
          push(file, source, index, 'infrastructure-react',
            `infrastructure 禁止导入 React，却导入 "${specifier}"`)
        }
        continue
      }

      if (isAssetSpecifier(specifier)) continue
      const target = resolveImport(file, specifier)
      if (target === null) {
        if (from.scope === 'internal') {
          push(file, source, index, 'unresolved-import', `无法解析的导入 "${specifier}"`)
        }
        continue
      }
      const to = classifyFile(target, featureRoot)

      if (from.scope === 'external') {
        if (to.scope === 'internal' && to.layer !== 'root') {
          push(file, source, index, 'deep-import',
            `跨目录深层导入 "${specifier}"：功能目录外只能经 features/factory-map/index.ts 公开出口访问`)
        }
        continue
      }

      if (to.scope !== 'internal') {
        push(file, source, index, 'feature-escape',
          `功能模块内文件不得导入功能目录外的实现 "${specifier}"`)
        continue
      }
      if (to.layer !== null && !ALLOWED_LAYER_DEPS[from.layer].has(to.layer)) {
        push(file, source, index, 'layer-direction',
          `层依赖方向违规：${from.layer} 不得依赖 ${to.layer}（导入 "${specifier}"）`)
      }
    }

    if (from.scope === 'internal' && from.layer === 'presentation') {
      const match = /\bfetch\s*\(/.exec(source)
      if (match !== null) {
        push(file, source, match.index, 'presentation-fetch',
          'presentation 禁止直接 fetch：请求必须经 application 用例与 infrastructure 适配器')
      }
    }
    if (from.scope === 'internal' && from.layer === 'rendering' && from.rel.startsWith('rendering/scene/')) {
      const match = /\bJSON\s*\.\s*parse\s*\(/.exec(source)
      if (match !== null) {
        push(file, source, match.index, 'scene-json-parse',
          'scene 组件禁止解析原始 JSON：只消费 application 的 FactorySceneModel')
      }
    }
  }

  return { violations, fileCount: files.length }
}

// ---------------------------------------------------------------------------
// --self-test：负例自测夹具
// ---------------------------------------------------------------------------

const COMPLIANT_FILES = {
  'main.tsx': [
    "import { FACTORY_MARGIN } from './features/factory-map'",
    'export const margin = FACTORY_MARGIN',
    '',
  ].join('\n'),
  'features/factory-map/index.ts': "export * from './config/sceneMetrics'\n",
  'features/factory-map/config/sceneMetrics.ts': 'export const FACTORY_MARGIN = 10\n',
  'features/factory-map/config/mapLoadConfig.ts': 'export const MAP_REQUEST_TIMEOUT_MS = 15_000\n',
  'features/factory-map/domain/coordinates.ts': [
    'export function mapToWorld(x: number, y: number): { x: number; z: number } {',
    '  return { x, z: -y }',
    '}',
    '',
  ].join('\n'),
  'features/factory-map/domain/limits.ts': 'export const MAX_MAP_BYTES = 20 * 1024 * 1024\n',
  'features/factory-map/application/ports/MapRepository.ts': [
    'export interface MapRepository {',
    '  fetchPayload(url: string): Promise<ArrayBuffer>',
    '}',
    '',
  ].join('\n'),
  'features/factory-map/application/loadFactoryMap.ts': [
    "import type { MapRepository } from './ports/MapRepository'",
    "import { MAX_MAP_BYTES } from '../domain/limits'",
    '',
    'export function loadFactoryMap(repository: MapRepository): Promise<ArrayBuffer> {',
    '  void MAX_MAP_BYTES',
    "  return repository.fetchPayload('/map.json')",
    '}',
    '',
  ].join('\n'),
  'features/factory-map/infrastructure/HttpMapRepository.ts': [
    "import type { MapRepository } from '../application/ports/MapRepository'",
    "import { MAX_MAP_BYTES } from '../domain/limits'",
    '',
    'export function createHttpMapRepository(): MapRepository {',
    '  void MAX_MAP_BYTES',
    '  return { fetchPayload: (url: string) => Promise.resolve(new ArrayBuffer(url.length)) }',
    '}',
    '',
  ].join('\n'),
  'features/factory-map/rendering/core/bindFactorySceneModel.ts': [
    "import { mapToWorld } from '../../domain/coordinates'",
    "import type { MapRepository } from '../../application/ports/MapRepository'",
    '',
    'export type BinderPorts = Pick<MapRepository, never>',
    'export function bindFactorySceneModel(): void {',
    '  void mapToWorld',
    '}',
    '',
  ].join('\n'),
  'features/factory-map/rendering/scene/FactoryCanvas.tsx': [
    "import { FACTORY_MARGIN } from '../../config/sceneMetrics'",
    "import { mapToWorld } from '../../domain/coordinates'",
    '',
    'export function FactoryCanvas(): number {',
    '  void mapToWorld',
    '  return FACTORY_MARGIN',
    '}',
    '',
  ].join('\n'),
  'features/factory-map/presentation/FactoryMapPageController.ts': [
    "import { loadFactoryMap } from '../application/loadFactoryMap'",
    "import { createHttpMapRepository } from '../infrastructure/HttpMapRepository'",
    "import { FactoryCanvas } from '../rendering/scene/FactoryCanvas'",
    "import { MAP_REQUEST_TIMEOUT_MS } from '../config/mapLoadConfig'",
    "import { MAX_MAP_BYTES } from '../domain/limits'",
    '',
    'export function createFactoryMapPageController(): void {',
    '  void loadFactoryMap',
    '  void createHttpMapRepository',
    '  void FactoryCanvas',
    '  void MAP_REQUEST_TIMEOUT_MS',
    '  void MAX_MAP_BYTES',
    '}',
    '',
  ].join('\n'),
}

const VIOLATING_FILES = {
  'features/factory-map/domain/badImportsApplication.ts':
    "import { loadFactoryMap } from '../application/loadFactoryMap'\nexport const bad = loadFactoryMap\n",
  'features/factory-map/domain/badImportsThree.ts':
    "import { Vector3 } from 'three'\nexport const bad = Vector3\n",
  'features/factory-map/application/badImportsInfraFromApplication.ts':
    "import { createHttpMapRepository } from '../infrastructure/HttpMapRepository'\nexport const bad = createHttpMapRepository\n",
  'features/factory-map/application/badImportsFramework.ts':
    "import { Scene } from 'three'\nexport const bad = Scene\n",
  'features/factory-map/infrastructure/badImportsReact.ts':
    "import { useEffect } from 'react'\nexport const bad = useEffect\n",
  'features/factory-map/infrastructure/badImportsPresentationFromInfra.ts':
    "import { createFactoryMapPageController } from '../presentation/FactoryMapPageController'\nexport const bad = createFactoryMapPageController\n",
  'features/factory-map/rendering/badImportsInfraFromRendering.ts':
    "import { createHttpMapRepository } from '../infrastructure/HttpMapRepository'\nexport const bad = createHttpMapRepository\n",
  'features/factory-map/rendering/badImportsPresentationFromRendering.ts':
    "import { createFactoryMapPageController } from '../presentation/FactoryMapPageController'\nexport const bad = createFactoryMapPageController\n",
  'features/factory-map/rendering/scene/badParsesJson.tsx':
    'export function parseRawMapJson(raw: string): unknown {\n  return JSON.parse(raw)\n}\n',
  'features/factory-map/presentation/badFetches.ts':
    "export async function loadMapDirectly(): Promise<Response> {\n  return fetch('/map.json')\n}\n",
  'features/factory-map/config/badImportsDomain.ts':
    "import { MAX_MAP_BYTES } from '../domain/limits'\nexport const bad = MAX_MAP_BYTES\n",
  'badDeepImport.ts':
    "import { mapToWorld } from './features/factory-map/domain/coordinates'\nexport const bad = mapToWorld\n",
}

/** 自测断言：违规夹具中每个文件名应触发对应规则 */
const EXPECTED_DETECTIONS = [
  ['badImportsApplication.ts', 'layer-direction'],
  ['badImportsThree.ts', 'domain-external-dependency'],
  ['badImportsInfraFromApplication.ts', 'layer-direction'],
  ['badImportsFramework.ts', 'application-framework-dependency'],
  ['badImportsReact.ts', 'infrastructure-react'],
  ['badImportsPresentationFromInfra.ts', 'layer-direction'],
  ['badImportsInfraFromRendering.ts', 'layer-direction'],
  ['badImportsPresentationFromRendering.ts', 'layer-direction'],
  ['badParsesJson.tsx', 'scene-json-parse'],
  ['badFetches.ts', 'presentation-fetch'],
  ['badImportsDomain.ts', 'layer-direction'],
  ['badDeepImport.ts', 'deep-import'],
]

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, ...rel.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
}

function runCli(srcRoot) {
  const result = spawnSync(process.execPath, [scriptPath, '--root', srcRoot], { encoding: 'utf8' })
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function runSelfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-map-arch-check-'))
  try {
    const compliantRoot = join(tmp, 'compliant', 'src')
    const violatingRoot = join(tmp, 'violating', 'src')
    writeTree(compliantRoot, COMPLIANT_FILES)
    writeTree(violatingRoot, { ...COMPLIANT_FILES, ...VIOLATING_FILES })

    const failures = []

    const compliantRun = runCli(compliantRoot)
    if (compliantRun.status !== 0) {
      failures.push(`合规夹具应退出 0，实际退出 ${compliantRun.status}：\n${compliantRun.output}`)
    }

    const violatingRun = runCli(violatingRoot)
    if (violatingRun.status === 0) {
      failures.push(`违规夹具应以非零退出拒绝，实际退出 0：\n${violatingRun.output}`)
    }
    const outputLines = violatingRun.output.split('\n')
    for (const [file, rule] of EXPECTED_DETECTIONS) {
      const detected = outputLines.some((line) => line.includes(file) && line.includes(`[${rule}]`))
      if (!detected) failures.push(`未检出预期违规：${file} 应触发规则 ${rule}`)
    }

    if (failures.length > 0) {
      console.error('架构检查自测失败：')
      for (const failure of failures) console.error(`  - ${failure}`)
      process.exitCode = 1
      return
    }
    console.log(
      `架构检查自测通过：合规夹具退出 0；违规夹具以非零退出拒绝，`
      + `${EXPECTED_DETECTIONS.length} 项预期违规全部检出；临时夹具已清理`,
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------

function printUsage() {
  console.log('用法：node scripts/check-architecture.mjs [--root <源码根目录>] [--self-test]')
}

function main() {
  let root = null
  let selfTest = false
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--self-test') {
      selfTest = true
    } else if (arg === '--root') {
      root = argv[i + 1]
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      printUsage()
      return
    } else {
      console.error(`未知参数：${arg}`)
      printUsage()
      process.exitCode = 2
      return
    }
  }

  if (selfTest) {
    runSelfTest()
    return
  }

  const srcRoot = resolve(root ?? join(repoRoot, 'src'))
  if (!existsSync(srcRoot)) {
    console.error(`源码根目录不存在：${srcRoot}`)
    process.exitCode = 2
    return
  }

  const { violations, fileCount } = runCheck(srcRoot)
  if (violations.length > 0) {
    console.error(`架构依赖检查发现 ${violations.length} 处违规：`)
    for (const violation of violations) {
      console.error(`  ${violation.file}:${violation.line} [${violation.rule}] ${violation.message}`)
    }
    process.exitCode = 1
    return
  }
  console.log(`架构依赖检查通过：${fileCount} 个源文件无违规（SPEC §12）`)
}

main()
