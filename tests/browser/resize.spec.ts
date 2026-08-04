/**
 * §15.2 显式浏览器测试 ③：resize（含 0 维暂停/恢复行为，§1.4）。
 *
 * 验证链：
 * 1. 正常视口缩放（1280×720 → 1100×800）：drawing buffer 与相机 aspect
 *    随新尺寸重算（dpr=1 口径），渲染继续；
 * 2. 宿主 0 维（#root 宽度置 0，模拟 viewport 任一维为 0）：R3F 守卫跳过
 *    configure——drawing buffer 与相机 aspect 保持暂停前数值（不执行
 *    setSize/render），CSS2D 容器尺寸同样保持（适配器 0 维跳过 setSize），
 *    页面保持 ready 不报错；
 * 3. 恢复正数并再次改变视口（→ 1280×720）：重新 configure，aspect/buffer
 *    重算，实际渲染帧恢复（draw calls > 0）。
 */

import { expect, test } from '@playwright/test'

import {
  countCss2dContainers,
  getAppStatus,
  getCameraPose,
  getDrawingBufferSize,
  getRenderInfo,
  gotoHarnessApp,
  renderFrames,
  waitAppReady,
} from '../shared/appPage'

test('resize：正常缩放重算投影、0 维暂停、恢复后继续渲染', async ({ page }) => {
  test.setTimeout(120_000)
  await gotoHarnessApp(page)
  await waitAppReady(page)
  await renderFrames(page, 2)

  // 1. 正常 resize：1100×800（aspect 1.375，区别于初始 16:9 以观测变化）
  await page.setViewportSize({ width: 1100, height: 800 })
  await expect
    .poll(async () => (await getDrawingBufferSize(page))?.width)
    .toBe(1100)
  const resizedBuffer = await getDrawingBufferSize(page)
  expect(resizedBuffer).toEqual({ width: 1100, height: 800 })
  const resizedPose = await getCameraPose(page)
  expect(resizedPose).not.toBeNull()
  expect(resizedPose!.aspect).toBeCloseTo(1100 / 800, 5)
  // CSS2D 容器尺寸随宿主同步（1100px）
  const containerWidthBeforePause = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    const host = canvas?.parentElement
    if (host === null || host === undefined) return ''
    for (let i = 0; i < host.children.length; i += 1) {
      const child = host.children[i]
      if (child !== canvas && child instanceof HTMLElement) return child.style.width
    }
    return ''
  })
  expect(containerWidthBeforePause).toBe('1100px')

  // 2. 0 维暂停：宿主宽度置 0 → 不执行 setSize/render，数值保持暂停前
  await page.evaluate(() => {
    document.getElementById('root')!.style.width = '0px'
  })
  // 等待两个 rAF 让 ResizeObserver/效应有机会（错误地）生效，再断言未被应用
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
  expect(await getAppStatus(page)).toBe('ready')
  const pausedBuffer = await getDrawingBufferSize(page)
  expect(pausedBuffer).toEqual({ width: 1100, height: 800 })
  const pausedPose = await getCameraPose(page)
  expect(pausedPose!.aspect).toBeCloseTo(1100 / 800, 5)
  const containerWidthPaused = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    const host = canvas?.parentElement
    if (host === null || host === undefined) return ''
    for (let i = 0; i < host.children.length; i += 1) {
      const child = host.children[i]
      if (child !== canvas && child instanceof HTMLElement) return child.style.width
    }
    return ''
  })
  expect(containerWidthPaused).toBe('1100px')
  expect(await countCss2dContainers(page)).toBe(1)

  // 3. 恢复：取消 0 维并改变视口 → 重新 configure，投影重算，渲染恢复
  await page.evaluate(() => {
    document.getElementById('root')!.style.width = ''
  })
  await page.setViewportSize({ width: 1280, height: 720 })
  await expect
    .poll(async () => (await getDrawingBufferSize(page))?.width)
    .toBe(1280)
  const recoveredPose = await getCameraPose(page)
  expect(recoveredPose!.aspect).toBeCloseTo(1280 / 720, 5)
  await renderFrames(page, 2)
  const info = await getRenderInfo(page)
  expect(info).not.toBeNull()
  expect(info!.calls).toBeGreaterThan(0)
  expect(info!.triangles).toBeGreaterThan(0)
})
