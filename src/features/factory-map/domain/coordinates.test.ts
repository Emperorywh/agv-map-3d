import { describe, expect, it } from 'vitest'

import { mapToWorld, normalizeMapAngle, worldToMap, yawFromMapAngle } from './coordinates'

describe('mapToWorld（SPEC §4.1）', () => {
  it('原点映射到世界原点，且不产生 -0', () => {
    const world = mapToWorld(0, 0)
    expect(world.x).toBe(0)
    expect(world.y).toBe(0)
    expect(Object.is(world.z, 0)).toBe(true)
  })

  it('正东方向：world.x = map.x，z 为 0', () => {
    const world = mapToWorld(10, 0)
    expect(world).toEqual({ x: 10, y: 0, z: 0 })
  })

  it('正北方向（map.y 增大）映射为 -z，保证俯视时北在上', () => {
    const world = mapToWorld(0, 8)
    expect(world).toEqual({ x: 0, y: 0, z: -8 })
  })

  it('一般点：world.x = map.x、world.z = -map.y', () => {
    expect(mapToWorld(3.5, -12.25)).toEqual({ x: 3.5, y: 0, z: 12.25 })
    expect(mapToWorld(-7, 21)).toEqual({ x: -7, y: 0, z: -21 })
  })

  it('map → world → map 往返不变量', () => {
    const samples: Array<[number, number]> = [
      [0, 0],
      [1, 2],
      [-3.75, 4.5],
      [167.84, -75.32],
      [-1000, 1000],
    ]
    for (const [x, y] of samples) {
      const world = mapToWorld(x, y)
      const roundTrip = worldToMap(world.x, world.z)
      expect(roundTrip.x).toBe(x)
      expect(roundTrip.y).toBe(y)
    }
  })

  it('worldToMap 消除 -0', () => {
    expect(Object.is(worldToMap(1, 0).y, 0)).toBe(true)
  })
})

describe('yawFromMapAngle（SPEC §4.2）', () => {
  it('数据朝向 (cosθ, sinθ) 与世界方向 (cosθ, 0, -sinθ) 一致：rotation.y 直接取 θ', () => {
    const angles = [0, Math.PI / 2, -Math.PI / 2, Math.PI / 3, -2.4]
    for (const theta of angles) {
      const yaw = yawFromMapAngle(theta)
      // +X 前向几何体经 rotation.y = yaw 后的朝向为 (cos yaw, 0, -sin yaw)
      expect(Math.cos(yaw)).toBeCloseTo(Math.cos(theta), 12)
      expect(-Math.sin(yaw)).toBeCloseTo(-Math.sin(theta), 12)
    }
  })

  it('东 0°、北 90°：北向站点 yaw 为 +π/2', () => {
    expect(yawFromMapAngle(0)).toBe(0)
    expect(yawFromMapAngle(Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12)
  })
})

describe('normalizeMapAngle（SPEC §3.3 angle 规则）', () => {
  it('已在 [-π, π) 内的角度保持不变', () => {
    expect(normalizeMapAngle(0)).toBe(0)
    expect(normalizeMapAngle(1.2)).toBe(1.2)
    expect(normalizeMapAngle(-1.2)).toBe(-1.2)
    expect(normalizeMapAngle(-Math.PI)).toBe(-Math.PI)
  })

  it('π 归入 -π（右开区间）', () => {
    expect(normalizeMapAngle(Math.PI)).toBe(-Math.PI)
  })

  it('整圈倍数归一到 0，且不产生 -0', () => {
    expect(normalizeMapAngle(2 * Math.PI)).toBe(0)
    expect(Object.is(normalizeMapAngle(-2 * Math.PI), 0)).toBe(true)
  })

  it('多圈角度折叠进 [-π, π)', () => {
    expect(normalizeMapAngle(3 * Math.PI)).toBe(-Math.PI)
    expect(normalizeMapAngle(5 * Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12)
    expect(normalizeMapAngle(-3 * Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12)
    expect(normalizeMapAngle(-5 * Math.PI / 3)).toBeCloseTo(Math.PI / 3, 12)
  })
})
