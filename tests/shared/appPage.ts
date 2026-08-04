/**
 * Playwright 规格（Node 侧）访问验收测试桥的统一辅助。
 * 每个辅助经 page.evaluate 调用 window.__FACTORY_MAP_TEST_BRIDGE__（页侧桥
 * 由 tests/harness 构建安装）；桥缺失时立即失败并给出明确原因，不静默跳过。
 */

import type { Page } from '@playwright/test'

import type {
  CameraPoseSnapshot,
  FactoryMapPageStatus,
  LoadUnloadCycleReport,
  OrbitPose,
  PerformanceBenchmarkReport,
  RenderInfoSnapshot,
  RendererMemorySnapshot,
  StatusTransition,
} from './testBridge'

/** 进入 harness 页面并等待桥安装完成（不代表地图 ready） */
export async function gotoHarnessApp(page: Page, timeoutMs = 120_000): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => window.__FACTORY_MAP_TEST_BRIDGE__ !== undefined,
    undefined,
    { timeout: timeoutMs },
  )
}

export function waitForAppStatus(
  page: Page,
  status: FactoryMapPageStatus,
  timeoutMs = 120_000,
): Promise<StatusTransition> {
  const arg: [FactoryMapPageStatus, number] = [status, timeoutMs]
  return page.evaluate(([target, ms]) => {
    const bridge = window.__FACTORY_MAP_TEST_BRIDGE__
    if (bridge === undefined) throw new Error('验收测试桥未安装')
    return bridge.waitForStatus(target, ms)
  }, arg)
}

/** 等待页面进入 ready（首次加载完成、场景已挂载） */
export function waitAppReady(page: Page, timeoutMs = 120_000): Promise<StatusTransition> {
  return waitForAppStatus(page, 'ready', timeoutMs)
}

export function getAppStatus(page: Page): Promise<FactoryMapPageStatus> {
  return page.evaluate(() => {
    const bridge = window.__FACTORY_MAP_TEST_BRIDGE__
    if (bridge === undefined) throw new Error('验收测试桥未安装')
    return bridge.getStatus()
  })
}

export function startLoad(page: Page): Promise<void> {
  return page.evaluate(() => {
    const bridge = window.__FACTORY_MAP_TEST_BRIDGE__
    if (bridge === undefined) throw new Error('验收测试桥未安装')
    bridge.startLoad()
  })
}

export function isSceneLive(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const bridge = window.__FACTORY_MAP_TEST_BRIDGE__
    if (bridge === undefined) throw new Error('验收测试桥未安装')
    return bridge.isSceneLive()
  })
}

export function waitCanvasDetached(page: Page, timeoutMs = 60_000): Promise<void> {
  return page.evaluate((ms) => {
    const bridge = window.__FACTORY_MAP_TEST_BRIDGE__
    if (bridge === undefined) throw new Error('验收测试桥未安装')
    return bridge.waitCanvasDetached(ms)
  }, timeoutMs)
}

export function getRendererMemory(page: Page): Promise<RendererMemorySnapshot | null> {
  return page.evaluate(() => {
    const bridge = window.__FACTORY_MAP_TEST_BRIDGE__
    if (bridge === undefined) throw new Error('验收测试桥未安装')
    return bridge.getRendererMemory()
  })
}

export function getRenderInfo(page: Page): Promise<RenderInfoSnapshot | null> {
  return page.evaluate(() => {
    const bridge = window.__FACTORY_MAP_TEST_BRIDGE__
    if (bridge === undefined) throw new Error('验收测试桥未安装')
    return bridge.getRenderInfo()
  })
}

export function getWebGLRendererString(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const bridge = window.__FACTORY_MAP_TEST_BRIDGE__
    if (bridge === undefined) throw new Error('验收测试桥未安装')
    return bridge.getWebGLRendererString()
  })
}

export function getDrawingBufferSize(
  page: Page,
): Promise<{ readonly width: number; readonly height: number } | null> {
  return page.evaluate(() => {
    const bridge = window.__FACTORY_MAP_TEST_BRIDGE__
    if (bridge === undefined) throw new Error('验收测试桥未安装')
    return bridge.getDrawingBufferSize()
  })
}

export function getCameraPose(page: Page): Promise<CameraPoseSnapshot | null> {
  return page.evaluate(() => {
    const bridge = window.__FACTORY_MAP_TEST_BRIDGE__
    if (bridge === undefined) throw new Error('验收测试桥未安装')
    return bridge.getCameraPose()
  })
}

export function setCameraOrbit(page: Page, pose: OrbitPose): Promise<void> {
  return page.evaluate((nextPose) => {
    const bridge = window.__FACTORY_MAP_TEST_BRIDGE__
    if (bridge === undefined) throw new Error('验收测试桥未安装')
    bridge.setCameraOrbit(nextPose)
  }, pose)
}

export function renderFrames(page: Page, count: number): Promise<void> {
  return page.evaluate((frameCount) => {
    const bridge = window.__FACTORY_MAP_TEST_BRIDGE__
    if (bridge === undefined) throw new Error('验收测试桥未安装')
    return bridge.renderFrames(frameCount)
  }, count)
}

export function countCss2dContainers(page: Page): Promise<number> {
  return page.evaluate(() => {
    const bridge = window.__FACTORY_MAP_TEST_BRIDGE__
    if (bridge === undefined) throw new Error('验收测试桥未安装')
    return bridge.countCss2dContainers()
  })
}

export function countCss2dLabels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const bridge = window.__FACTORY_MAP_TEST_BRIDGE__
    if (bridge === undefined) throw new Error('验收测试桥未安装')
    return bridge.countCss2dLabels()
  })
}

export function runLoadUnloadCycles(page: Page, cycles: number): Promise<LoadUnloadCycleReport> {
  return page.evaluate((count) => {
    const bridge = window.__FACTORY_MAP_TEST_BRIDGE__
    if (bridge === undefined) throw new Error('验收测试桥未安装')
    return bridge.runLoadUnloadCycles(count)
  }, cycles)
}

/** 页面实际消费的基准 /map.json 字节 SHA-256（§10.2/§15.3 报告字段） */
export function getDataSha256(page: Page): Promise<string> {
  return page.evaluate(() => {
    const bridge = window.__FACTORY_MAP_TEST_BRIDGE__
    if (bridge === undefined) throw new Error('验收测试桥未安装')
    return bridge.getDataSha256()
  })
}

export function runPerformanceBenchmark(page: Page): Promise<PerformanceBenchmarkReport> {
  return page.evaluate(() => {
    const bridge = window.__FACTORY_MAP_TEST_BRIDGE__
    if (bridge === undefined) throw new Error('验收测试桥未安装')
    return bridge.runPerformanceBenchmark()
  })
}
