/**
 * §10.2 可重复性能基准（test:perf，验收人员在参考展厅机器上显式启动）。
 *
 * 流程（单一 Playwright 用例，全程同一页面会话）：
 * 1. 进入 harness 页面等待 ready（3840×2160 CSS 画布、deviceScaleFactor=1、
 *    有效 dpr=1、基准 /map.json、全部标签类别——由项目配置与生产代码保证）；
 * 2. 连续 10 轮装卸循环：采集 Worker prepare（preparing→ready）与主线程
 *    SceneModel 绑定耗时原始样本、渲染资源基线快照；
 * 3. PerformanceHarness 驱动相机：预热 10s → 全景 30s（初始 fit 距离、45°
 *    俯角、匀速 180°）→ 近景 30s（35m、45° 俯角、匀速 180°，触发标签上限），
 *    逐帧采样帧时间/draw calls/CSS2D DOM；
 * 4. 输出验收报告（硬件/浏览器完整版本/WebGL renderer 字符串/commit/
 *    数据文件 SHA-256/每项原始结果）到 tests/perf/reports/ 并随测试附件归档；
 * 5. §10.2 六项指标断言（任一失败即性能验收失败）。
 *
 * 本用例不修改任何渲染参数、标签策略与基准数据（§10.2 防规避）；质量口径
 * 快照（dpr/阴影尺寸/标签上限/绘制缓冲）作为证据写入报告。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import {
  gotoHarnessApp,
  runLoadUnloadCycles,
  runPerformanceBenchmark,
  waitAppReady,
} from '../shared/appPage'
import { collectAcceptanceEnvironment } from '../shared/env'
import { summarizeSamples } from '../shared/stats'

// §10.2 通过条件（SPEC 钉死值）
const FRAME_P95_MAX_MS = 33.3
const FRAME_P99_MAX_MS = 50
const LONG_TASK_MAX_MS = 100
const PREPARE_P95_MAX_MS = 500
const BIND_P95_MAX_MS = 16.7
const DRAW_CALLS_MAX = 25
const CSS2D_LABELS_MAX = 300
const CSS2D_CONTAINERS_MAX = 1
const LOAD_UNLOAD_CYCLES = 10

const reportsDir = fileURLToPath(new URL('./reports', import.meta.url))

test('§10.2 可重复性能基准：两阶段帧时间、长任务、prepare/绑定、预算与资源稳定性', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(900_000)
  await gotoHarnessApp(page)
  await waitAppReady(page)

  // 步骤 2：连续 10 轮装卸（prepare/绑定/资源稳定性原始样本）
  const cycles = await runLoadUnloadCycles(page, LOAD_UNLOAD_CYCLES)

  // 步骤 3：PerformanceHarness 三阶段相机驱动（页面已回到 ready 初始机位）
  const benchmark = await runPerformanceBenchmark(page)

  // 步骤 4：验收报告（先落盘再断言——失败时原始结果仍可诊断）
  const environment = collectAcceptanceEnvironment(browser.version())
  const prepareStats = summarizeSamples([...cycles.prepareMs])
  const bindStats = summarizeSamples([...cycles.bindMs])
  const maxLongTaskMs = benchmark.longTasks.reduce((max, entry) => Math.max(max, entry.duration), 0)
  const unloadBaseline = cycles.unloadedMemory[0]
  const unloadAfterTen = cycles.unloadedMemory[cycles.unloadedMemory.length - 1]
  const report = {
    spec: 'SPEC §10.2 可重复性能基准',
    generatedAt: environment.collectedAt,
    environment,
    webglRenderer: benchmark.webglRenderer,
    dataSha256: benchmark.dataSha256,
    quality: benchmark.quality,
    initialFit: benchmark.initialFit,
    thresholds: {
      frameP95MaxMs: FRAME_P95_MAX_MS,
      frameP99MaxMs: FRAME_P99_MAX_MS,
      longTaskMaxMs: LONG_TASK_MAX_MS,
      prepareP95MaxMs: PREPARE_P95_MAX_MS,
      bindP95MaxMs: BIND_P95_MAX_MS,
      drawCallsMax: DRAW_CALLS_MAX,
      css2dLabelsMax: CSS2D_LABELS_MAX,
      css2dContainersMax: CSS2D_CONTAINERS_MAX,
      loadUnloadCycles: LOAD_UNLOAD_CYCLES,
    },
    metrics: {
      frameTimePanoramic: benchmark.panoramic.stats,
      frameTimeNear: benchmark.near.stats,
      longTasks: {
        count: benchmark.longTasks.length,
        maxDurationMs: maxLongTaskMs,
        entries: benchmark.longTasks,
      },
      workerPrepare: { ...prepareStats, samplesMs: cycles.prepareMs },
      sceneModelBind: { ...bindStats, samplesMs: cycles.bindMs },
      drawCallAndDom: {
        maxDrawCalls: benchmark.maxDrawCalls,
        maxCss2dLabels: benchmark.maxCss2dLabels,
        maxCss2dContainers: benchmark.maxCss2dContainers,
      },
      resourceStability: {
        firstUnloadBaseline: unloadBaseline,
        afterLastUnload: unloadAfterTen,
        readyMemoryPerCycle: cycles.readyMemory,
        unloadedMemoryPerCycle: cycles.unloadedMemory,
        css2dContainersAfterUnload: cycles.css2dContainersAfterUnload,
      },
    },
    raw: {
      warmup: benchmark.warmup,
      panoramic: benchmark.panoramic,
      near: benchmark.near,
    },
  }
  mkdirSync(reportsDir, { recursive: true })
  const reportPath = fileURLToPath(
    new URL(`./reports/perf-report-${environment.collectedAt.replace(/[:.]/g, '-')}.json`, import.meta.url),
  )
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  await testInfo.attach('performance-report', { path: reportPath, contentType: 'application/json' })
  console.log('§10.2 验收报告已写入', reportPath)
  console.log('§10.2 指标摘要', {
    panoramic: benchmark.panoramic.stats,
    near: benchmark.near.stats,
    longTaskMaxMs: maxLongTaskMs,
    prepareP95Ms: prepareStats.p95,
    bindP95Ms: bindStats.p95,
    maxDrawCalls: benchmark.maxDrawCalls,
    maxCss2dLabels: benchmark.maxCss2dLabels,
  })

  // 步骤 5：§10.2 六项指标断言（任一失败即性能验收失败）
  // ① 帧时间：全景阶段 p95 ≤33.3ms 且 p99 ≤50ms
  expect(benchmark.panoramic.stats.p95Ms).toBeLessThanOrEqual(FRAME_P95_MAX_MS)
  expect(benchmark.panoramic.stats.p99Ms).toBeLessThanOrEqual(FRAME_P99_MAX_MS)
  // ① 帧时间：近景阶段 p95 ≤33.3ms 且 p99 ≤50ms
  expect(benchmark.near.stats.p95Ms).toBeLessThanOrEqual(FRAME_P95_MAX_MS)
  expect(benchmark.near.stats.p99Ms).toBeLessThanOrEqual(FRAME_P99_MAX_MS)
  // ② 主线程长任务：ready 后测试阶段（预热+两阶段）无 >100ms long task
  expect(maxLongTaskMs).toBeLessThanOrEqual(LONG_TASK_MAX_MS)
  // ③ Worker prepare：连续 10 次 p95 ≤500ms
  expect(prepareStats.p95).toBeLessThanOrEqual(PREPARE_P95_MAX_MS)
  // ④ 主线程 SceneModel 绑定：p95 ≤16.7ms
  expect(bindStats.p95).toBeLessThanOrEqual(BIND_P95_MAX_MS)
  // ⑤ §10.1 硬上限：全程 draw calls ≤25（含阴影 pass）、CSS2D 标签 ≤300、容器 ≤1
  expect(benchmark.maxDrawCalls).toBeLessThanOrEqual(DRAW_CALLS_MAX)
  expect(benchmark.maxCss2dLabels).toBeLessThanOrEqual(CSS2D_LABELS_MAX)
  expect(benchmark.maxCss2dContainers).toBeLessThanOrEqual(CSS2D_CONTAINERS_MAX)
  // ⑥ §10.3 资源稳定性：10 次装卸后回到首次卸载后基线，CSS2D 容器数为 0
  expect(unloadAfterTen.geometries).toBe(unloadBaseline.geometries)
  expect(unloadAfterTen.textures).toBe(unloadBaseline.textures)
  for (const containers of cycles.css2dContainersAfterUnload) {
    expect(containers).toBe(0)
  }
})
