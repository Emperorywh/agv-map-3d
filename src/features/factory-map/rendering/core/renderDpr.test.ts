/**
 * resolveRenderDpr 单元测试（SPEC §6.6 dpr 行、§10.1 渲染像素硬上限、§1.4）。
 *
 * 锚点：3840×2160 CSS 画布（§1.3 展厅部署）→ 有效 dpr=1，实际渲染像素
 * = 8,294,400 = MAX_RENDER_PIXELS（≤ 硬上限）；任意尺寸下
 * cssW × cssH × dpr² ≤ MAX_RENDER_PIXELS。
 */

import { describe, expect, it } from 'vitest'

import { MAX_RENDER_PIXELS } from '../../config/qualityProfile'
import { RENDER_DPR_CAP, resolveRenderDpr } from './renderDpr'

describe('resolveRenderDpr（SPEC §6.6 dpr 公式）', () => {
  it('3840×2160 CSS 画布有效 dpr 固定为 1（devicePixelRatio=1 与 =2 均为 1）', () => {
    expect(resolveRenderDpr(3840, 2160, 1)).toBe(1)
    expect(resolveRenderDpr(3840, 2160, 2)).toBe(1)
    // 有效 dpr=1 → 实际渲染像素 = CSS 像素，恰好等于硬上限（≤ 8294400）
    expect(3840 * 2160 * 1 * 1).toBe(MAX_RENDER_PIXELS)
    expect(3840 * 2160 * 1 * 1).toBeLessThanOrEqual(MAX_RENDER_PIXELS)
  })

  it('1920×1080 + dpr 2：预算项 sqrt(4)=2 不约束，cap 2 生效；渲染像素等于上限', () => {
    const dpr = resolveRenderDpr(1920, 1080, 2)
    expect(dpr).toBe(2)
    expect(1920 * 1080 * dpr * dpr).toBe(MAX_RENDER_PIXELS)
  })

  it('小画布 + dpr 3：cap 2 生效', () => {
    expect(resolveRenderDpr(800, 600, 3)).toBe(RENDER_DPR_CAP)
  })

  it('中间档：devicePixelRatio 低于预算项时取 devicePixelRatio', () => {
    // sqrt(8294400 / 921600) = 3 → min(1.5, 3, 2) = 1.5
    expect(resolveRenderDpr(1280, 720, 1.5)).toBe(1.5)
  })

  it('预算项严格小于 devicePixelRatio 时按预算项收敛（非整数 dpr）', () => {
    // sqrt(8294400 / (3000×2000)) = sqrt(1.3824) ≈ 1.1758
    const dpr = resolveRenderDpr(3000, 2000, 2)
    expect(dpr).toBeCloseTo(Math.sqrt(MAX_RENDER_PIXELS / (3000 * 2000)), 10)
    expect(3000 * 2000 * dpr * dpr).toBeLessThanOrEqual(MAX_RENDER_PIXELS + 1e-6)
  })

  it('viewport 任一维为 0：像素预算不约束（§1.4 暂停 setSize/render），退化为 min(dpr, 2)', () => {
    expect(resolveRenderDpr(0, 2160, 2)).toBe(2)
    expect(resolveRenderDpr(3840, 0, 1)).toBe(1)
    expect(resolveRenderDpr(0, 0, 3)).toBe(2)
  })

  it('非有限/负尺寸：像素预算不约束', () => {
    expect(resolveRenderDpr(Number.NaN, 2160, 2)).toBe(2)
    expect(resolveRenderDpr(3840, Number.POSITIVE_INFINITY, 1.5)).toBe(1.5)
    expect(resolveRenderDpr(-100, 2160, 3)).toBe(2)
  })

  it('非法 devicePixelRatio 按 100% 缩放基线处理（§1.3）', () => {
    expect(resolveRenderDpr(3840, 2160, 0)).toBe(1)
    expect(resolveRenderDpr(3840, 2160, Number.NaN)).toBe(1)
    expect(resolveRenderDpr(3840, 2160, -2)).toBe(1)
    // 非法 dpr → 基线 1；预算项更小时仍按预算收敛（4000×3000 → sqrt(0.6912) < 1）
    expect(resolveRenderDpr(4000, 3000, Number.POSITIVE_INFINITY)).toBeCloseTo(
      Math.sqrt(MAX_RENDER_PIXELS / (4000 * 3000)),
      10,
    )
  })

  it('不变量：常见尺寸组合下实际渲染像素 ≤ MAX_RENDER_PIXELS', () => {
    const cases: ReadonlyArray<readonly [number, number, number]> = [
      [3840, 2160, 1],
      [3840, 2160, 2],
      [2560, 1440, 2],
      [1920, 1080, 2],
      [1280, 720, 1.5],
      [800, 600, 3],
      [4000, 3000, 1.25],
    ]
    for (const [w, h, devicePixelRatio] of cases) {
      const dpr = resolveRenderDpr(w, h, devicePixelRatio)
      expect(w * h * dpr * dpr, `${w}×${h}@${devicePixelRatio}`).toBeLessThanOrEqual(
        MAX_RENDER_PIXELS + 1e-6,
      )
      expect(dpr).toBeLessThanOrEqual(RENDER_DPR_CAP)
    }
  })
})
