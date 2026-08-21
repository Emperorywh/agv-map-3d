import { describe, expect, it } from 'vitest'

import {
  computeCameraPitchRad,
  dampOpacity,
  distanceToSegment2D,
  distanceToWall,
  isCameraInsideFootprint,
  proximityOpacity,
  resolveRoofTargetVisible,
  resolveWallFadeTarget,
  shouldFadeColumns,
  updateWallOccluding,
} from './occlusion'
import type { WallFadeParams, WallFadeTarget, WallOcclusionInput } from './occlusion'
import { computeFactoryFootprint, computeWallSegments } from './shellGeometry'

/**
 * SPEC §5.5 遮挡纯函数：屋顶 footprint 交集 / 墙体双判定并集 + 滞后 / 立柱俯角 / 阻尼。
 * 夹具：footprint = [0,100]×[0,60] 外扩 8 → [-8,108]×[-8,68]，屋檐（墙高）6m；
 * 南墙段 = (-8,-8) → (108,-8)。
 */

const FOOTPRINT = computeFactoryFootprint({ minX: 0, minY: 0, maxX: 100, maxY: 60 }, 8)
const [SOUTH_WALL] = computeWallSegments(FOOTPRINT)
const WALL_HEIGHT = 6

const PARAMS: WallFadeParams = {
  proximityNearDistance: 2,
  proximityFarDistance: 6,
  minOpacity: 0.12,
  occlusionExitHeightMargin: 0.6,
  occlusionSegmentMargin: 0.5,
}

function makeInput(partial: Partial<WallOcclusionInput>): WallOcclusionInput {
  return {
    cameraMap: { x: 0, y: 0 },
    cameraHeight: 0,
    targetMap: { x: 0, y: 0 },
    targetHeight: 0,
    wallHeight: WALL_HEIGHT,
    ...partial,
  }
}

function makeTarget(): WallFadeTarget {
  return { occluding: false, targetOpacity: 1 }
}

describe('occlusion：isCameraInsideFootprint 屋顶 footprint 交集（SPEC §5.5）', () => {
  it('XZ 落外墙矩形内且高度低于屋檐 → true（二者交集）', () => {
    expect(isCameraInsideFootprint(FOOTPRINT, 50, 30, 3, WALL_HEIGHT)).toBe(true)
    expect(isCameraInsideFootprint(FOOTPRINT, 50, 30, 5.99, WALL_HEIGHT)).toBe(true)
    // 边界含边（在墙线上视为内部）
    expect(isCameraInsideFootprint(FOOTPRINT, -8, -8, 3, WALL_HEIGHT)).toBe(true)
    expect(isCameraInsideFootprint(FOOTPRINT, 108, 68, 0, WALL_HEIGHT)).toBe(true)
  })

  it('XZ 在矩形外但高度低于屋檐 → false（判定不得退化为单纯高度阈值）', () => {
    // 跟随模式在建筑外低高度环绕的典型情形：高度远低于屋檐但 XZ 在墙外
    expect(isCameraInsideFootprint(FOOTPRINT, 50, -20, 3, WALL_HEIGHT)).toBe(false)
    expect(isCameraInsideFootprint(FOOTPRINT, -9, 30, 0.5, WALL_HEIGHT)).toBe(false)
    expect(isCameraInsideFootprint(FOOTPRINT, 120, 30, 1, WALL_HEIGHT)).toBe(false)
  })

  it('XZ 在矩形内但高度不低于屋檐 → false', () => {
    expect(isCameraInsideFootprint(FOOTPRINT, 50, 30, WALL_HEIGHT, WALL_HEIGHT)).toBe(false)
    expect(isCameraInsideFootprint(FOOTPRINT, 50, 30, 60, WALL_HEIGHT)).toBe(false)
  })
})

describe('occlusion：resolveRoofTargetVisible 三态覆盖与跟随强制隐藏（SPEC §5.5）', () => {
  it('手动覆盖优先：show 恒显示、hide 恒隐藏（与模式 / footprint 无关）', () => {
    expect(resolveRoofTargetVisible('show', 'follow', false)).toBe(true)
    expect(resolveRoofTargetVisible('show', 'orbit', false)).toBe(true)
    expect(resolveRoofTargetVisible('hide', 'orbit', true)).toBe(false)
    expect(resolveRoofTargetVisible('hide', 'topdown', true)).toBe(false)
  })

  it('auto：跟随模式强制隐藏（即使相机位于 footprint 交集内）', () => {
    expect(resolveRoofTargetVisible('auto', 'follow', true)).toBe(false)
    expect(resolveRoofTargetVisible('auto', 'follow', false)).toBe(false)
  })

  it('auto：非跟随模式按 footprint 交集淡入 / 隐藏', () => {
    expect(resolveRoofTargetVisible('auto', 'orbit', true)).toBe(true)
    expect(resolveRoofTargetVisible('auto', 'orbit', false)).toBe(false)
    // 正交俯视相机高悬（交集不成立）→ 默认隐藏直接看到内部地图
    expect(resolveRoofTargetVisible('auto', 'topdown', false)).toBe(false)
  })
})

describe('occlusion：distanceToSegment2D / distanceToWall（判定①距离）', () => {
  it('点到线段最短距离：线上为 0、延长线上取端点距离、退化段取点距', () => {
    expect(distanceToSegment2D({ x: 50, y: -8 }, SOUTH_WALL)).toBe(0)
    expect(distanceToSegment2D({ x: 50, y: -11 }, SOUTH_WALL)).toBe(3)
    expect(distanceToSegment2D({ x: 120, y: -8 }, SOUTH_WALL)).toBe(12)
    expect(
      distanceToSegment2D({ x: 3, y: 4 }, { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } }),
    ).toBe(5)
  })

  it('相机到墙段为 3D 距离：平面距离与超出屋檐的竖直间隙合成', () => {
    // 低于屋檐：竖直间隙 0，距离 = 平面距离
    expect(distanceToWall({ x: 50, y: -11 }, 3, WALL_HEIGHT, SOUTH_WALL)).toBeCloseTo(3, 12)
    // 正好在墙线上方但高于屋檐：距离 = 竖直间隙（不触发贴近淡出）
    expect(distanceToWall({ x: 50, y: -8 }, 10, WALL_HEIGHT, SOUTH_WALL)).toBeCloseTo(4, 12)
    // 平面 3 + 竖直 4 → 5
    expect(distanceToWall({ x: 50, y: -11 }, 10, WALL_HEIGHT, SOUTH_WALL)).toBeCloseTo(5, 12)
  })
})

describe('occlusion：proximityOpacity 判定①距离驱动不透明度（连续无阈值抖动）', () => {
  it('≤ near 取最低不透明度，≥ far 取 1，之间 smoothstep 单调过渡', () => {
    expect(proximityOpacity(0, PARAMS)).toBe(PARAMS.minOpacity)
    expect(proximityOpacity(PARAMS.proximityNearDistance, PARAMS)).toBe(PARAMS.minOpacity)
    expect(proximityOpacity(PARAMS.proximityFarDistance, PARAMS)).toBe(1)
    expect(proximityOpacity(100, PARAMS)).toBe(1)
    // 中点 smoothstep(0.5) = 0.5 → 0.12 + 0.88×0.5 = 0.56
    expect(proximityOpacity(4, PARAMS)).toBeCloseTo(0.56, 12)
    // 单调递增
    const samples = [2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6].map((d) =>
      proximityOpacity(d, PARAMS),
    )
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThan(samples[i - 1])
    }
  })
})

describe('occlusion：updateWallOccluding 判定②视线遮挡 + 双重滞后（SPEC §5.5）', () => {
  it('建筑外低高度相机看向建筑内关注点：穿越高度低于屋檐 → 遮挡成立', () => {
    // 视线自 (50,-20) 至 (50,20)，穿越南墙 t=0.3 处高度 = 3 + 0.3×(0.5-3) = 2.25 < 6
    const input = makeInput({
      cameraMap: { x: 50, y: -20 },
      cameraHeight: 3,
      targetMap: { x: 50, y: 20 },
      targetHeight: 0.5,
    })
    expect(updateWallOccluding(false, SOUTH_WALL, input, PARAMS)).toBe(true)
  })

  it('穿越高度高于屋檐（视线越过墙顶）→ 不遮挡', () => {
    const input = makeInput({
      cameraMap: { x: 50, y: -20 },
      cameraHeight: 30,
      targetMap: { x: 50, y: 20 },
      targetHeight: 0.5,
    })
    // 穿越高度 = 30 + 0.3×(0.5-30) = 21.15 > 6
    expect(updateWallOccluding(false, SOUTH_WALL, input, PARAMS)).toBe(false)
  })

  it('视线与墙段不相交（相机与关注点同侧）→ 不遮挡', () => {
    const input = makeInput({
      cameraMap: { x: 50, y: -20 },
      cameraHeight: 3,
      targetMap: { x: 60, y: -30 },
      targetHeight: 0.5,
    })
    expect(updateWallOccluding(false, SOUTH_WALL, input, PARAMS)).toBe(false)
  })

  it('高度滞后带 [屋檐, 屋檐+margin)：带内保持上一状态，防沿屋檐摆动闪烁', () => {
    // 穿越高度 = 9×0.7 = 6.3 ∈ [6, 6.6)
    const input = makeInput({
      cameraMap: { x: 50, y: -20 },
      cameraHeight: 9,
      targetMap: { x: 50, y: 20 },
      targetHeight: 0,
    })
    expect(updateWallOccluding(false, SOUTH_WALL, input, PARAMS)).toBe(false)
    expect(updateWallOccluding(true, SOUTH_WALL, input, PARAMS)).toBe(true)
    // 高出带上界（7 ≥ 6.6）→ 已遮挡也退出
    const above = makeInput({
      cameraMap: { x: 50, y: -20 },
      cameraHeight: 10,
      targetMap: { x: 50, y: 20 },
      targetHeight: 0,
    })
    expect(updateWallOccluding(true, SOUTH_WALL, above, PARAMS)).toBe(false)
    // 低于屋檐（5.6 < 6）→ 未遮挡也进入
    const below = makeInput({
      cameraMap: { x: 50, y: -20 },
      cameraHeight: 8,
      targetMap: { x: 50, y: 20 },
      targetHeight: 0,
    })
    expect(updateWallOccluding(false, SOUTH_WALL, below, PARAMS)).toBe(true)
  })

  it('墙段外延滞后：已遮挡时穿越点略掠过墙端仍保持（防墙角两段来回切换）', () => {
    // 视线 x=108.3，南墙 x ∈ [-8,108]：严格判定 u=1.0026 不相交；外延 0.5 后 u≈0.997 相交
    const input = makeInput({
      cameraMap: { x: 108.3, y: -20 },
      cameraHeight: 3,
      targetMap: { x: 108.3, y: 20 },
      targetHeight: 0,
    })
    expect(updateWallOccluding(false, SOUTH_WALL, input, PARAMS)).toBe(false)
    expect(updateWallOccluding(true, SOUTH_WALL, input, PARAMS)).toBe(true)
  })
})

describe('occlusion：resolveWallFadeTarget 双判定并集（SPEC §5.5）', () => {
  it('仅判定②成立：远距离遮挡墙段也淡至最低不透明度', () => {
    const input = makeInput({
      cameraMap: { x: 50, y: -20 },
      cameraHeight: 3,
      targetMap: { x: 50, y: 20 },
      targetHeight: 0.5,
    })
    const result = resolveWallFadeTarget(false, SOUTH_WALL, input, PARAMS, makeTarget())
    expect(result.occluding).toBe(true)
    expect(result.targetOpacity).toBe(PARAMS.minOpacity)
  })

  it('仅判定①成立：贴近但不遮挡视线的墙段按距离驱动淡出', () => {
    // 相机 (54,-11) 距南墙 3（near~far 之间）；目标同在南侧不穿墙
    const input = makeInput({
      cameraMap: { x: 54, y: -11 },
      cameraHeight: 3,
      targetMap: { x: 56, y: -13 },
      targetHeight: 0.5,
    })
    const result = resolveWallFadeTarget(false, SOUTH_WALL, input, PARAMS, makeTarget())
    expect(result.occluding).toBe(false)
    expect(result.targetOpacity).toBeCloseTo(0.2575, 12)
    // 贴到 ≤ near：降至最低不透明度
    const close = makeInput({
      cameraMap: { x: 54, y: -9.5 },
      cameraHeight: 3,
      targetMap: { x: 56, y: -13 },
      targetHeight: 0.5,
    })
    expect(
      resolveWallFadeTarget(false, SOUTH_WALL, close, PARAMS, makeTarget()).targetOpacity,
    ).toBe(PARAMS.minOpacity)
  })

  it('两判定均不成立：完全不透明；均成立：取更透明者（minOpacity 下限）', () => {
    const clear = makeInput({
      cameraMap: { x: 50, y: -20 },
      cameraHeight: 3,
      targetMap: { x: 60, y: -25 },
      targetHeight: 0.5,
    })
    expect(
      resolveWallFadeTarget(false, SOUTH_WALL, clear, PARAMS, makeTarget()).targetOpacity,
    ).toBe(1)
    const both = makeInput({
      cameraMap: { x: 54, y: -9.5 },
      cameraHeight: 3,
      targetMap: { x: 54, y: 20 },
      targetHeight: 0.5,
    })
    const result = resolveWallFadeTarget(false, SOUTH_WALL, both, PARAMS, makeTarget())
    expect(result.occluding).toBe(true)
    expect(result.targetOpacity).toBe(PARAMS.minOpacity)
  })

  it('结果写入 out（每帧路径零分配）', () => {
    const out = makeTarget()
    const result = resolveWallFadeTarget(
      false,
      SOUTH_WALL,
      makeInput({}),
      PARAMS,
      out,
    )
    expect(result).toBe(out)
  })
})

describe('occlusion：立柱俯角 / 正交俯视淡出（SPEC §5.5）', () => {
  it('computeCameraPitchRad：高度差与水平距离的 atan2', () => {
    expect(computeCameraPitchRad(10, 10)).toBeCloseTo(Math.PI / 4, 12)
    expect(computeCameraPitchRad(0, 10)).toBe(0)
  })

  it('正交俯视（topdown）恒淡出；透视按俯角阈值（默认 60°）', () => {
    const threshold = (60 * Math.PI) / 180
    expect(shouldFadeColumns('topdown', 0, threshold)).toBe(true)
    expect(shouldFadeColumns('orbit', (61 * Math.PI) / 180, threshold)).toBe(true)
    expect(shouldFadeColumns('follow', (70 * Math.PI) / 180, threshold)).toBe(true)
    // 恰等于阈值不淡出（超过才淡出）；小俯角保持可见
    expect(shouldFadeColumns('orbit', threshold, threshold)).toBe(false)
    expect(shouldFadeColumns('orbit', (28 * Math.PI) / 180, threshold)).toBe(false)
    expect(shouldFadeColumns('follow', (59 * Math.PI) / 180, threshold)).toBe(false)
  })
})

describe('occlusion：dampOpacity 指数阻尼（帧率无关平滑过渡）', () => {
  it('按时间常数趋近目标；delta=0 不变；|差| < epsilon 吸附为目标值', () => {
    const step = dampOpacity(0, 1, 1 / 60, 0.2, 0.01)
    expect(step).toBeCloseTo(1 - Math.exp(-(1 / 60) / 0.2), 12)
    expect(dampOpacity(0.3, 1, 0, 0.2, 0.01)).toBe(0.3)
    expect(dampOpacity(0.995, 1, 1 / 60, 0.2, 0.01)).toBe(1)
    expect(dampOpacity(0.005, 0, 1 / 60, 0.2, 0.01)).toBe(0)
  })

  it('帧率无关：单步 2Δ 与两步 Δ 结果一致；有限步内吸附收敛', () => {
    const single = dampOpacity(0, 1, 2 / 60, 0.2, 0)
    const double = dampOpacity(dampOpacity(0, 1, 1 / 60, 0.2, 0), 1, 1 / 60, 0.2, 0)
    expect(single).toBeCloseTo(double, 12)
    let opacity = 0
    let steps = 0
    while (opacity !== 1 && steps < 120) {
      opacity = dampOpacity(opacity, 1, 1 / 60, 0.2, 0.01)
      steps++
    }
    expect(opacity).toBe(1)
    expect(steps).toBeLessThan(120)
  })
})
