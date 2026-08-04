/**
 * §15.2 显式浏览器测试 ①：WebGL2 初始化成功渲染。
 *
 * 验证 harness 页面（与生产完全相同的场景组合）在真实浏览器中：
 * WebGL2 上下文创建成功、R3F 场景挂载、demand 帧驱动下产生实际渲染
 * （draw calls > 0 且三角形数 > 0）、dpr 公式口径下 drawing buffer
 * 与 CSS 尺寸一致（1280×720 视口 deviceScaleFactor=1 → 有效 dpr=1）、
 * 页面无错误 overlay。
 */

import { expect, test } from '@playwright/test'

import {
  getCameraPose,
  getDrawingBufferSize,
  getRenderInfo,
  getWebGLRendererString,
  gotoHarnessApp,
  isSceneLive,
  renderFrames,
  waitAppReady,
} from '../shared/appPage'

test('WebGL2 初始化成功并完成实际渲染', async ({ page }) => {
  await gotoHarnessApp(page)
  await waitAppReady(page)

  // WebGL2 上下文：canvas.getContext('webgl2') 返回与渲染器相同的上下文
  const isWebGL2 = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    if (canvas === null) return false
    return canvas.getContext('webgl2') instanceof WebGL2RenderingContext
  })
  expect(isWebGL2).toBe(true)

  // 场景已挂载且渲染器可观测
  await expect.poll(() => isSceneLive(page)).toBe(true)
  const rendererString = await getWebGLRendererString(page)
  expect(rendererString === null || rendererString.length === 0).toBe(false)

  // 两个实际渲染帧后：draw calls 与三角形数证明真实绘制发生
  await renderFrames(page, 2)
  const info = await getRenderInfo(page)
  expect(info).not.toBeNull()
  expect(info!.calls).toBeGreaterThan(0)
  expect(info!.triangles).toBeGreaterThan(0)

  // §6.6 dpr 公式口径：1280×720 CSS、deviceScaleFactor=1 → 有效 dpr=1
  const buffer = await getDrawingBufferSize(page)
  expect(buffer).toEqual({ width: 1280, height: 720 })

  // 相机为初始 fit 机位（45° 俯角，aspect 与视口一致）
  const pose = await getCameraPose(page)
  expect(pose).not.toBeNull()
  expect(pose!.polarDeg).toBeCloseTo(45, 1)
  expect(pose!.aspect).toBeCloseTo(1280 / 720, 5)

  // 无错误 overlay（§11 错误面板不存在）
  await expect(page.locator('.page-state-view')).toHaveCount(0)
})
