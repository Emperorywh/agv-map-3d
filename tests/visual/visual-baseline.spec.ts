/**
 * §15.3 视觉基线捕获（验收人员显式启动：pnpm test:visual）。
 *
 * 使用基准地图固定保存三张 3840×2160 截图到 tests/visual/baseline/：
 *   01-initial-panorama.png —— 初始全景（§9.1 fit 机位，45° 斜视，不触碰相机）
 *   02-near-35m.png         —— 35m 近景（距 target 35m、45° 俯角）
 *   03-low-polar-80deg.png  —— polarAngle=80° 低视线（距地平线 10°）
 * 同目录写 manifest.json（环境/WebGL renderer/数据 SHA-256/三机位实际位姿），
 * 供产品验收人一次性确认配色、曝光、雾、阴影和建筑观感；确认后的三张图即
 * 后续视觉回归基线。
 *
 * 画布 3840×2160、deviceScaleFactor=1（dpr=1 口径）由 playwright.config.ts
 * 的 visual 项目固定；frameloop='demand' 下每机位驱动若干实际渲染帧后截图。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import {
  getCameraPose,
  getDataSha256,
  getWebGLRendererString,
  gotoHarnessApp,
  renderFrames,
  setCameraOrbit,
  waitAppReady,
} from '../shared/appPage'
import { collectAcceptanceEnvironment } from '../shared/env'
import type { CameraPoseSnapshot } from '../shared/testBridge'

const baselineDir = fileURLToPath(new URL('./baseline', import.meta.url))

const SHOTS = [
  { file: '01-initial-panorama.png', label: '初始全景（§9.1 fit 机位，45° 斜视）' },
  { file: '02-near-35m.png', label: '35m 近景（距 target 35m、45° 俯角）' },
  { file: '03-low-polar-80deg.png', label: 'polarAngle=80° 低视线（距地平线 10°）' },
] as const

/** PNG IHDR 宽高（字节 16..24，大端），断言产物确为 3840×2160 */
function pngSize(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

test('§15.3 视觉基线：3840×2160 三机位截图到固定目录', async ({ page, browser }) => {
  test.setTimeout(300_000)
  await gotoHarnessApp(page)
  await waitAppReady(page)

  const webglRenderer = await getWebGLRendererString(page)
  const dataSha256 = await getDataSha256(page)

  const initial = await getCameraPose(page)
  expect(initial).not.toBeNull()
  const initialFit: CameraPoseSnapshot = initial!
  // 初始 fit 距离 sanity（§9.1：16:9 下约 189.2m；不在此钉死，仅防误机位）
  expect(initialFit.distance).toBeGreaterThan(100)
  expect(initialFit.polarDeg).toBeCloseTo(45, 1)

  mkdirSync(baselineDir, { recursive: true })
  const captured: { file: string; label: string; pose: CameraPoseSnapshot }[] = []

  // 机位 1：初始全景——不做任何相机操作，等待实际渲染帧后截图
  await renderFrames(page, 3)
  const panoramaBuffer = await page.screenshot({
    path: fileURLToPath(new URL(`./baseline/${SHOTS[0].file}`, import.meta.url)),
    type: 'png',
  })
  expect(pngSize(panoramaBuffer)).toEqual({ width: 3840, height: 2160 })
  const panoramaPose = await getCameraPose(page)
  captured.push({ file: SHOTS[0].file, label: SHOTS[0].label, pose: panoramaPose! })

  // 机位 2：35m 近景（45° 俯角，方位角与初始机位一致）
  await setCameraOrbit(page, {
    target: initialFit.target,
    distance: 35,
    polarDeg: 45,
    azimuthDeg: initialFit.azimuthDeg,
  })
  await renderFrames(page, 4)
  const nearPose = await getCameraPose(page)
  expect(nearPose!.distance).toBeCloseTo(35, 1)
  expect(nearPose!.polarDeg).toBeCloseTo(45, 1)
  const nearBuffer = await page.screenshot({
    path: fileURLToPath(new URL(`./baseline/${SHOTS[1].file}`, import.meta.url)),
    type: 'png',
  })
  expect(pngSize(nearBuffer)).toEqual({ width: 3840, height: 2160 })
  captured.push({ file: SHOTS[1].file, label: SHOTS[1].label, pose: nearPose! })

  // 机位 3：polarAngle=80° 低视线（距地平线 10°；初始 fit 距离）
  await setCameraOrbit(page, {
    target: initialFit.target,
    distance: initialFit.distance,
    polarDeg: 80,
    azimuthDeg: initialFit.azimuthDeg,
  })
  await renderFrames(page, 4)
  const lowPose = await getCameraPose(page)
  expect(lowPose!.polarDeg).toBeCloseTo(80, 1)
  const lowBuffer = await page.screenshot({
    path: fileURLToPath(new URL(`./baseline/${SHOTS[2].file}`, import.meta.url)),
    type: 'png',
  })
  expect(pngSize(lowBuffer)).toEqual({ width: 3840, height: 2160 })
  captured.push({ file: SHOTS[2].file, label: SHOTS[2].label, pose: lowPose! })

  // 基线清单：环境 + WebGL renderer + 数据指纹 + 三机位实际位姿
  const manifest = {
    spec: 'SPEC §15.3 视觉基线',
    note: '产品验收人一次性确认配色、曝光、雾、阴影和建筑观感后，三张截图即回归基线',
    environment: collectAcceptanceEnvironment(browser.version()),
    webglRenderer,
    dataSha256,
    viewport: { width: 3840, height: 2160, deviceScaleFactor: 1 },
    shots: captured,
  }
  writeFileSync(
    fileURLToPath(new URL('./baseline/manifest.json', import.meta.url)),
    JSON.stringify(manifest, null, 2),
  )
  console.log('§15.3 视觉基线已写入', baselineDir, captured.map((shot) => shot.file))
})
