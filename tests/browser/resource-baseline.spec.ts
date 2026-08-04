/**
 * §15.2 显式浏览器测试 ⑤：连续加载/卸载地图 10 次后的资源基线（§10.2/§10.3）。
 *
 * 经测试桥驱动 controller.start() 完成 10 轮「卸载 → 重新加载」循环，断言：
 * - 第 10 次卸载后的 renderer.info.memory.geometries/textures 回到首次卸载后
 *   的基线（逐轮快照相等）；
 * - 每轮 ready 态的资源快照恒定（无跨轮累积）；
 * - 每轮卸载后 CSS2D 容器数为 0；
 * - 循环结束后页面回到 ready 且场景可用。
 * 每轮还记录 Worker prepare 与主线程绑定耗时原始样本（供报告/诊断；
 * §10.2 阈值断言在 test:perf 中执行）。
 */

import { expect, test } from '@playwright/test'

import {
  getRenderInfo,
  gotoHarnessApp,
  isSceneLive,
  renderFrames,
  runLoadUnloadCycles,
  waitAppReady,
} from '../shared/appPage'

test('连续装卸 10 次：渲染资源回到首次卸载后基线，CSS2D 容器数为 0', async ({ page }) => {
  test.setTimeout(300_000)
  await gotoHarnessApp(page)
  await waitAppReady(page)

  const report = await runLoadUnloadCycles(page, 10)

  expect(report.cycles).toBe(10)
  expect(report.prepareMs).toHaveLength(10)
  expect(report.bindMs).toHaveLength(10)

  // 首次卸载后基线 vs 第 10 次卸载后
  const baseline = report.unloadedMemory[0]
  const afterTen = report.unloadedMemory[9]
  expect(afterTen.geometries).toBe(baseline.geometries)
  expect(afterTen.textures).toBe(baseline.textures)

  // 逐轮卸载快照全部等于基线（无逐轮增长），且 CSS2D 容器数均为 0
  for (const snapshot of report.unloadedMemory) {
    expect(snapshot.geometries).toBe(baseline.geometries)
    expect(snapshot.textures).toBe(baseline.textures)
  }
  for (const containers of report.css2dContainersAfterUnload) {
    expect(containers).toBe(0)
  }

  // 每轮 ready 态资源快照恒定（稳态无累积）
  const firstReady = report.readyMemory[0]
  for (const snapshot of report.readyMemory) {
    expect(snapshot.geometries).toBe(firstReady.geometries)
    expect(snapshot.textures).toBe(firstReady.textures)
  }

  // 循环结束：页面 ready、场景存活、仍可实际渲染
  await expect.poll(() => isSceneLive(page)).toBe(true)
  await renderFrames(page, 2)
  const info = await getRenderInfo(page)
  expect(info).not.toBeNull()
  expect(info!.calls).toBeGreaterThan(0)

  // 原始样本打到测试输出，便于诊断（阈值断言由 test:perf 执行）
  console.log('§10.3 装卸循环原始样本', {
    prepareMs: report.prepareMs.map((v) => Math.round(v * 100) / 100),
    bindMs: report.bindMs.map((v) => Math.round(v * 100) / 100),
    unloadBaseline: baseline,
    readySteadyState: firstReady,
  })
})
