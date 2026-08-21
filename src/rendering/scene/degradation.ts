/**
 * 性能降级策略（SPEC §9）纯函数：规模超限或实测帧率不足时按固定顺序逐级启用降级措施——
 *   1 级 = 关阴影；2 级 = 标签阈值收紧；3 级 = 隐藏普通导航点。
 *
 * - 规模触发：节点 / 有向边 / AGV 任一维度超上限 → 至少 1 级（设计上限 ~1800 / ~3000 / 100
 *   内不触发；阈值常量留余量，当前数据 1767 / 3043 / 20 实测不触发）；
 * - 帧率触发：0.5s 窗口均值（scene/FrameStats 口径）持续低于阈值 → 按序再升一级；
 *   热身窗口（shader 编译 / 分帧构建期）不参与判定，短暂抖动由持续窗口数吸收；
 * - 等级只升不降（不自动降回），避免阈值附近来回抖动导致阴影 / 标签闪烁；
 *   场景规模变化（换图）时由场景层重建控制器整体重估。
 *
 * 各等级生效阈值（FPS 阈值 / 窗口数 / 收紧后的标签阈值等）全部集中 config/constants.ts，
 * 由场景层注入；本模块为无依赖纯函数，保持可单测。
 * rendering 层可 import three 与 config，禁止 import infrastructure（SPEC §12）。
 */

// ---------------------------------------------------------------------------
// 降级等级（按序启用，SPEC §9）
// ---------------------------------------------------------------------------

/** 不降级 */
export const DEGRADE_LEVEL_NONE = 0
/** 1 级：关阴影（唯一投影光源 castShadow 关闭） */
export const DEGRADE_LEVEL_SHADOWS_OFF = 1
/** 2 级：标签阈值收紧（透视距离 / 正交视野宽度分级阈值收紧，节点与 AGV 编号标签同口径） */
export const DEGRADE_LEVEL_LABELS_TIGHTENED = 2
/** 3 级：隐藏普通导航点（node 类整类恒隐藏，不再随相机距离恢复） */
export const DEGRADE_LEVEL_NAV_NODES_HIDDEN = 3
/** 最高降级等级 */
export const DEGRADE_MAX_LEVEL = DEGRADE_LEVEL_NAV_NODES_HIDDEN

/** 各级启用措施的展示名（升级日志用；索引 = 等级 - 1，与等级常量一一对应） */
export const DEGRADE_LEVEL_MEASURE_NAMES: readonly string[] = [
  '关阴影',
  '标签阈值收紧',
  '隐藏普通导航点',
]

// ---------------------------------------------------------------------------
// 规模触发（纯函数）
// ---------------------------------------------------------------------------

/** 场景规模计数（降级判定口径：节点 / 有向边 / AGV 台数） */
export interface DegradeScaleCounts {
  nodes: number
  edges: number
  agvs: number
}

/** 规模上限（值取自 config/constants.ts，由场景层注入；均为可调常量） */
export interface DegradeScaleLimits {
  maxNodes: number
  maxEdges: number
  maxAgvs: number
}

/**
 * 规模触发的降级等级：任一维度超上限 → 1 级（关阴影），否则 0 级。
 * 更高档位不由规模直接推出，统一交给实测帧率按序升级（规模与帧率两种诱因汇入同一阶梯）。
 */
export function resolveScaleDegradeLevel(
  counts: DegradeScaleCounts,
  limits: DegradeScaleLimits,
): number {
  const exceeded =
    counts.nodes > limits.maxNodes ||
    counts.edges > limits.maxEdges ||
    counts.agvs > limits.maxAgvs
  return exceeded ? DEGRADE_LEVEL_SHADOWS_OFF : DEGRADE_LEVEL_NONE
}

// ---------------------------------------------------------------------------
// 帧率触发（按序升档状态机）
// ---------------------------------------------------------------------------

/** 帧率触发配置（值取自 config/constants.ts，由场景层注入） */
export interface FpsDegradeConfig {
  /** 窗口均值低于该值视为帧率不足 */
  fpsThreshold: number
  /** 前若干个窗口不参与判定（场景热身：shader 编译 / 分帧构建） */
  warmupWindows: number
  /** 帧率不足须持续的窗口数才升一级 */
  sustainedWindows: number
  /** 等级上限（= DEGRADE_MAX_LEVEL） */
  maxLevel: number
}

/**
 * 帧率驱动的降级状态机：喂入每个统计窗口的 FPS 均值，返回当前等级。
 * 等级只升不降；升至 maxLevel 封顶。规模基数等级经 baseLevel 传入（下限）。
 */
export interface FpsDegradeController {
  /** 当前降级等级（≥ baseLevel） */
  getLevel(): number
  /** 喂入一个窗口的 FPS 均值；不足持续 sustainedWindows 个窗口升一级，达标即清零计数 */
  pushWindowFps(fps: number): number
}

export function createFpsDegradeController(
  config: FpsDegradeConfig,
  baseLevel: number,
): FpsDegradeController {
  let level = Math.min(Math.max(baseLevel, DEGRADE_LEVEL_NONE), config.maxLevel)
  let warmupLeft = Math.max(config.warmupWindows, 0)
  let belowWindows = 0
  return {
    getLevel: () => level,
    pushWindowFps(fps: number): number {
      if (warmupLeft > 0) {
        warmupLeft -= 1
        return level
      }
      belowWindows = fps < config.fpsThreshold ? belowWindows + 1 : 0
      if (belowWindows >= config.sustainedWindows && level < config.maxLevel) {
        level += 1
        belowWindows = 0
      }
      return level
    },
  }
}
