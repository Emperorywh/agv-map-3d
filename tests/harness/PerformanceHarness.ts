/**
 * PerformanceHarness（SPEC §10.2 可重复性能基准，测试专用）。
 *
 * 连续驱动相机的三阶段流程（依赖经 PerformanceHarnessDeps 注入，页侧装配在
 * installTestBridge.ts；本模块不触碰 window/DOM 之外的应用内部）：
 *   1. 预热 10 秒——以初始 fit 距离、45° 俯角匀速绕行 180°，样本保留但不参与断言；
 *   2. 全景 30 秒——以初始 fit 距离、45° 俯角绕厂房中心匀速旋转 180°；
 *   3. 近景 30 秒——相机距 target 35m、45° 俯角匀速旋转 180°（触发标签 300 上限）。
 *
 * 驱动方式：每帧（R3F 帧循环 useFrame priority=2，即 LabelLayer WebGL/CSS2D
 * 渲染完成之后）按墙钟时间计算方位角、写入相机位姿并 invalidate——
 * frameloop='demand' 下因此逐帧产生实际渲染；帧时间为相邻渲染帧间隔，
 * 逐帧原始样本全部保留（§10.2「不以平均 FPS 替代」）。
 * 方位角跨阶段连续衔接，每阶段内部严格匀速。
 *
 * 断言阈值（p95 ≤33.3ms、p99 ≤50ms 等）不在本模块——由 Node 侧性能规格
 * （tests/perf/performance.spec.ts）对本结果执行；本模块只产出原始结果与统计。
 */

import { summarizeSamples } from '../shared/stats'
import type {
  CameraPoseSnapshot,
  DrivenPhaseResult,
  FrameSample,
  FrameTimeStats,
  LongTaskSample,
  OrbitPose,
  PerformanceBenchmarkReport,
  QualityEvidence,
  RenderInfoSnapshot,
} from '../shared/testBridge'

// ---------------------------------------------------------------------------
// §10.2 固定基准参数（SPEC 钉死值，唯一定义于此）
// ---------------------------------------------------------------------------

/** 预热时长（毫秒） */
export const WARMUP_DURATION_MS = 10_000
/** 全景/近景阶段时长（毫秒） */
export const PHASE_DURATION_MS = 30_000
/** 每阶段匀速扫过的方位角幅度（°） */
export const PHASE_AZIMUTH_SPAN_DEG = 180
/** 两阶段固定俯角（°，自 +Y 轴计的轨道极角 = 90° − 俯角仰角；45° 俯角即极角 45°） */
export const PHASE_POLAR_DEG = 45
/** 近景阶段相机距 target（m） */
export const NEAR_DISTANCE_M = 35
/** 阶段看门狗余量：帧循环停摆时判定失败而非悬挂 */
const PHASE_WATCHDOG_SLACK_MS = 60_000

/** 页侧原语注入（installTestBridge 装配；全部只读快照 + 相机驱动 + 帧句柄） */
export interface PerformanceHarnessDeps {
  readonly isSceneLive: () => boolean
  readonly getCameraPose: () => CameraPoseSnapshot | null
  readonly setCameraOrbit: (pose: OrbitPose) => void
  readonly getRenderInfo: () => RenderInfoSnapshot | null
  readonly getQualityEvidence: () => QualityEvidence
  readonly getWebGLRendererString: () => string | null
  readonly getDataSha256: () => Promise<string>
  readonly countCss2dLabels: () => number
  readonly countCss2dContainers: () => number
  readonly invalidate: () => void
  /** 注册逐帧句柄（同时只允许一个驱动；R3F 帧循环在每帧渲染后回调） */
  readonly startFrameHandler: (handler: (now: number) => void) => void
  readonly stopFrameHandler: () => void
  readonly clearLongTasks: () => void
  readonly getLongTasks: () => readonly LongTaskSample[]
}

interface DrivePhaseOptions {
  readonly phase: DrivenPhaseResult['phase']
  readonly durationMs: number
  readonly distanceM: number
  readonly startAzimuthDeg: number
  readonly origin: CameraPoseSnapshot
}

function toFrameTimeStats(samples: readonly FrameSample[]): FrameTimeStats {
  const stats = summarizeSamples(samples.map((sample) => sample.dtMs))
  return {
    count: stats.count,
    minMs: stats.min,
    maxMs: stats.max,
    meanMs: stats.mean,
    p50Ms: stats.p50,
    p95Ms: stats.p95,
    p99Ms: stats.p99,
  }
}

/**
 * 单阶段驱动：startAzimuthDeg → +180° 匀速（墙钟插值），每帧采样
 * 帧时间/draw calls/三角形数/CSS2D 标签数与容器数。
 */
function drivePhase(deps: PerformanceHarnessDeps, options: DrivePhaseOptions): Promise<DrivenPhaseResult> {
  const { phase, durationMs, distanceM, startAzimuthDeg, origin } = options
  return new Promise((resolve, reject) => {
    const samples: FrameSample[] = []
    let maxDrawCalls = 0
    let maxCss2dLabels = 0
    let maxCss2dContainers = 0
    const t0 = performance.now()
    let lastFrameAt = t0
    let settled = false

    const watchdog = setTimeout(() => {
      if (settled) return
      settled = true
      deps.stopFrameHandler()
      reject(new Error(`§10.2 ${phase} 阶段帧循环停摆（${durationMs}ms 内未走完），基准中止`))
    }, durationMs + PHASE_WATCHDOG_SLACK_MS)

    deps.startFrameHandler((now) => {
      if (settled) return
      try {
        const t = now - t0
        const progress = Math.min(t / durationMs, 1)
        deps.setCameraOrbit({
          target: origin.target,
          distance: distanceM,
          polarDeg: PHASE_POLAR_DEG,
          azimuthDeg: startAzimuthDeg + PHASE_AZIMUTH_SPAN_DEG * progress,
        })
        // 本回调运行于 WebGL/CSS2D 渲染之后（useFrame priority=2）：
        // renderer.info 为刚完成帧的计数（three 在 render 起始处 autoReset）
        const info = deps.getRenderInfo()
        const css2dLabels = deps.countCss2dLabels()
        const css2dContainers = deps.countCss2dContainers()
        samples.push({
          t,
          dtMs: now - lastFrameAt,
          drawCalls: info?.calls ?? 0,
          triangles: info?.triangles ?? 0,
          css2dLabels,
        })
        lastFrameAt = now
        if (info !== null && info.calls > maxDrawCalls) maxDrawCalls = info.calls
        if (css2dLabels > maxCss2dLabels) maxCss2dLabels = css2dLabels
        if (css2dContainers > maxCss2dContainers) maxCss2dContainers = css2dContainers

        if (t >= durationMs) {
          settled = true
          clearTimeout(watchdog)
          deps.stopFrameHandler()
          resolve({
            phase,
            durationMs: now - t0,
            distanceM,
            polarDeg: PHASE_POLAR_DEG,
            azimuthSpanDeg: PHASE_AZIMUTH_SPAN_DEG,
            startAzimuthDeg,
            samples,
            stats: toFrameTimeStats(samples),
            maxDrawCalls,
            maxCss2dLabels,
            maxCss2dContainers,
          })
        }
      } catch (cause) {
        settled = true
        clearTimeout(watchdog)
        deps.stopFrameHandler()
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
    // demand 模式下踢出第一帧，之后每帧句柄内 setCameraOrbit 继续 invalidate
    deps.invalidate()
  })
}

/**
 * §10.2 基准主流程。前置条件：页面 ready、场景挂载、机位为初始 fit
 * （由调用方保证——性能规格在装卸循环完成后、未做任何交互时启动）。
 * longtask 观察窗口自本入口开启（清空此前记录），覆盖预热+全景+近景
 * 全程，即「ready 后测试阶段」。
 */
export async function runPerformanceBenchmark(
  deps: PerformanceHarnessDeps,
): Promise<PerformanceBenchmarkReport> {
  if (!deps.isSceneLive()) throw new Error('PerformanceHarness 须在 ready 场景挂载后启动')
  const initialFit = deps.getCameraPose()
  if (initialFit === null) throw new Error('无法读取初始 fit 机位')

  const quality = deps.getQualityEvidence()
  const webglRenderer = deps.getWebGLRendererString() ?? '不可用（无 WebGL2 上下文）'
  const dataSha256 = await deps.getDataSha256()

  deps.clearLongTasks()
  const warmup = await drivePhase(deps, {
    phase: 'warmup',
    durationMs: WARMUP_DURATION_MS,
    distanceM: initialFit.distance,
    startAzimuthDeg: initialFit.azimuthDeg,
    origin: initialFit,
  })
  const panoramic = await drivePhase(deps, {
    phase: 'panoramic',
    durationMs: PHASE_DURATION_MS,
    distanceM: initialFit.distance,
    startAzimuthDeg: initialFit.azimuthDeg + PHASE_AZIMUTH_SPAN_DEG,
    origin: initialFit,
  })
  const near = await drivePhase(deps, {
    phase: 'near',
    durationMs: PHASE_DURATION_MS,
    distanceM: NEAR_DISTANCE_M,
    startAzimuthDeg: initialFit.azimuthDeg + 2 * PHASE_AZIMUTH_SPAN_DEG,
    origin: initialFit,
  })

  return {
    initialFit,
    quality,
    webglRenderer,
    dataSha256,
    warmup,
    panoramic,
    near,
    longTasks: [...deps.getLongTasks()],
    maxDrawCalls: Math.max(warmup.maxDrawCalls, panoramic.maxDrawCalls, near.maxDrawCalls),
    maxCss2dLabels: Math.max(warmup.maxCss2dLabels, panoramic.maxCss2dLabels, near.maxCss2dLabels),
    maxCss2dContainers: Math.max(
      warmup.maxCss2dContainers,
      panoramic.maxCss2dContainers,
      near.maxCss2dContainers,
    ),
  }
}
