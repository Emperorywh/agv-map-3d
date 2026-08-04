/**
 * 有效渲染 dpr 纯函数（SPEC §6.6 dpr 行、§10.1 渲染像素硬上限、§1.4 viewport 0 维）。
 *
 *   dpr = min(devicePixelRatio, sqrt(MAX_RENDER_PIXELS / (cssWidth × cssHeight)), 2)
 *
 * MAX_RENDER_PIXELS = 8,294,400（取自 config 层 §13.3）：3840×2160 CSS 画布
 * → sqrt(8294400 / 8294400) = 1 → 有效 dpr 固定为 1；任意画布尺寸下
 * 实际渲染像素 = cssWidth × cssHeight × dpr² ≤ MAX_RENDER_PIXELS。
 *
 * 本模块为 rendering/core 纯函数：无 React/Three/DOM 依赖，window.devicePixelRatio
 * 由调用方以参数传入。
 */

import { MAX_RENDER_PIXELS } from '../../config/qualityProfile'

/** §6.6 dpr 公式的上限项 */
export const RENDER_DPR_CAP = 2

/** devicePixelRatio 非法（非有限或 ≤0）时按 100% 缩放基线处理（§1.3 部署前提） */
const DEVICE_PIXEL_RATIO_BASELINE = 1

/**
 * 计算当前 CSS 画布尺寸下的有效渲染 dpr。
 *
 * @param cssWidth 画布 CSS 宽（px）
 * @param cssHeight 画布 CSS 高（px）
 * @param devicePixelRatio 当前设备像素比（window.devicePixelRatio）
 * @returns min(devicePixelRatio, sqrt(MAX_RENDER_PIXELS/(cssW×cssH)), 2)；
 *   viewport 任一维为 0/非有限时页面暂停 setSize/render（§1.4），像素预算项
 *   不施加约束，结果退化为 min(devicePixelRatio, 2)
 */
export function resolveRenderDpr(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : DEVICE_PIXEL_RATIO_BASELINE
  const area = cssWidth * cssHeight
  const pixelBudgetTerm = Number.isFinite(area) && area > 0
    ? Math.sqrt(MAX_RENDER_PIXELS / area)
    : Infinity
  return Math.min(dpr, pixelBudgetTerm, RENDER_DPR_CAP)
}
