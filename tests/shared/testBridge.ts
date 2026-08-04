/**
 * 验收测试桥协议（SPEC §10.2 / §15.2 / §15.3）。
 *
 * tests/harness 页侧实现（installTestBridge.ts）与 Playwright 规格（Node 侧）
 * 共享的窗口桥类型契约：harness 构建把桥安装到 window.__FACTORY_MAP_TEST_BRIDGE__，
 * 规格经 page.evaluate 调用。全部设施只存在于 tests/，不被 src 入口引用，
 * 不进入生产包（dist 产物无桥与 PerformanceHarness 标识）。
 */

/** 窗口桥全局键（页面侧安装，规格侧访问） */
export const TEST_BRIDGE_KEY = '__FACTORY_MAP_TEST_BRIDGE__'

/** 页面状态判别联合的 status 值（与 application/factoryMapPageState 一致的字面子集） */
export type FactoryMapPageStatus = 'idle' | 'loading' | 'preparing' | 'ready' | 'empty' | 'error'

/** 一次状态转换记录（t 为 performance.now() 毫秒） */
export interface StatusTransition {
  readonly status: FactoryMapPageStatus
  readonly t: number
}

/** renderer.info.memory 快照（§10.3 资源稳定性断言对象） */
export interface RendererMemorySnapshot {
  readonly geometries: number
  readonly textures: number
}

/** renderer.info.render 快照（上一实际渲染帧） */
export interface RenderInfoSnapshot {
  readonly frame: number
  readonly calls: number
  readonly triangles: number
}

/** 相机位姿快照（由相机与 OrbitControls target 推导） */
export interface CameraPoseSnapshot {
  readonly position: readonly [number, number, number]
  readonly target: readonly [number, number, number]
  readonly distance: number
  readonly polarDeg: number
  readonly azimuthDeg: number
  readonly aspect: number
  readonly fov: number
}

/** 轨道机位指令（§10.2/§15.3 机位驱动） */
export interface OrbitPose {
  readonly target: readonly [number, number, number]
  readonly distance: number
  readonly polarDeg: number
  readonly azimuthDeg: number
}

/** 逐帧原始样本（§10.2 报告「每项原始结果」） */
export interface FrameSample {
  /** 阶段内毫秒 */
  readonly t: number
  /** 与上一渲染帧的间隔（帧时间，毫秒） */
  readonly dtMs: number
  /** 该帧 renderer.info.render.calls（含阴影 pass） */
  readonly drawCalls: number
  readonly triangles: number
  /** 该帧文档内 .label 元素数（§10.1 CSS2D DOM 预算锚点） */
  readonly css2dLabels: number
}

/** 帧时间分布统计（nearest-rank 百分位；§10.2 不以平均 FPS 替代） */
export interface FrameTimeStats {
  readonly count: number
  readonly minMs: number
  readonly maxMs: number
  readonly meanMs: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly p99Ms: number
}

/** §10.2 驱动阶段结果（预热/全景/近景统一形状；预热不参与断言但保留原始样本） */
export interface DrivenPhaseResult {
  readonly phase: 'warmup' | 'panoramic' | 'near'
  readonly durationMs: number
  /** 相机距 target（全景=初始 fit 距离，近景=35m） */
  readonly distanceM: number
  /** 俯角 45°（§10.2 两阶段固定） */
  readonly polarDeg: number
  /** 匀速扫过的方位角幅度（°） */
  readonly azimuthSpanDeg: number
  readonly startAzimuthDeg: number
  readonly samples: readonly FrameSample[]
  readonly stats: FrameTimeStats
  readonly maxDrawCalls: number
  readonly maxCss2dLabels: number
  readonly maxCss2dContainers: number
}

/** >50ms 主线程长任务原始记录（PerformanceObserver longtask） */
export interface LongTaskSample {
  readonly startTime: number
  readonly duration: number
}

/** §10.2/§10.3 连续装卸循环原始结果 */
export interface LoadUnloadCycleReport {
  readonly cycles: number
  /** 每轮 preparing→ready 状态转换时长（Worker prepare，毫秒） */
  readonly prepareMs: readonly number[]
  /** 每轮主线程 bindFactorySceneModel 绑定时长（毫秒，绑定后立即 dispose） */
  readonly bindMs: readonly number[]
  /** 每轮 ready 态（场景挂载中）renderer.info.memory 快照 */
  readonly readyMemory: readonly RendererMemorySnapshot[]
  /** 每轮卸载完成后被卸载渲染器的 info.memory 快照（[0] 即首次卸载后基线） */
  readonly unloadedMemory: readonly RendererMemorySnapshot[]
  /** 每轮卸载完成后的 CSS2D 容器数（§10.3：必须为 0） */
  readonly css2dContainersAfterUnload: readonly number[]
}

/** §10.2 防规避证据：质量口径快照（dpr/阴影/标签上限/渲染像素） */
export interface QualityEvidence {
  readonly cssWidth: number
  readonly cssHeight: number
  readonly drawingBufferWidth: number
  readonly drawingBufferHeight: number
  readonly dpr: number
  readonly shadowMapSize: number
  readonly labelMaxCount: number
}

/** §10.2 PerformanceHarness 一次完整基准的页侧原始结果 */
export interface PerformanceBenchmarkReport {
  /** 基准启动时的初始 fit 机位（全景阶段距离/中心/起始方位角来源） */
  readonly initialFit: CameraPoseSnapshot
  readonly quality: QualityEvidence
  /** UNMASKED WebGL renderer 字符串（§1.3 验收报告字段） */
  readonly webglRenderer: string
  /** 页面实际消费的 /map.json 字节 SHA-256（§10.2 验收报告字段） */
  readonly dataSha256: string
  readonly warmup: DrivenPhaseResult
  readonly panoramic: DrivenPhaseResult
  readonly near: DrivenPhaseResult
  /** 驱动阶段窗口（预热+全景+近景，即 ready 后测试阶段）内的 longtask 原始记录 */
  readonly longTasks: readonly LongTaskSample[]
  readonly maxDrawCalls: number
  readonly maxCss2dLabels: number
  readonly maxCss2dContainers: number
}

/** 窗口桥完整 API（页侧实现见 tests/harness/installTestBridge.ts） */
export interface FactoryMapTestBridge {
  // --- 页面状态（控制器直通） ---
  getStatus(): FactoryMapPageStatus
  getStatusLog(): readonly StatusTransition[]
  clearStatusLog(): void
  /** controller.start()：新一轮加载（旧场景随 loading 卸载，§11/§10.3） */
  startLoad(): void
  waitForStatus(status: FactoryMapPageStatus, timeoutMs: number): Promise<StatusTransition>

  // --- 场景/渲染器只读快照 ---
  isSceneLive(): boolean
  /** 等待 canvas 从文档摘除且 R3F 桥清理落地（含两个 rAF 的清理沉降） */
  waitCanvasDetached(timeoutMs: number): Promise<void>
  /** 场景存活时读活跃渲染器；卸载后读最后被卸载的渲染器（info 快照仍可读） */
  getRendererMemory(): RendererMemorySnapshot | null
  getRenderInfo(): RenderInfoSnapshot | null
  getWebGLRendererString(): string | null
  getDrawingBufferSize(): { readonly width: number; readonly height: number } | null
  getCameraPose(): CameraPoseSnapshot | null

  // --- 相机驱动与帧等待 ---
  /** 设置轨道机位并 invalidate（frameloop='demand' 下触发一帧实际渲染） */
  setCameraOrbit(pose: OrbitPose): void
  /** 等待 count 个实际渲染帧后 resolve（驱动期间不得并发调用） */
  renderFrames(count: number): Promise<void>

  // --- CSS2D DOM 计数（§10.1 预算锚点） ---
  countCss2dContainers(): number
  countCss2dLabels(): number

  // --- 数据指纹 ---
  getDataSha256(): Promise<string>

  // --- §10.2/§10.3 复合流程 ---
  runLoadUnloadCycles(cycles: number): Promise<LoadUnloadCycleReport>
  /** PerformanceHarness 入口：预热 10s → 全景 30s → 近景 30s（§10.2） */
  runPerformanceBenchmark(): Promise<PerformanceBenchmarkReport>
}

declare global {
  interface Window {
    __FACTORY_MAP_TEST_BRIDGE__?: FactoryMapTestBridge
  }
}
