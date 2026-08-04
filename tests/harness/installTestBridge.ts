/**
 * 验收测试桥页侧实现（SPEC §10.2 / §15.2 / §15.3）。
 *
 * 由 tests/harness/main.tsx 在渲染前安装一次：把页面控制器与 R3F 内部
 * （渲染器/相机/OrbitControls/invalidate）的只读快照与驱动能力发布到
 * window.__FACTORY_MAP_TEST_BRIDGE__，Playwright 规格经 page.evaluate 调用。
 *
 * 数据通路：
 * - 控制器：HarnessPage 挂载时装配（attachTestBridgeController），状态订阅
 *   记录转换日志（preparing→ready 时差即 §10.2 Worker prepare 时长）；
 * - Three 句柄：R3FBridge（FactoryScene 的验收组合缝 children）经 useThree
 *   发布；卸载时保留最后被卸载渲染器引用——§10.3 卸载后 info.memory 仍可读；
 * - 帧驱动：R3FBridge 以 useFrame(priority=2) 在每帧 WebGL/CSS2D 渲染完成后
 *   回调 tickTestFrame——PerformanceHarness 的采样点因此晚于 renderer.info
 *   当帧结算（three 在 render 起始 autoReset），draw calls 含阴影 pass。
 *
 * 本模块只在 harness 构建中被打包（src 入口不引用 tests/），不进入生产包。
 */

import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { PerspectiveCamera, WebGLRenderer } from 'three'

import {
  LABEL_MAX_COUNT,
  SHADOW_MAP_SIZE,
  bindFactorySceneModel,
} from '../../src/features/factory-map'
import type {
  FactoryMapPageController,
  FactorySceneModel,
} from '../../src/features/factory-map'
import { runPerformanceBenchmark } from './PerformanceHarness'
import type {
  CameraPoseSnapshot,
  FactoryMapPageStatus,
  FactoryMapTestBridge,
  LoadUnloadCycleReport,
  LongTaskSample,
  OrbitPose,
  QualityEvidence,
  RenderInfoSnapshot,
  RendererMemorySnapshot,
  StatusTransition,
} from '../shared/testBridge'

// ---------------------------------------------------------------------------
// 常量与超时
// ---------------------------------------------------------------------------

/** 单轮装卸的状态/卸载等待上限（本地 6.5MB 基准地图的正常路径在秒级） */
const CYCLE_STEP_TIMEOUT_MS = 60_000
/** renderFrames 等待上限：帧循环停摆时判定失败而非悬挂 */
const RENDER_FRAMES_TIMEOUT_MS = 15_000
/** §10.1 CSS2D 标签元素类名锚点（与 Css2dLabelRendererAdapter 冻结契约一致） */
const LABEL_ELEMENT_SELECTOR = '.label'

const RAD_PER_DEG = Math.PI / 180

// ---------------------------------------------------------------------------
// 模块级持有（桥背后唯一状态；随页面生命周期，不跨文档）
// ---------------------------------------------------------------------------

interface ThreeHandles {
  readonly gl: WebGLRenderer
  readonly camera: PerspectiveCamera
  readonly controls: OrbitControls | null
  readonly invalidate: () => void
}

let controller: FactoryMapPageController | null = null
let detachControllerSubscription: (() => void) | null = null
let three: ThreeHandles | null = null
/** 最后被卸载的渲染器（§10.3 卸载后基线读取）；页面卸载前保持可读 */
let lastUnmountedGl: WebGLRenderer | null = null
const statusLog: StatusTransition[] = []
const longTasks: LongTaskSample[] = []
let frameHandler: ((now: number) => void) | null = null

// ---------------------------------------------------------------------------
// 装配入口（HarnessPage / R3FBridge 调用）
// ---------------------------------------------------------------------------

/** 装配页面控制器并订阅状态转换；返回解装函数（React effect cleanup 语义） */
export function attachTestBridgeController(next: FactoryMapPageController): () => void {
  detachControllerSubscription?.()
  controller = next
  statusLog.length = 0
  statusLog.push({ status: next.getState().status, t: performance.now() })
  detachControllerSubscription = next.subscribe((state) => {
    statusLog.push({ status: state.status, t: performance.now() })
  })
  return () => {
    detachControllerSubscription?.()
    detachControllerSubscription = null
    if (controller === next) controller = null
  }
}

/** R3FBridge 发布 Three 句柄（useThree 快照；controls 由 drei makeDefault 后填充） */
export function attachThreeHandles(handles: ThreeHandles): void {
  three = handles
}

/** R3FBridge 卸载：保留被卸载渲染器引用供 §10.3 卸载后基线读取 */
export function detachThreeHandles(gl: WebGLRenderer): void {
  if (three !== null && three.gl === gl) three = null
  lastUnmountedGl = gl
}

/** R3F 帧循环回调（useFrame priority=2，晚于 LabelLayer 的 WebGL/CSS2D 渲染） */
export function tickTestFrame(now: number): void {
  frameHandler?.(now)
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function nextAnimationFrame(): Promise<number> {
  return new Promise((resolve) => {
    requestAnimationFrame((now) => resolve(now))
  })
}

async function nextAnimationFrames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await nextAnimationFrame()
}

function requireController(): FactoryMapPageController {
  if (controller === null) throw new Error('测试桥控制器未装配（页面未完成挂载）')
  return controller
}

function requireThree(): ThreeHandles {
  if (three === null) throw new Error('三维场景未挂载（当前无 ready/empty 画面）')
  return three
}

function readStatus(): FactoryMapPageStatus {
  return requireController().getState().status
}

function readReadyModel(): FactorySceneModel {
  const state = requireController().getState()
  if (state.status !== 'ready' && state.status !== 'empty') {
    throw new Error(`当前状态 ${state.status} 不携带场景模型`)
  }
  return state.model
}

function readRendererMemory(): RendererMemorySnapshot | null {
  const renderer = three?.gl ?? lastUnmountedGl
  if (renderer === null || renderer === undefined) return null
  return {
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
  }
}

function readRenderInfo(): RenderInfoSnapshot | null {
  if (three === null) return null
  const { frame, calls, triangles } = three.gl.info.render
  return { frame, calls, triangles }
}

function readCameraPose(): CameraPoseSnapshot | null {
  if (three === null) return null
  const { camera, controls } = three
  const target: readonly [number, number, number] = controls !== null
    ? [controls.target.x, controls.target.y, controls.target.z]
    : [0, 0, 0]
  const dx = camera.position.x - target[0]
  const dy = camera.position.y - target[1]
  const dz = camera.position.z - target[2]
  const distance = Math.hypot(dx, dy, dz)
  const cosPolar = distance > 0 ? Math.min(1, Math.max(-1, dy / distance)) : 1
  return {
    position: [camera.position.x, camera.position.y, camera.position.z],
    target,
    distance,
    polarDeg: Math.acos(cosPolar) / RAD_PER_DEG,
    azimuthDeg: Math.atan2(dx, dz) / RAD_PER_DEG,
    aspect: camera.aspect,
    fov: camera.fov,
  }
}

function setCameraOrbit(pose: OrbitPose): void {
  const { camera, controls, invalidate } = requireThree()
  const polar = pose.polarDeg * RAD_PER_DEG
  const azimuth = pose.azimuthDeg * RAD_PER_DEG
  const sinPolar = Math.sin(polar)
  camera.position.set(
    pose.target[0] + pose.distance * sinPolar * Math.sin(azimuth),
    pose.target[1] + pose.distance * Math.cos(polar),
    pose.target[2] + pose.distance * sinPolar * Math.cos(azimuth),
  )
  if (controls !== null) {
    controls.target.set(pose.target[0], pose.target[1], pose.target[2])
    // update() 以当前 position−target 为零增量重投影并 lookAt(target)，
    // 与 CameraRig 的 change→夹取/位姿通知链路保持一致
    controls.update()
  } else {
    camera.lookAt(pose.target[0], pose.target[1], pose.target[2])
  }
  invalidate()
}

function countCss2dContainers(): number {
  // CSS2D 容器被追加到 canvas 的父宿主（§1.4 同一 position:relative 宿主），
  // 宿主内除 canvas 外的元素即 CSS2D 容器；场景卸载（无 canvas）时为 0
  const canvas = document.querySelector('canvas')
  const host = canvas?.parentElement
  if (canvas === null || host === null || host === undefined) return 0
  let count = 0
  for (let i = 0; i < host.children.length; i += 1) {
    if (host.children[i] !== canvas) count += 1
  }
  return count
}

function countCss2dLabels(): number {
  return document.querySelectorAll(LABEL_ELEMENT_SELECTOR).length
}

function readQualityEvidence(): QualityEvidence {
  const { gl } = requireThree()
  const canvas = gl.domElement
  const cssWidth = canvas.clientWidth
  const cssHeight = canvas.clientHeight
  return {
    cssWidth,
    cssHeight,
    drawingBufferWidth: canvas.width,
    drawingBufferHeight: canvas.height,
    dpr: cssWidth > 0 ? canvas.width / cssWidth : 0,
    shadowMapSize: SHADOW_MAP_SIZE,
    labelMaxCount: LABEL_MAX_COUNT,
  }
}

function readWebGLRendererString(): string | null {
  const canvas = document.querySelector('canvas')
  if (canvas === null) return null
  const gl = canvas.getContext('webgl2')
  if (gl === null) return null
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
  const value = debugInfo !== null
    ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER)
  return String(value)
}

async function readDataSha256(): Promise<string> {
  // §3.1/§10.2：基准数据为 /map.json（验收口径固定基准，不随 VITE_MAP_URL 变更）
  const response = await fetch('/map.json')
  if (!response.ok) throw new Error(`基准数据拉取失败：HTTP ${response.status}`)
  const buffer = await response.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function waitForStatus(status: FactoryMapPageStatus, timeoutMs: number): Promise<StatusTransition> {
  const current = requireController()
  return new Promise((resolve, reject) => {
    if (current.getState().status === status) {
      resolve({ status, t: performance.now() })
      return
    }
    const unsubscribe = current.subscribe((state) => {
      if (state.status !== status) return
      clearTimeout(timer)
      unsubscribe()
      resolve({ status: state.status, t: performance.now() })
    })
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`等待状态 ${status} 超时（${timeoutMs}ms），当前 ${current.getState().status}`))
    }, timeoutMs)
  })
}

async function waitCanvasDetached(timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    if (document.querySelector('canvas') === null && three === null) {
      // 两个 rAF 沉降：React 被动效应清理与各资源 owner 的 dispose 全部落地
      await nextAnimationFrames(2)
      return
    }
    if (performance.now() > deadline) throw new Error('等待画布卸载超时')
    await nextAnimationFrame()
  }
}

function renderFrames(count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (three === null) {
      reject(new Error('三维场景未挂载，无法等待渲染帧'))
      return
    }
    if (frameHandler !== null) {
      reject(new Error('帧驱动被占用（驱动/等待不得并发）'))
      return
    }
    let remaining = count
    const timer = setTimeout(() => {
      frameHandler = null
      reject(new Error(`等待 ${count} 个渲染帧超时（${RENDER_FRAMES_TIMEOUT_MS}ms）`))
    }, RENDER_FRAMES_TIMEOUT_MS)
    frameHandler = () => {
      remaining -= 1
      if (remaining > 0) return
      clearTimeout(timer)
      frameHandler = null
      resolve()
    }
    three.invalidate()
  })
}

function startFrameHandler(handler: (now: number) => void): void {
  if (frameHandler !== null) throw new Error('帧驱动被占用（驱动/等待不得并发）')
  frameHandler = handler
}

function stopFrameHandler(): void {
  frameHandler = null
}

// ---------------------------------------------------------------------------
// §10.2/§10.3 连续装卸循环
// ---------------------------------------------------------------------------

/**
 * 每轮：ready 态记录渲染资源快照并对本轮模型做主线程绑定计时 →
 * controller.start() 进入 loading（旧场景卸载、资源 dispose）→
 * 记录卸载后基线快照与 CSS2D 容器数 → 等待 ready 并计算 Worker prepare 时长。
 * 循环结束页面回到 ready（新一轮初始机位），供后续基准继续使用。
 */
async function runLoadUnloadCycles(cycles: number): Promise<LoadUnloadCycleReport> {
  const active = requireController()
  if (active.getState().status !== 'ready') {
    throw new Error(`装卸循环须在 ready 态启动（当前 ${active.getState().status}）`)
  }
  const prepareMs: number[] = []
  const bindMs: number[] = []
  const readyMemory: RendererMemorySnapshot[] = []
  const unloadedMemory: RendererMemorySnapshot[] = []
  const css2dContainersAfterUnload: number[] = []

  for (let i = 0; i < cycles; i += 1) {
    const memory = readRendererMemory()
    if (memory === null) throw new Error('ready 态缺少渲染器快照')
    readyMemory.push(memory)

    // §10.2 主线程 SceneModel 绑定：对本轮 ready 模型执行与生产相同的
    // 主线程 binder（逐字段再校验 + 零拷贝 BufferAttribute 绑定），随即 dispose
    const model = readReadyModel()
    const bindStart = performance.now()
    const bindResult = bindFactorySceneModel(model)
    const bindEnd = performance.now()
    if (!bindResult.ok) throw bindResult.error
    bindResult.batches.dispose()
    bindMs.push(bindEnd - bindStart)

    statusLog.length = 0
    active.start()
    await waitForStatus('loading', CYCLE_STEP_TIMEOUT_MS)
    await waitCanvasDetached(CYCLE_STEP_TIMEOUT_MS)
    const afterUnload = readRendererMemory()
    if (afterUnload === null) throw new Error('卸载后缺少渲染器快照')
    unloadedMemory.push(afterUnload)
    css2dContainersAfterUnload.push(countCss2dContainers())

    await waitForStatus('ready', CYCLE_STEP_TIMEOUT_MS)
    const preparing = statusLog.find((entry) => entry.status === 'preparing')
    const ready = statusLog.find((entry) => entry.status === 'ready')
    if (preparing === undefined || ready === undefined) {
      throw new Error('缺少 preparing/ready 状态转换记录，无法计算 Worker prepare 时长')
    }
    prepareMs.push(ready.t - preparing.t)
  }

  return { cycles, prepareMs, bindMs, readyMemory, unloadedMemory, css2dContainersAfterUnload }
}

// ---------------------------------------------------------------------------
// 安装
// ---------------------------------------------------------------------------

/** 安装窗口桥（幂等）；由 tests/harness/main.tsx 在渲染前调用一次 */
export function installTestBridge(): void {
  if (window.__FACTORY_MAP_TEST_BRIDGE__ !== undefined) return

  // §10.2 主线程长任务观察：全程记录，PerformanceHarness 启动时清空
  // （观察窗口 = 预热+全景+近景，即 ready 后测试阶段）
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      longTasks.push({ startTime: entry.startTime, duration: entry.duration })
    }
  })
  observer.observe({ type: 'longtask', buffered: false })

  const bridge: FactoryMapTestBridge = {
    getStatus: readStatus,
    getStatusLog: () => [...statusLog],
    clearStatusLog: () => {
      statusLog.length = 0
    },
    startLoad: () => requireController().start(),
    waitForStatus,
    isSceneLive: () => three !== null,
    waitCanvasDetached,
    getRendererMemory: readRendererMemory,
    getRenderInfo: readRenderInfo,
    getWebGLRendererString: readWebGLRendererString,
    getDrawingBufferSize: () => {
      if (three === null) return null
      return { width: three.gl.domElement.width, height: three.gl.domElement.height }
    },
    getCameraPose: readCameraPose,
    setCameraOrbit,
    renderFrames,
    countCss2dContainers,
    countCss2dLabels,
    getDataSha256: readDataSha256,
    runLoadUnloadCycles,
    runPerformanceBenchmark: () =>
      runPerformanceBenchmark({
        isSceneLive: () => three !== null,
        getCameraPose: readCameraPose,
        setCameraOrbit,
        getRenderInfo: readRenderInfo,
        getQualityEvidence: readQualityEvidence,
        getWebGLRendererString: readWebGLRendererString,
        getDataSha256: readDataSha256,
        countCss2dLabels,
        countCss2dContainers,
        invalidate: () => requireThree().invalidate(),
        startFrameHandler,
        stopFrameHandler,
        clearLongTasks: () => {
          longTasks.length = 0
        },
        getLongTasks: () => longTasks,
      }),
  }
  window.__FACTORY_MAP_TEST_BRIDGE__ = bridge
}
