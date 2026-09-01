/*
 * 统一坐标变换测试（与实现共置）。
 *
 * 职责：锁定 shared/spatial 的数学合同：仿射固定顺序、方向角合成、非法
 *       参数拒绝、平面→世界映射公式与 rotation.y 符号约定。
 * 关键不变量（SPEC §2.5）：
 * 1. 仿射顺序固定为「镜像 Y → 旋转 → 缩放 → 平移」；
 * 2. worldX = 平面x − originX、worldZ = 平面y − originY（世界 y 恒 0）；
 * 3. rotation.y = −(仿射后的平面方向角)；镜像先翻转方向角再加旋转。
 */
import { describe, expect, it } from 'vitest'
import {
  createPlaneTransform,
  createWorldTransform,
  IDENTITY_AFFINE,
} from '@/shared/spatial'

describe('createPlaneTransform', () => {
  it('scale 非正或非有限、rotation/平移非有限时构造即拒绝', () => {
    expect(() => createPlaneTransform({ ...IDENTITY_AFFINE, scale: 0 })).toThrow(RangeError)
    expect(() => createPlaneTransform({ ...IDENTITY_AFFINE, scale: -1 })).toThrow(RangeError)
    expect(() => createPlaneTransform({ ...IDENTITY_AFFINE, scale: Number.NaN })).toThrow(RangeError)
    expect(() => createPlaneTransform({ ...IDENTITY_AFFINE, rotation: Number.POSITIVE_INFINITY })).toThrow(RangeError)
    expect(() => createPlaneTransform({ ...IDENTITY_AFFINE, translateX: Number.NaN })).toThrow(RangeError)
    expect(() => createPlaneTransform({ ...IDENTITY_AFFINE, translateY: Number.NaN })).toThrow(RangeError)
  })

  it('恒等变换保持点与方向角不变', () => {
    const plane = createPlaneTransform(IDENTITY_AFFINE)
    expect(plane.transformPoint(3, -4)).toEqual({ x: 3, y: -4 })
    expect(plane.transformAngle(0.75)).toBe(0.75)
  })

  it('缩放与平移独立生效', () => {
    const plane = createPlaneTransform({ scale: 2, rotation: 0, mirrorY: false, translateX: 10, translateY: 20 })
    expect(plane.transformPoint(3, 4)).toEqual({ x: 16, y: 28 })
    expect(plane.transformAngle(1)).toBe(1)
  })

  it('组合仿射严格按「镜像 → 旋转 → 缩放 → 平移」顺序复合', () => {
    const plane = createPlaneTransform({ scale: 2, rotation: Math.PI / 2, mirrorY: true, translateX: 10, translateY: 20 })
    // (1,2)：镜像 → (1,-2)；旋转 90° → (2,1)；缩放 → (4,2)；平移 → (14,22)
    expect(plane.transformPoint(1, 2)).toEqual({ x: 14, y: 22 })
  })

  it('方向角合成：无镜像为 θ+α，镜像为先翻转再加 α', () => {
    const rotated = createPlaneTransform({ scale: 1, rotation: Math.PI / 2, mirrorY: false, translateX: 0, translateY: 0 })
    expect(rotated.transformAngle(0)).toBeCloseTo(Math.PI / 2, 12)
    const mirrored = createPlaneTransform({ scale: 1, rotation: 0, mirrorY: true, translateX: 0, translateY: 0 })
    expect(mirrored.transformAngle(Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 12)
    const both = createPlaneTransform({ scale: 1, rotation: Math.PI / 2, mirrorY: true, translateX: 0, translateY: 0 })
    // θ=0：镜像不变 0，加旋转 → π/2
    expect(both.transformAngle(0)).toBeCloseTo(Math.PI / 2, 12)
  })
})

describe('createWorldTransform', () => {
  it('原点非有限时构造即拒绝', () => {
    const plane = createPlaneTransform(IDENTITY_AFFINE)
    expect(() => createWorldTransform(plane, { x: Number.NaN, y: 0 })).toThrow(RangeError)
  })

  it('恒等变换下符合 §2.5 公式：worldX = mapX − originX、worldZ = mapY − originY', () => {
    const plane = createPlaneTransform(IDENTITY_AFFINE)
    const world = createWorldTransform(plane, { x: 10, y: 10 })
    expect(world.toWorldXZ(15, 4)).toEqual({ x: 5, z: -6 })
    expect(world.toWorldXZ(10, 10)).toEqual({ x: 0, z: 0 })
  })

  it('rotation.y = −平面角（符号翻转只发生在世界映射层）', () => {
    const plane = createPlaneTransform(IDENTITY_AFFINE)
    const world = createWorldTransform(plane, { x: 0, y: 0 })
    expect(world.angleToWorldYRotation(Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 12)
    // 与仿射组合：镜像下 θ=π/2 的平面角为 -π/2，世界 rotation.y 反转为 +π/2
    const mirrored = createWorldTransform(
      createPlaneTransform({ scale: 1, rotation: 0, mirrorY: true, translateX: 0, translateY: 0 }),
      { x: 0, y: 0 },
    )
    expect(mirrored.angleToWorldYRotation(Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12)
  })

  it('原点只记录传入值：世界映射不会二次施加仿射', () => {
    const plane = createPlaneTransform({ scale: 2, rotation: 0, mirrorY: false, translateX: 5, translateY: 5 })
    const world = createWorldTransform(plane, { x: 11, y: 11 })
    // (3,3) → 仿射 (11,11) → 世界 (0,0)：原点即「仿射后的 bounds 中心」
    expect(world.toWorldXZ(3, 3)).toEqual({ x: 0, z: 0 })
    expect(world.origin).toEqual({ x: 11, y: 11 })
  })
})
