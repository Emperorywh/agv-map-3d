/*
 * 架构依赖边界检查（`pnpm test:architecture`）。
 *
 * 职责：
 * 1. 用 `.dependency-cruiser.cjs` 的规则校验真实 `src/`：零违规才通过；
 * 2. 用负例夹具证明「深层导入、反向依赖、循环依赖」一定会被抓到；
 * 3. 用正例夹具证明合法依赖方向不产生误报。
 *
 * 关键不变量：真实源码与夹具共用同一套规则；任一断言失败即整体失败（exit 1）。
 * 该脚本同时服务于本地验证与快速 CI。
 */
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { cruise } from 'dependency-cruiser'

const require = createRequire(import.meta.url)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ruleSet = require(path.join(ROOT, '.dependency-cruiser.cjs'))

/** 负例夹具必须命中的规则名与次数（证明规则真实生效，而非静默通过）。 */
const EXPECTED_VIOLATIONS = {
  'app-feature-public-entry-only': 1,
  'feature-map-visualization-deep-import-forbidden': 2,
  'core-feature-render-quality-no-cross-feature-import': 1,
  // camera→render-quality/index 与 mock-simulation→map-visualization/internal 各一次
  'adapter-camera-navigation-public-entry-only': 1,
  'adapter-mock-simulation-public-entry-only': 1,
  'shared-independence': 1,
  'no-feature-to-app-import': 1,
}

/**
 * 以指定 baseDir 运行 dependency-cruiser，返回按规则名归并的违规计数。
 */
async function cruiseAndCount(baseDir, target, extraOptions = {}) {
  const result = await cruise([target], {
    baseDir,
    ruleSet,
    validate: true,
    outputType: 'json',
    doNotFollow: { path: 'node_modules' },
    ...extraOptions,
  })
  const output =
    typeof result.output === 'string' ? JSON.parse(result.output) : result.output
  const counts = {}
  for (const violation of output.summary.violations) {
    const name =
      typeof violation.rule === 'string' ? violation.rule : violation.rule.name
    counts[name] = (counts[name] ?? 0) + 1
  }
  return { counts, moduleCount: output.summary.totalCruised ?? 0 }
}

function fail(message, counts) {
  console.error(`✗ 架构检查失败：${message}`)
  for (const [rule, count] of Object.entries(counts ?? {})) {
    console.error(`  - ${rule}: ${count}`)
  }
  process.exit(1)
}

async function main() {
  // 1. 真实源码必须零违规。tsConfig 使 @/ 别名与 TypeScript 解析保持一致。
  const real = await cruiseAndCount(ROOT, 'src', {
    tsConfig: path.join(ROOT, 'tsconfig.app.json'),
  })
  if (Object.keys(real.counts).length > 0) {
    fail('真实 src 存在依赖边界违规', real.counts)
  }
  console.log(`✓ 真实 src 依赖边界通过（${real.moduleCount} 个模块，0 违规）`)

  // 2. 负例夹具：每条期望规则必须以精确次数命中，证明规则生效且无误伤。
  // 以夹具根为 baseDir、'src' 为目标运行，保证模块路径与真实 src 规则前缀一致。
  const violations = await cruiseAndCount(
    path.join(ROOT, 'scripts/architecture/fixtures/violations'),
    'src',
  )
  for (const [rule, expected] of Object.entries(EXPECTED_VIOLATIONS)) {
    if ((violations.counts[rule] ?? 0) !== expected) {
      fail(
        `负例夹具期望规则 ${rule} 命中 ${expected} 次，实际 ${violations.counts[rule] ?? 0} 次`,
        violations.counts,
      )
    }
  }
  if ((violations.counts['no-circular'] ?? 0) < 1) {
    fail('负例夹具未检出循环依赖（no-circular）', violations.counts)
  }
  const unexpected = Object.keys(violations.counts).filter(
    (rule) =>
      rule !== 'no-circular' && !(rule in EXPECTED_VIOLATIONS),
  )
  if (unexpected.length > 0) {
    fail(`负例夹具出现非预期违规规则：${unexpected.join(', ')}`, violations.counts)
  }
  console.log('✓ 负例夹具全部命中：深层导入、核心 Feature 互导、受限入口、反向依赖、循环依赖')

  // 3. 正例夹具：合法依赖方向必须零违规，排除误报。
  const positive = await cruiseAndCount(
    path.join(ROOT, 'scripts/architecture/fixtures/positive'),
    'src',
  )
  if (Object.keys(positive.counts).length > 0) {
    fail('正例夹具不应产生任何违规', positive.counts)
  }
  console.log('✓ 正例夹具零违规：公开入口、Feature→shared 方向未被误报')

  console.log('架构检查全部通过')
}

main().catch((error) => {
  console.error('✗ 架构检查异常终止：', error?.message ?? error)
  process.exit(1)
})
