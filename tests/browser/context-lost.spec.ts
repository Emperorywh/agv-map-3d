/**
 * §15.2 显式浏览器测试 ④：context lost 进入 WebGLUnavailableError 错误态（§11）。
 *
 * 经 WEBGL_lose_context 扩展对渲染 canvas 触发真实 context lost：
 * 页面进入全屏错误态（稳定错误码 WEBGL_CONTEXT_LOST、中文标题
 * 「无法初始化三维渲染」、提示硬件/浏览器不支持）、场景卸载（canvas 摘除）、
 * 动作按钮为「刷新页面」且可聚焦启用；不自动恢复旧场景（错误态持续）。
 */

import { expect, test } from '@playwright/test'

import {
  getAppStatus,
  gotoHarnessApp,
  isSceneLive,
  waitAppReady,
} from '../shared/appPage'

test('context lost → WebGLUnavailableError 全屏错误态，不自动恢复', async ({ page }) => {
  await gotoHarnessApp(page)
  await waitAppReady(page)

  await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    if (canvas === null) throw new Error('canvas 不存在')
    const gl = canvas.getContext('webgl2')
    if (gl === null) throw new Error('WebGL2 上下文不存在')
    const loseContext = gl.getExtension('WEBGL_lose_context')
    if (loseContext === null) throw new Error('WEBGL_lose_context 扩展不可用')
    loseContext.loseContext()
  })

  // 错误面板：稳定错误码 + 标题 + 提示（errorViewModel §11 WebGLUnavailableError 行）
  const codeLine = page.locator('.page-state-view__code')
  await expect(codeLine).toContainText('WEBGL_CONTEXT_LOST')
  await expect(page.locator('.page-state-view__title')).toHaveText('无法初始化三维渲染')
  await expect(page.locator('.page-state-view__panel')).toContainText('刷新页面')

  // 场景卸载、不自动恢复
  await expect.poll(() => isSceneLive(page)).toBe(false)
  expect(await getAppStatus(page)).toBe('error')
  await expect(page.locator('canvas')).toHaveCount(0)

  // 唯一动作按钮为「刷新页面」，原生 button 可聚焦且启用（§1.4/§11）
  const action = page.locator('.page-state-view__button')
  await expect(action).toHaveText('刷新页面')
  await expect(action).toBeEnabled()
  await action.focus()
  await expect(action).toBeFocused()

  // 持续观察：不自动恢复旧场景（错误态保持，无 canvas 重建）
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
  expect(await getAppStatus(page)).toBe('error')
  await expect(page.locator('canvas')).toHaveCount(0)
})
