import { describe, expect, it } from 'vitest'

import { headingToWorldYaw, mapToWorld, worldToMap } from './coordinates'
import type { Calibration, MapPoint } from './types'

const identity: Calibration = { scale: 1, rotationRad: 0, offsetX: 0, offsetY: 0 }

/** 带旋转 / 缩放 / 偏移的完整校准，验证通用变换式（SPEC §4.3） */
const full: Calibration = { scale: 1.7, rotationRad: 0.3, offsetX: -12.5, offsetY: 40.25 }

describe('coordinates：地图 → 世界变换（SPEC §4.3）', () => {
  it('恒等校准下 y → -z 翻转，世界 y 恒为 0', () => {
    expect(mapToWorld({ x: 3, y: 4 }, identity)).toEqual({ x: 3, y: 0, z: -4 })
    expect(mapToWorld({ x: -1.5, y: -2 }, identity)).toEqual({ x: -1.5, y: 0, z: 2 })
  })

  it('校准平移：offset 使包围盒中心落在世界原点', () => {
    const cal: Calibration = { scale: 1, rotationRad: 0, offsetX: -81.82, offsetY: 12.54 }
    // 包围盒中心 (−81.82, 12.54) → 世界原点
    expect(mapToWorld({ x: -81.82, y: 12.54 }, cal)).toEqual({ x: 0, y: 0, z: -0 })
  })

  it('通用式：wx = s·(x·cosθ − y·sinθ) − ox，wz = −[s·(x·sinθ + y·cosθ) − oy]', () => {
    const p = { x: 8, y: 3 }
    const theta = 0.3
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    const w = mapToWorld(p, full)
    expect(w.x).toBeCloseTo(1.7 * (8 * cos - 3 * sin) - -12.5, 12)
    expect(w.z).toBeCloseTo(-(1.7 * (8 * sin + 3 * cos) - 40.25), 12)
    expect(w.y).toBe(0)
  })

  it('旋转 θ=π/2 时退化为 (−s·y − ox, 0, −(s·x − oy))', () => {
    const cal: Calibration = { scale: 2, rotationRad: Math.PI / 2, offsetX: 1, offsetY: 2 }
    const w = mapToWorld({ x: 4, y: 5 }, cal)
    expect(w.x).toBeCloseTo(-2 * 5 - 1, 12)
    expect(w.z).toBeCloseTo(-(2 * 4 - 2), 12)
  })
})

describe('coordinates：往返转换一致性', () => {
  const points: MapPoint[] = [
    { x: 0, y: 0 },
    { x: -165.74, y: -25.12 },
    { x: 2.1, y: 50.2 },
    { x: 123.456, y: -789.012 },
  ]

  for (const [label, cal] of [
    ['恒等校准', identity],
    ['完整校准（缩放 + 旋转 + 平移）', full],
  ] as const) {
    it(`${label}：worldToMap(mapToWorld(p)) ≈ p`, () => {
      for (const p of points) {
        const roundTrip = worldToMap(mapToWorld(p, cal), cal)
        expect(roundTrip.x).toBeCloseTo(p.x, 10)
        expect(roundTrip.y).toBeCloseTo(p.y, 10)
      }
    })
  }
})

describe('coordinates：headingToWorldYaw（SPEC §4.3 / §5.4，资产 +Z 正面）', () => {
  it('α=0（地图 +x）→ yaw=π/2（世界 +x 方向）', () => {
    // three 中 rotation.y=β 时 +Z 前向为 (sinβ, 0, cosβ)
    const yaw = headingToWorldYaw(0, identity)
    expect(Math.sin(yaw)).toBeCloseTo(1, 12)
    expect(Math.cos(yaw)).toBeCloseTo(0, 12)
  })

  it('朝向向量经 y → -z 翻转后与 rotation.y 前向一致', () => {
    for (const alpha of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7, -2.3]) {
      const yaw = headingToWorldYaw(alpha, identity)
      // 地图朝向 (cosα, sinα) → 世界 (cosα, 0, −sinα)
      expect(Math.sin(yaw)).toBeCloseTo(Math.cos(alpha), 12)
      expect(Math.cos(yaw)).toBeCloseTo(-Math.sin(alpha), 12)
    }
  })

  it('校准旋转角叠加到 yaw', () => {
    expect(headingToWorldYaw(0.2, full)).toBeCloseTo(0.2 + 0.3 + Math.PI / 2, 12)
  })
})
