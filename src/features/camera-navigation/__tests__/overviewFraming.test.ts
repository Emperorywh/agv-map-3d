/*
 * 俯瞰取景数学测试（TASK-013 / SPEC §5.5；P0-1 四角投影包络）。
 *
 * 职责：锁定自动取景纯函数的关键几何不变量——45° 俯视角、四角投影包络距离
 *       （距离 = 最紧角点需求 × 10% 余量）、高度约束方向与占比、最小/最大
 *       距离规则与远平面覆盖；并验证 bounds/aspect 变化产生新机位、退化小
 *       地图不违反距离限制。
 * 边界：纯函数测试，不涉及 React/Three 场景。
 */
import { describe, expect, it } from 'vitest'
import {
  CAMERA_MIN_DISTANCE_M,
  computeOverviewPose,
} from '../model/overviewFraming'
import type { SceneBounds } from '@/features/map-visualization'

function boundsOf(
  width: number,
  depth: number,
): SceneBounds {
  return {
    minWorldX: 0,
    maxWorldX: width,
    minWorldZ: 0,
    maxWorldZ: depth,
    centerWorldX: width / 2,
    centerWorldZ: depth / 2,
    diagonal: Math.hypot(width, depth),
  }
}

/** 独立复算「角点恰好进入视锥」的距离需求（与实现同构，锁定回归） */
function maxCornerNeed(
  bounds: SceneBounds,
  fovDeg: number,
  aspect: number,
): number {
  const tanV = Math.tan((fovDeg / 2) * (Math.PI / 180))
  const tanH = tanV * aspect
  let maxNeed = 0
  for (const [cx, cz] of [
    [bounds.minWorldX, bounds.minWorldZ],
    [bounds.maxWorldX, bounds.minWorldZ],
    [bounds.minWorldX, bounds.maxWorldZ],
    [bounds.maxWorldX, bounds.maxWorldZ],
  ] as const) {
    const rx = cx - bounds.centerWorldX
    const rz = cz - bounds.centerWorldZ
    const camX = -Math.SQRT1_2 * rx + Math.SQRT1_2 * rz
    const camY = -0.5 * rx - 0.5 * rz
    const depth = 0.5 * rx + 0.5 * rz
    maxNeed = Math.max(maxNeed, Math.abs(camX) / tanH + depth, Math.abs(camY) / tanV + depth)
  }
  return maxNeed
}

describe('computeOverviewPose 取景数学', () => {
  it('45° 俯视角：位置高度等于水平距离，注视点为包围盒中心', () => {
    const bounds = boundsOf(100, 50)
    const pose = computeOverviewPose(bounds, 60, 16 / 9)
    const dx = pose.position.x - pose.target.x
    const dz = pose.position.z - pose.target.z
    const horizontal = Math.hypot(dx, dz)
    expect(pose.position.y).toBeCloseTo(horizontal, 6)
    expect(Math.atan2(pose.position.y, horizontal)).toBeCloseTo(Math.PI / 4, 6)
    expect(pose.target.x).toBe(bounds.centerWorldX)
    expect(pose.target.z).toBe(bounds.centerWorldZ)
  })

  it('四角投影包络：距离 = 最紧角点需求 × 1.1 余量，且钳制进 [min, max]', () => {
    const bounds = boundsOf(239, 126)
    const pose = computeOverviewPose(bounds, 25, 16 / 9)
    const distance = Math.hypot(
      pose.position.x - pose.target.x,
      pose.position.y,
      pose.position.z - pose.target.z,
    )
    expect(distance).toBeCloseTo(maxCornerNeed(bounds, 25, 16 / 9) * 1.1, 6)
    expect(distance).toBeGreaterThanOrEqual(CAMERA_MIN_DISTANCE_M)
    expect(distance).toBeLessThanOrEqual(pose.maxDistance)
  })

  it('16:9 宽地图下高度是约束方向：角点竖向视占比 ≈ 1/1.1（≥90% 占比）', () => {
    const bounds = boundsOf(239, 126)
    const fov = 25
    const pose = computeOverviewPose(bounds, fov, 16 / 9)
    const distance = Math.hypot(
      pose.position.x - pose.target.x,
      pose.position.y,
      pose.position.z - pose.target.z,
    )
    const tanV = Math.tan((fov / 2) * (Math.PI / 180))
    let maxYFraction = 0
    let maxXFraction = 0
    for (const [cx, cz] of [
      [bounds.minWorldX, bounds.minWorldZ],
      [bounds.maxWorldX, bounds.minWorldZ],
      [bounds.minWorldX, bounds.maxWorldZ],
      [bounds.maxWorldX, bounds.maxWorldZ],
    ] as const) {
      const rx = cx - bounds.centerWorldX
      const rz = cz - bounds.centerWorldZ
      const depth = distance - (0.5 * rx + 0.5 * rz)
      maxYFraction = Math.max(maxYFraction, Math.abs(-0.5 * rx - 0.5 * rz) / (tanV * depth))
      maxXFraction = Math.max(maxXFraction, Math.abs(-Math.SQRT1_2 * rx + Math.SQRT1_2 * rz) / (tanV * (16 / 9) * depth))
    }
    expect(maxYFraction).toBeGreaterThan(0.85)
    expect(maxYFraction).toBeLessThanOrEqual(1 / 1.1 + 1e-6)
    // 宽度方向不受约束（投影足迹长宽比 < 视口比例），占用更松
    expect(maxXFraction).toBeLessThan(maxYFraction)
  })

  it('包围球式浪费已消除：同图同 fov 下距离显著小于包围球包络', () => {
    const bounds = boundsOf(239, 126)
    const pose = computeOverviewPose(bounds, 25, 16 / 9)
    const distance = Math.hypot(
      pose.position.x - pose.target.x,
      pose.position.y,
      pose.position.z - pose.target.z,
    )
    const sphereFit = (bounds.diagonal / 2) / Math.tan((25 / 2) * (Math.PI / 180)) * 1.1
    expect(distance).toBeLessThan(sphereFit * 0.9)
  })

  it('纵横比收窄（竖屏）需要更远的包络距离', () => {
    const bounds = boundsOf(239, 126)
    const landscape = computeOverviewPose(bounds, 25, 16 / 9)
    const portrait = computeOverviewPose(bounds, 25, 9 / 16)
    const distanceOf = (pose: typeof landscape): number =>
      Math.hypot(
        pose.position.x - pose.target.x,
        pose.position.y,
        pose.position.z - pose.target.z,
      )
    expect(distanceOf(portrait)).toBeGreaterThan(distanceOf(landscape))
  })

  it('最大距离 = 对角线 3 倍，远平面覆盖最大距离（SPEC §5.5）', () => {
    const bounds = boundsOf(100, 50)
    const pose = computeOverviewPose(bounds, 60, 16 / 9)
    expect(pose.maxDistance).toBeCloseTo(bounds.diagonal * 3, 6)
    expect(pose.minDistance).toBe(CAMERA_MIN_DISTANCE_M)
    expect(pose.far).toBeGreaterThan(pose.maxDistance)
    expect(pose.near).toBeGreaterThan(0)
  })

  it('bounds 变化产生新机位：中心与距离随之更新（地图替换场景）', () => {
    const before = computeOverviewPose(boundsOf(100, 50), 60, 16 / 9)
    const after = computeOverviewPose(boundsOf(200, 200), 60, 16 / 9)
    expect(after.target.x).not.toBeCloseTo(before.target.x)
    expect(after.maxDistance).toBeGreaterThan(before.maxDistance)
  })

  it('退化小地图：min < max 成立，机位距离不低于最小距离', () => {
    const pose = computeOverviewPose(boundsOf(0.5, 0.5), 60, 16 / 9)
    expect(pose.minDistance).toBeLessThan(pose.maxDistance)
    const distance = Math.hypot(
      pose.position.x - pose.target.x,
      pose.position.y,
      pose.position.z - pose.target.z,
    )
    expect(distance).toBeGreaterThanOrEqual(CAMERA_MIN_DISTANCE_M)
  })

  it('对角线非有限/为零时按 1m 退化，不产生非有限机位', () => {
    const pose = computeOverviewPose(
      { ...boundsOf(10, 10), diagonal: 0 },
      60,
      16 / 9,
    )
    expect(Number.isFinite(pose.position.x)).toBe(true)
    expect(Number.isFinite(pose.position.y)).toBe(true)
    expect(Number.isFinite(pose.position.z)).toBe(true)
    expect(Number.isFinite(pose.maxDistance)).toBe(true)
  })
})
