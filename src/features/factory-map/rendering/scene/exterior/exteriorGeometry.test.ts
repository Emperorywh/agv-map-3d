/**
 * exteriorGeometry 单元测试（SPEC §6.5、§4.3）。
 *
 * - 室外地坪：2000×2000m、以厂房中心为中心、y=-0.02、法线 +Y、绕序一致；
 * - 太阳方向：normalize(0.5, 1, 0.35)，单位向量，Sky 与 §6.6 平行光同源。
 */

import { describe, expect, it } from 'vitest'

import type { FactoryBoundsDto } from '../../../application/factorySceneModel'
import {
  OUTDOOR_GROUND_SIZE,
  OUTDOOR_GROUND_Y,
  buildOutdoorGroundGeometry,
  sunDirection,
} from './exteriorGeometry'

/** double → float32 舍入（BufferAttribute Float32Array 存储语义） */
const f32 = Math.fround

/** 非居中厂房边界（验证以厂房中心为中心，而非原点） */
const BOUNDS: FactoryBoundsDto = {
  innerMinX: -83.92,
  innerMaxX: 103.92,
  innerMinZ: -57.66,
  innerMaxZ: 37.66,
  centerX: 10,
  centerZ: -10,
}

describe('buildOutdoorGroundGeometry（§6.5）', () => {
  const geometry = buildOutdoorGroundGeometry(BOUNDS)
  const positions = geometry.getAttribute('position').array as Float32Array
  const normals = geometry.getAttribute('normal').array as Float32Array
  const indices = geometry.getIndex()!.array as Uint32Array

  it('2000×2000m 以厂房中心为中心，y=-0.02', () => {
    const half = OUTDOOR_GROUND_SIZE / 2
    expect([...positions]).toEqual([
      BOUNDS.centerX - half, f32(OUTDOOR_GROUND_Y), BOUNDS.centerZ - half,
      BOUNDS.centerX - half, f32(OUTDOOR_GROUND_Y), BOUNDS.centerZ + half,
      BOUNDS.centerX + half, f32(OUTDOOR_GROUND_Y), BOUNDS.centerZ + half,
      BOUNDS.centerX + half, f32(OUTDOOR_GROUND_Y), BOUNDS.centerZ - half,
    ])
    expect(OUTDOOR_GROUND_SIZE).toBe(2000)
    expect(OUTDOOR_GROUND_Y).toBe(-0.02)
  })

  it('2 个三角形、法线 +Y、绕序与法线一致（从上方可见正面）', () => {
    expect(indices.length).toBe(6)
    expect([...indices]).toEqual([0, 1, 2, 0, 2, 3])
    for (let i = 0; i < normals.length; i += 3) {
      expect([normals[i], normals[i + 1], normals[i + 2]]).toEqual([0, 1, 0])
    }
    // (v1-v0)×(v2-v0) 必须与 +Y 法线同向
    const e1 = [positions[3] - positions[0], positions[4] - positions[1], positions[5] - positions[2]]
    const e2 = [positions[6] - positions[0], positions[7] - positions[1], positions[8] - positions[2]]
    const crossY = e1[2] * e2[0] - e1[0] * e2[2]
    expect(crossY).toBeGreaterThan(0)
  })
})

describe('sunDirection（§6.5/§6.6）', () => {
  it('等于 normalize(0.5, 1, 0.35) 且为单位向量', () => {
    const direction = sunDirection()
    const length = Math.hypot(0.5, 1, 0.35)
    expect(direction[0]).toBeCloseTo(0.5 / length, 12)
    expect(direction[1]).toBeCloseTo(1 / length, 12)
    expect(direction[2]).toBeCloseTo(0.35 / length, 12)
    expect(Math.hypot(direction[0], direction[1], direction[2])).toBeCloseTo(1, 12)
  })
})
