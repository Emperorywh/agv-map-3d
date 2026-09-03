/**
 * 质量等级策略与能力映射（SPEC §6.5、§12.2「model/qualityPolicy.ts — 等级阈
 * 值和降级能力」；TASK-014）。
 *
 * 职责：以纯函数与不依赖 React/Three 的状态机承载自动质量控制的全部策略——
 *       1. 目标帧率按车队规模确定（≤100 台 60fps，101～200+ 台 30fps）；
 *       2. 帧时间迟滞状态机：平均帧时间超过目标预算 105% 持续 3s 时每 5s 最
 *          多降低一级，低于 75% 持续 30s 时每 30s 最多恢复一级，等级钳制在
 *          [0, 4]；
 *       3. 等级 → 能力开关映射（四个降级动作严格按 SPEC 顺序叠加）与 DPR 上
 *          限计算；
 *       4. 能力映射保证任何等级都保留核心监控语义——车辆、物理路径与主状态
 *          不在任何可关能力之列。
 * 边界：本模块只做决策，不触碰渲染器、React state 或其他 Feature——采样由
 *       useAdaptiveQuality 喂入（时间戳为调用方累计的单调帧时间），能力开关
 *       由 app 组合层映射为各 Feature 的显式 props（SPEC §12.3）。测试/基准
 *       可经 autoEnabled=false 完全绕过自动降级（不在本模块内表达）。
 * 关键不变量：
 * 1. 等级语义固定：0 = 完整画质；1 = 仅保留重点标签和近景标签；2 = 阴影贴图
 *    降为 1024；3 = 关闭动态阴影；4 = DPR 上限降为 1 并停用非关键装饰动画；
 *    高级别隐含全部低级别动作；
 * 2. 迟滞两侧互斥：平均帧时间不可能同时 >105% 预算且 <75% 预算；持续计时在
 *    条件被破坏的瞬间清零重新累积，杜绝瞬时抖动触发等级变化；
 * 3. 冷却按方向独立裁决且共用同一「上次变化时刻」：降级要求距上次变化 ≥5s、
 *    恢复要求 ≥30s，与 SPEC 逐字一致；
 * 4. 采样平滑窗口（1000ms）内的平均作为「平均帧时间」；单样本钳制上限丢弃
 *    明显异常的时间跳变；超过断流间隔（页面隐藏/挂起后恢复）清空窗口与持续
 *    计时——渲染中断不跨断流累积迟滞，恢复后重新观察；
 * 5. 非有限或负数样本被整体忽略（不进窗口、不动计时器），绝不以 NaN 进入比较。
 */

/** 质量等级：0 完整画质，4 最低画质（数值越大降级越深） */
export type QualityLevel = 0 | 1 | 2 | 3 | 4

/** 等级上下界（四个降级动作 → 0～4 级） */
export const QUALITY_LEVEL_MIN = 0
export const QUALITY_LEVEL_MAX = 4

/** 车队规模目标帧率阈值：≤100 台 60fps，超过 100 台 30fps（SPEC §6.5） */
export const TARGET_FPS_VEHICLE_THRESHOLD = 100
export const TARGET_FPS_SMALL_FLEET = 60
export const TARGET_FPS_LARGE_FLEET = 30

/**
 * 按车队规模取目标帧率：非有限或非正数按小车队处理（防御性回退，60fps）；
 * 超过 200 台（运行时硬上限内）沿用 30fps，不设第三档。
 */
export function targetFpsForVehicleCount(vehicleCount: number): number {
  if (!Number.isFinite(vehicleCount) || vehicleCount <= TARGET_FPS_VEHICLE_THRESHOLD) {
    return TARGET_FPS_SMALL_FLEET
  }
  return TARGET_FPS_LARGE_FLEET
}

/** 过载降级：平均帧时间超过目标预算的 105% 持续 3s（SPEC §6.5） */
export const OVERSHOOT_RATIO = 1.05
export const OVERSHOOT_SUSTAIN_MS = 3000
/** 降级节流：每 5s 最多降低一级 */
export const DOWNGRADE_COOLDOWN_MS = 5000

/** 空裕恢复：平均帧时间低于目标预算的 75% 持续 30s（SPEC §6.5） */
export const UNDERSHOOT_RATIO = 0.75
export const UNDERSHOOT_SUSTAIN_MS = 30000
/** 恢复节流：每 30s 最多恢复一级 */
export const UPGRADE_COOLDOWN_MS = 30000

/** 平均帧时间的平滑窗口：窗口内样本的算术平均参与阈值比较 */
export const FRAME_SAMPLE_WINDOW_MS = 1000
/** 单样本上限钳制（毫秒）：容忍真实慢帧，丢弃明显异常的时间跳变 */
export const MAX_SAMPLE_MS = 1000
/**
 * 采样断流间隔：两次样本间隔超过该值视为渲染中断（页面隐藏/挂起），清空
 * 窗口与持续计时，恢复后重新观察（不跨断流累积迟滞，配合 TASK-015 语义）。
 */
export const SAMPLE_GAP_RESET_MS = 2000

/** 能力映射的基准输入（来自运行时配置 renderer.*，app 组合层注入） */
export interface QualityCapabilityBase {
  /** 基准阴影贴图分辨率（config.renderer.shadowMapSize，默认 2048） */
  readonly shadowMapSize: number
  /** 降级阴影贴图分辨率（行动 2）；默认 1024 */
  readonly degradedShadowMapSize?: number
}

/**
 * 一级能力开关集合：由 app 组合层按当前等级映射并拆给地图/车队 Feature 的
 * 显式 props（SPEC §12.3）。只读冻结对象，语义见 capabilitiesForLevel。
 */
export interface QualityCapabilities {
  /** 行动 1：仅保留重点标签和近景标签（中距离纯名称标签隐藏） */
  readonly importantLabelsOnly: boolean
  /** 行动 2：方向光阴影贴图分辨率 */
  readonly shadowMapSize: number
  /** 行动 3：动态阴影渲染开关（false 时方向光不再投射阴影） */
  readonly dynamicShadowsEnabled: boolean
  /** 行动 4：非关键装饰动画开关（充电呼吸灯等） */
  readonly decorationsEnabled: boolean
}

/**
 * 等级 → 能力开关映射：四个降级动作按 SPEC §6.5 顺序逐级叠加（高级别隐含
 * 全部低级别动作）。任何等级都不包含隐藏车辆或路径的开关——核心语义不可
 * 降级。阴影分辨率取「降级值与基准值的较小者」，基准配置本身低于 1024 时
 * 不再进一步下调。
 */
export function capabilitiesForLevel(
  level: QualityLevel,
  base: QualityCapabilityBase,
): QualityCapabilities {
  const degraded = base.degradedShadowMapSize ?? 1024
  const shadowMapSize =
    level >= 2 ? Math.min(base.shadowMapSize, degraded) : base.shadowMapSize
  return Object.freeze({
    importantLabelsOnly: level >= 1,
    shadowMapSize,
    dynamicShadowsEnabled: level < 3,
    decorationsEnabled: level < 4,
  })
}

/**
 * DPR 上限计算（行动 4 的渲染器落地值）：4 级时上限降为 min(1, maxDpr)——
 * 「上限」语义只降不抬，配置上限本身低于 1 时保持原值；实际值再与设备像素
 * 比取较小者（基准画质不放大低倍率设备）。maxDpr 非法时按 1 兜底；设备像
 * 素比非法时视为无设备约束（取配置上限）。
 */
export function effectiveDprFor(
  level: QualityLevel,
  maxDpr: number,
  devicePixelRatio: number,
): number {
  const cap = level >= QUALITY_LEVEL_MAX ? Math.min(1, maxDpr) : maxDpr
  const safeCap = Number.isFinite(cap) && cap > 0 ? cap : 1
  const device =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : safeCap
  return Math.min(safeCap, device)
}

/** 一次采样评估的输出：当前等级、是否变化、方向与诊断上下文 */
export interface QualityPolicyDecision {
  readonly level: QualityLevel
  readonly changed: boolean
  readonly direction: 'downgrade' | 'upgrade' | null
  /** 平滑窗口内的平均帧时间（毫秒）；窗口为空时为 0 */
  readonly avgFrameMs: number
  readonly targetFps: number
}

/** 迟滞状态机：由调用方（useAdaptiveQuality）逐帧喂入样本与单调时间戳 */
export interface QualityPolicy {
  /** 目标帧率当前取值（供调用方检测车队规模切换） */
  targetFps(): number
  /** 当前质量等级 */
  level(): QualityLevel
  /**
   * 喂入一帧样本：frameMs 为该帧渲染耗时（毫秒），nowMs 为调用方累计的单调
   * 帧时间（毫秒）。返回评估结果；等级变化时 changed=true。
   */
  pushSample(frameMs: number, nowMs: number): QualityPolicyDecision
  /** 目标帧率切换（车队规模跨越阈值）：重置持续计时，保留冷却与当前等级 */
  setTargetFps(fps: number): void
  /** 清空全部动态状态（窗口、持续计时、冷却）；当前等级保留 */
  reset(): void
}

export interface CreateQualityPolicyOptions {
  /** 初始目标帧率；缺省 60fps（小车队） */
  targetFps?: number
}

/** 状态机的可变内部形态（模块外不可触达） */
interface PolicyState {
  targetFpsValue: number
  budgetMs: number
  levelValue: QualityLevel
  /** 平滑窗口（平行数组：采样时刻与帧时间，按时间升序） */
  windowTimes: number[]
  windowFrames: number[]
  overloadSince: number | null
  headroomSince: number | null
  lastChangeAt: number | null
  lastSampleAt: number | null
}

/**
 * 创建迟滞质量状态机。时间语义完全由调用方决定（单调毫秒），本模块不读取
 * 任何真实时钟——真实渲染循环经 useFrame 累计帧时间喂入，测试注入合成序列，
 * 两侧共用同一确定性裁决。
 */
export function createQualityPolicy(
  options: CreateQualityPolicyOptions = {},
): QualityPolicy {
  const initialFps = options.targetFps ?? TARGET_FPS_SMALL_FLEET
  const state: PolicyState = {
    targetFpsValue: initialFps,
    budgetMs: 1000 / initialFps,
    levelValue: QUALITY_LEVEL_MIN,
    windowTimes: [],
    windowFrames: [],
    overloadSince: null,
    headroomSince: null,
    lastChangeAt: null,
    lastSampleAt: null,
  }

  const decision = (
    changed: boolean,
    direction: QualityPolicyDecision['direction'],
    avgFrameMs: number,
  ): QualityPolicyDecision => ({
    level: state.levelValue,
    changed,
    direction,
    avgFrameMs,
    targetFps: state.targetFpsValue,
  })

  /** 淘汰窗口外样本并返回窗口平均帧时间 */
  const averageOver = (nowMs: number): number => {
    const cutoff = nowMs - FRAME_SAMPLE_WINDOW_MS
    while (state.windowTimes.length > 0 && state.windowTimes[0] < cutoff) {
      state.windowTimes.shift()
      state.windowFrames.shift()
    }
    if (state.windowFrames.length === 0) {
      return 0
    }
    let sum = 0
    for (const frame of state.windowFrames) {
      sum += frame
    }
    return sum / state.windowFrames.length
  }

  const policy: QualityPolicy = {
    targetFps: () => state.targetFpsValue,
    level: () => state.levelValue,

    pushSample(frameMs, nowMs) {
      // 非有限/负样本整体忽略：不动窗口、不动计时器
      if (!Number.isFinite(frameMs) || frameMs < 0 || !Number.isFinite(nowMs)) {
        return decision(false, null, averageOver(nowMs))
      }
      // 断流恢复：清空窗口与持续计时，重新观察（冷却与等级保留）
      if (state.lastSampleAt !== null && nowMs - state.lastSampleAt > SAMPLE_GAP_RESET_MS) {
        state.windowTimes.length = 0
        state.windowFrames.length = 0
        state.overloadSince = null
        state.headroomSince = null
      }
      state.lastSampleAt = nowMs
      state.windowTimes.push(nowMs)
      state.windowFrames.push(Math.min(frameMs, MAX_SAMPLE_MS))

      const avg = averageOver(nowMs)
      const budget = state.budgetMs

      // —— 过载降级：avg > 105% 预算持续 3s，且距上次变化 ≥5s ——
      if (avg > budget * OVERSHOOT_RATIO) {
        if (state.overloadSince === null) {
          state.overloadSince = nowMs
        } else if (
          nowMs - state.overloadSince >= OVERSHOOT_SUSTAIN_MS &&
          (state.lastChangeAt === null ||
            nowMs - state.lastChangeAt >= DOWNGRADE_COOLDOWN_MS) &&
          state.levelValue < QUALITY_LEVEL_MAX
        ) {
          state.levelValue = (state.levelValue + 1) as QualityLevel
          state.lastChangeAt = nowMs
          state.overloadSince = nowMs
          return decision(true, 'downgrade', avg)
        }
      } else {
        state.overloadSince = null
      }

      // —— 空裕恢复：avg < 75% 预算持续 30s，且距上次变化 ≥30s ——
      if (avg < budget * UNDERSHOOT_RATIO) {
        if (state.headroomSince === null) {
          state.headroomSince = nowMs
        } else if (
          nowMs - state.headroomSince >= UNDERSHOOT_SUSTAIN_MS &&
          (state.lastChangeAt === null ||
            nowMs - state.lastChangeAt >= UPGRADE_COOLDOWN_MS) &&
          state.levelValue > QUALITY_LEVEL_MIN
        ) {
          state.levelValue = (state.levelValue - 1) as QualityLevel
          state.lastChangeAt = nowMs
          state.headroomSince = nowMs
          return decision(true, 'upgrade', avg)
        }
      } else {
        state.headroomSince = null
      }

      return decision(false, null, avg)
    },

    setTargetFps(fps) {
      if (!Number.isFinite(fps) || fps <= 0 || fps === state.targetFpsValue) {
        return
      }
      state.targetFpsValue = fps
      state.budgetMs = 1000 / fps
      // 预算变化使既有持续计时失效：清零重新累积（冷却与等级保留）
      state.overloadSince = null
      state.headroomSince = null
    },

    reset() {
      state.windowTimes.length = 0
      state.windowFrames.length = 0
      state.overloadSince = null
      state.headroomSince = null
      state.lastChangeAt = null
      state.lastSampleAt = null
    },
  }
  return policy
}
