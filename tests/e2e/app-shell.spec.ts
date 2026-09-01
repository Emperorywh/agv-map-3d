/*
 * 应用骨架 E2E（真实浏览器，SPEC §7.1 / D2）。
 *
 * 职责：验证启动后页面始终只有一个占满视口的全屏 Canvas，
 * 且不存在滚动、模板残留文案或任何 DOM 覆盖层。
 * 关键不变量：
 * 1. canvas 元素数量恒为 1，尺寸覆盖 100vw × 100dvh；
 * 2. html/body 不产生任何滚动；
 * 3. 页面可见文本为空（无加载文案、无错误面板、无模板文案）；
 * 4. 不存在按钮、标题栏、导航、对话框等覆盖层元素。
 */
import { expect, test } from '@playwright/test'

test.describe('TASK-001 单 Canvas 应用骨架', () => {
  test('启动后只挂载一个全屏 Canvas 且无任何 DOM 覆盖层', async ({
    page,
  }) => {
    await page.goto('/')

    // 1. 唯一 Canvas
    const canvases = page.locator('canvas')
    await expect(canvases).toHaveCount(1)

    // 2. Canvas 占满视口（100vw × 100dvh，允许亚像素舍入误差）。
    // R3F 通过 ResizeObserver 异步完成首帧尺寸调整，因此轮询等待。
    const viewport = page.viewportSize()!
    await expect
      .poll(async () => (await canvases.first().boundingBox())?.width ?? 0, {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(viewport.width - 1)
    await expect
      .poll(async () => (await canvases.first().boundingBox())?.height ?? 0, {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(viewport.height - 1)

    // 3. 无页面滚动
    const scroll = await page.evaluate(() => ({
      x:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      y:
        document.documentElement.scrollHeight -
        document.documentElement.clientHeight,
    }))
    expect(scroll.x).toBeLessThanOrEqual(0)
    expect(scroll.y).toBeLessThanOrEqual(0)

    // 4. 无覆盖层元素与可见文案
    await expect(
      page.locator(
        'button, header, nav, aside, footer, dialog, input, select, textarea, [role="dialog"]',
      ),
    ).toHaveCount(0)
    const bodyText = (await page.locator('body').innerText()).trim()
    expect(bodyText).toBe('')
  })
})
