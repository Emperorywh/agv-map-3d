/**
 * §15.2 显式浏览器测试 ②：CSS2D 生命周期与卸载后容器数为 0。
 *
 * 覆盖（§8/§10.1/§10.3）：初始全景无标签（基准地图初始 fit 距离约 189m，
 * 超出站点 90m 进入迟滞）→ 驱动到 35m 近景后标签出现且 ≤300、容器恰 1 个 →
 * 新一轮加载（controller.start）卸载场景后 CSS2D 容器数为 0、标签为 0 →
 * 再次 ready 后标签系统完整重建可用（StrictMode/重复挂载幂等）。
 */

import { expect, test } from '@playwright/test'

import {
  countCss2dContainers,
  countCss2dLabels,
  getCameraPose,
  gotoHarnessApp,
  renderFrames,
  setCameraOrbit,
  startLoad,
  waitAppReady,
  waitCanvasDetached,
} from '../shared/appPage'

test('CSS2D 生命周期：近景出现标签、卸载后容器数为 0、重载后完整重建', async ({ page }) => {
  test.setTimeout(180_000)
  await gotoHarnessApp(page)
  await waitAppReady(page)

  // 初始全景：无标签（§17 验收锚点），容器随 LabelLayer 挂载存在且唯一
  await renderFrames(page, 3)
  await expect.poll(() => countCss2dLabels(page)).toBe(0)
  expect(await countCss2dContainers(page)).toBe(1)

  // 35m 近景（45° 俯角）：标签出现且满足 §10.1 DOM 预算（≤300，容器恰 1 个）
  const initial = await getCameraPose(page)
  expect(initial).not.toBeNull()
  await setCameraOrbit(page, {
    target: initial!.target,
    distance: 35,
    polarDeg: 45,
    azimuthDeg: initial!.azimuthDeg,
  })
  await renderFrames(page, 5)
  const labels = await countCss2dLabels(page)
  expect(labels).toBeGreaterThan(0)
  expect(labels).toBeLessThanOrEqual(300)
  expect(await countCss2dContainers(page)).toBe(1)

  // 新一轮加载：场景卸载（canvas 摘除即卸载标志）→ CSS2D 容器与标签全部清理（§10.3）
  await startLoad(page)
  await waitCanvasDetached(page)
  expect(await countCss2dContainers(page)).toBe(0)
  expect(await countCss2dLabels(page)).toBe(0)

  // 再次 ready：标签系统重建，近景标签恢复出现
  await waitAppReady(page)
  const refit = await getCameraPose(page)
  expect(refit).not.toBeNull()
  await setCameraOrbit(page, {
    target: refit!.target,
    distance: 35,
    polarDeg: 45,
    azimuthDeg: refit!.azimuthDeg,
  })
  await renderFrames(page, 5)
  await expect.poll(() => countCss2dLabels(page)).toBeGreaterThan(0)
  expect(await countCss2dContainers(page)).toBe(1)
})
