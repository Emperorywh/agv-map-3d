/*
 * 俯瞰取景数学测试（TASK-013 / SPEC §5.5）。
 *
 * 职责：锁定自动取景纯函数的关键几何不变量——45° 俯视角、包围盒包络距离、
 *       最小/最大距离规则与远平面覆盖；并验证 bounds 变化产生新机位、退化
 *       小地图不违反距离限制。
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

describe('computeOverviewPose 取景数学', () => {
  it('45° 俯视角：位置高度等于水平距离，注视点为包围盒中心', () => {
    const bounds = boundsOf(100, 50)
    const pose = computeOverviewPose(bounds, 60)
    const dx = pose.position.x - pose.target.x
    const dz = pose.position.z - pose.target.z
    const horizontal = Math.hypot(dx, dz)
    expect(pose.position.y).toBeCloseTo(horizontal, 6)
    expect(Math.atan2(pose.position.y, horizontal)).toBeCloseTo(Math.PI / 4, 6)
    expect(pose.target.x).toBe(bounds.centerWorldX)
    expect(pose.target.z).toBe(bounds.centerWorldZ)
  })

  it('包络距离覆盖包围球且处于 [min, max] 区间内', () => {
    const bounds = boundsOf(100, 50)
    const pose = computeOverviewPose(bounds, 60)
    const distance = Math.hypot(
      pose.position.x - pose.target.x,
      pose.position.y,
      pose.position.z - pose.target.z,
    )
    const halfFovRad = (60 / 2) * (Math.PI / 180)
    const fitDistance = (bounds.diagonal / 2) / Math.tan(halfFovRad)
    expect(distance).toBeGreaterThanOrEqual(fitDistance)
    expect(distance).toBeGreaterThanOrEqual(CAMERA_MIN_DISTANCE_M)
    expect(distance).toBeLessThanOrEqual(pose.maxDistance)
  })

  it('最大距离 = 对角线 3 倍，远平面覆盖最大距离（SPEC §5.5）', () => {
    const bounds = boundsOf(100, 50)
    const pose = computeOverviewPose(bounds, 60)
    expect(pose.maxDistance).toBeCloseTo(bounds.diagonal * 3, 6)
    expect(pose.minDistance).toBe(CAMERA_MIN_DISTANCE_M)
    expect(pose.far).toBeGreaterThan(pose.maxDistance)
    expect(pose.near).toBeGreaterThan(0)
  })

  it('bounds 变化产生新机位：中心与距离随之更新（地图替换场景）', () => {
    const before = computeOverviewPose(boundsOf(100, 50), 60)
    const after = computeOverviewPose(boundsOf(200, 200), 60)
    expect(after.target.x).not.toBeCloseTo(before.target.x)
    expect(after.maxDistance).toBeGreaterThan(before.maxDistance)
  })

  it('退化小地图：min < max 成立，机位距离不低于最小距离', () => {
    const pose = computeOverviewPose(boundsOf(0.5, 0.5), 60)
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
    )
    expect(Number.isFinite(pose.position.x)).toBe(true)
    expect(Number.isFinite(pose.position.y)).toBe(true)
    expect(Number.isFinite(pose.position.z)).toBe(true)
    expect(Number.isFinite(pose.maxDistance)).toBe(true)
  })
})
