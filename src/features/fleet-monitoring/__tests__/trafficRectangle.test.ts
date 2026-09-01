/*
 * 交通矩形规范化与哈希测试（TASK-012 / SPEC §5.3、A5）。
 *
 * 职责：锁定 §5.3 归一化全链路——8 数值裁决、去重、质心极角排序、凸性与
 *       面积校验、乱序/绕向不变性（A5）与哈希稳定性。
 */
import { describe, expect, it } from 'vitest'
import {
  MIN_TRAFFIC_AREA_M2,
  normalizeTrafficRectangle,
  trafficHasInvalidRectangle,
} from '../model/trafficRectangle'
import type { RawTrafficResources } from '../model/types'

/** 轴对齐矩形（与当前夹具同构的点序：BL, BR, TL, TR——原序自交，极角序修复） */
const AXIS_RECT = [200.28, 4.2, 202.1, 4.2, 200.28, 4.92, 202.1, 4.92]

/** 旋转矩形（Mock 生成器同构：车头左 → 车尾左 → 车尾右 → 车头右，绕向环） */
function rotatedRect(cx: number, cy: number, halfL: number, halfW: number, theta: number): number[] {
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const corner = (along: number, side: number): number[] => [
    cx + cos * halfL * along - sin * halfW * side,
    cy + sin * halfL * along + cos * halfW * side,
  ]
  return [
    ...corner(1, 1),
    ...corner(-1, 1),
    ...corner(-1, -1),
    ...corner(1, -1),
  ]
}

describe('合法矩形规范化', () => {
  it('8 数值轴对齐矩形 → 4 点凸四边形，面积与哈希存在', () => {
    const rect = normalizeTrafficRectangle(AXIS_RECT)
    expect(rect).not.toBeNull()
    expect(rect!.points).toHaveLength(4)
    expect(rect!.area).toBeCloseTo(1.82 * 0.72, 6)
    expect(rect!.hash.length).toBeGreaterThan(0)
  })

  it('原序自交的 BL,BR,TL,TR 输入被极角排序修复为无自交环（A5 关键路径）', () => {
    const rect = normalizeTrafficRectangle(AXIS_RECT)!
    // 极角升序（以质心为原点）：从 -x/-y 象限开始逆时针 —— BL, BR, TR, TL
    const [p0, p1, p2, p3] = rect.points
    expect(p0).toEqual({ x: 200.28, y: 4.2 })
    expect(p1).toEqual({ x: 202.1, y: 4.2 })
    expect(p2).toEqual({ x: 202.1, y: 4.92 })
    expect(p3).toEqual({ x: 200.28, y: 4.92 })
  })

  it('旋转矩形（Mock 绕向）规范化成功且保持凸性', () => {
    const rect = normalizeTrafficRectangle(rotatedRect(50, 80, 1.2, 0.6, Math.PI / 5))
    expect(rect).not.toBeNull()
    expect(rect!.area).toBeCloseTo(4 * 1.2 * 0.6, 6)
  })

  it('任意输入点序/绕向 → 相同规范化点序与相同哈希（哈希不变）', () => {
    const forward = normalizeTrafficRectangle(AXIS_RECT)!
    const shuffled = normalizeTrafficRectangle([
      AXIS_RECT[4], AXIS_RECT[5],
      AXIS_RECT[0], AXIS_RECT[1],
      AXIS_RECT[6], AXIS_RECT[7],
      AXIS_RECT[2], AXIS_RECT[3],
    ])!
    const reversed = normalizeTrafficRectangle([
      AXIS_RECT[6], AXIS_RECT[7],
      AXIS_RECT[4], AXIS_RECT[5],
      AXIS_RECT[2], AXIS_RECT[3],
      AXIS_RECT[0], AXIS_RECT[1],
    ])!
    expect(shuffled.points).toEqual(forward.points)
    expect(reversed.points).toEqual(forward.points)
    expect(shuffled.hash).toBe(forward.hash)
    expect(reversed.hash).toBe(forward.hash)
  })

  it('低于哈希精度的坐标抖动不改变哈希；超出精度则改变', () => {
    const base = normalizeTrafficRectangle(AXIS_RECT)!
    const jitter = normalizeTrafficRectangle(AXIS_RECT.map((v, i) => (i % 2 === 0 ? v + 1e-6 : v)))!
    expect(jitter.hash).toBe(base.hash)
    const moved = normalizeTrafficRectangle(AXIS_RECT.map((v, i) => (i % 2 === 0 ? v + 0.01 : v)))!
    expect(moved.hash).not.toBe(base.hash)
  })
})

describe('非法矩形逐项拒绝（SPEC §5.3 第 5 步）', () => {
  it('重复点：两点重合（去重后 3 点）→ null', () => {
    const dup = [0, 0, 2, 0, 0, 0, 2, 2]
    expect(normalizeTrafficRectangle(dup)).toBeNull()
  })

  it('四点全同 → null', () => {
    expect(normalizeTrafficRectangle([1, 1, 1, 1, 1, 1, 1, 1])).toBeNull()
  })

  it('凹形：一点落在其余三点构成的三角形内 → null', () => {
    // (0,0)(4,0)(2,1)(0,4)：极角序后 (2,1) 在三角形内部，形成凹环
    expect(normalizeTrafficRectangle([0, 0, 4, 0, 2, 1, 0, 4])).toBeNull()
  })

  it('零面积：四点共线 → null', () => {
    expect(normalizeTrafficRectangle([0, 0, 1, 0, 2, 0, 3, 0])).toBeNull()
  })

  it('面积低于最小阈值 → null（边界锁定）', () => {
    expect(0.05 * 0.05).toBeLessThan(MIN_TRAFFIC_AREA_M2)
    expect(normalizeTrafficRectangle([0, 0, 0.05, 0, 0.05, 0.05, 0, 0.05])).toBeNull()
  })

  it('三点共线（叉积为零，非严格凸）→ null', () => {
    // (0,0)(1,0)(2,0) 共线：极角序下相邻边叉积为 0，不满足严格凸
    expect(normalizeTrafficRectangle([0, 0, 1, 0, 2, 0, 1, 1])).toBeNull()
  })

  it('NaN / Infinity / 非数值条目 → null', () => {
    expect(normalizeTrafficRectangle([0, 0, NaN, 0, 2, 2, 0, 2])).toBeNull()
    expect(normalizeTrafficRectangle([0, 0, Infinity, 0, 2, 2, 0, 2])).toBeNull()
    expect(normalizeTrafficRectangle([0, 0, '1', 0, 2, 2, 0, 2])).toBeNull()
    expect(normalizeTrafficRectangle([0, 0, null, 0, 2, 2, 0, 2])).toBeNull()
  })

  it('形态失败：非数组、长度不为 8 → null', () => {
    expect(normalizeTrafficRectangle(null)).toBeNull()
    expect(normalizeTrafficRectangle({ x1: 0 })).toBeNull()
    expect(normalizeTrafficRectangle([0, 0, 2, 0, 2, 2, 0, 2, 5, 5])).toBeNull()
    expect(normalizeTrafficRectangle([0, 0, 2, 0, 2, 2])).toBeNull()
  })
})

describe('trafficHasInvalidRectangle（INVALID_DATA 传播依据）', () => {
  it('全部有效 → false', () => {
    const resources: RawTrafficResources = {
      lockedRectangles: [AXIS_RECT],
      applyingRectangles: [rotatedRect(0, 0, 2, 1, 0.3), AXIS_RECT],
    }
    expect(trafficHasInvalidRectangle(resources)).toBe(false)
  })

  it('任一矩形无效 → true；资源缺失（null）→ false', () => {
    const resources: RawTrafficResources = {
      lockedRectangles: [AXIS_RECT],
      applyingRectangles: [[0, 0, NaN, 0, 2, 2, 0, 2]],
    }
    expect(trafficHasInvalidRectangle(resources)).toBe(true)
    expect(trafficHasInvalidRectangle(null)).toBe(false)
  })
})
