/**
 * clampOrbitTarget 单元测试（SPEC §9.2 target 夹取行）。
 *
 * XZ 夹取到厂房内边界外扩 ORBIT_TARGET_CLAMP_MARGIN（20m），Y 恒为 0；
 * out 由调用方预分配（§10.1：相机/夹取计算稳态无分配，验证 out 复用语义）。
 */

import { describe, expect, it } from 'vitest'

import type { FactoryBoundsDto } from '../../application/factorySceneModel'
import { ORBIT_TARGET_CLAMP_MARGIN } from '../../config/cameraConfig'
import { clampOrbitTarget } from './orbitTargetClamp'

/** 偏移 bounds：验证不以原点为中心的对称假设（内空 160m × 120m，中心 (180, -140)） */
const BOUNDS: FactoryBoundsDto = {
  innerMinX: 100,
  innerMaxX: 260,
  innerMinZ: -200,
  innerMaxZ: -80,
  centerX: 180,
  centerZ: -140,
}

const MIN_X = BOUNDS.innerMinX - ORBIT_TARGET_CLAMP_MARGIN // 80
const MAX_X = BOUNDS.innerMaxX + ORBIT_TARGET_CLAMP_MARGIN // 280
const MIN_Z = BOUNDS.innerMinZ - ORBIT_TARGET_CLAMP_MARGIN // -220
const MAX_Z = BOUNDS.innerMaxZ + ORBIT_TARGET_CLAMP_MARGIN // -60

describe('clampOrbitTarget（SPEC §9.2：XZ 外扩 20m 夹取、Y 恒为 0）', () => {
  it('外扩量取自 config：ORBIT_TARGET_CLAMP_MARGIN = 20（§13.3）', () => {
    expect(ORBIT_TARGET_CLAMP_MARGIN).toBe(20)
  })

  it('区域内 target：XZ 原样保留，Y 归零', () => {
    const out: [number, number, number] = [0, 0, 0]
    clampOrbitTarget(BOUNDS, 180, -140, out)
    expect(out).toEqual([180, 0, -140])
  })

  it('区域边界上的 target 不变（恰好位于外扩边界）', () => {
    const out: [number, number, number] = [0, 0, 0]
    clampOrbitTarget(BOUNDS, MIN_X, MIN_Z, out)
    expect(out).toEqual([MIN_X, 0, MIN_Z])
    clampOrbitTarget(BOUNDS, MAX_X, MAX_Z, out)
    expect(out).toEqual([MAX_X, 0, MAX_Z])
  })

  it('越界 target：四个方向分别夹取到外扩边界', () => {
    const out: [number, number, number] = [0, 0, 0]
    clampOrbitTarget(BOUNDS, MIN_X - 0.001, -140, out)
    expect(out).toEqual([MIN_X, 0, -140])
    clampOrbitTarget(BOUNDS, MAX_X + 500, -140, out)
    expect(out).toEqual([MAX_X, 0, -140])
    clampOrbitTarget(BOUNDS, 180, MIN_Z - 1000, out)
    expect(out).toEqual([180, 0, MIN_Z])
    clampOrbitTarget(BOUNDS, 180, MAX_Z + 0.5, out)
    expect(out).toEqual([180, 0, MAX_Z])
  })

  it('输入 y 一律作废：无论当前 y 为何，输出 Y 恒为 0（§9.2）', () => {
    const out: [number, number, number] = [0, 999, 0]
    clampOrbitTarget(BOUNDS, 180, -140, out)
    expect(out[1]).toBe(0)
  })

  it('out 预分配复用：同一 out 对象连续写入（§10.1 稳态无分配）', () => {
    const out: [number, number, number] = [0, 0, 0]
    clampOrbitTarget(BOUNDS, MAX_X + 10, MAX_Z + 10, out)
    expect(out).toEqual([MAX_X, 0, MAX_Z])
    // 复用同一 out：第二次夹取正确覆盖
    clampOrbitTarget(BOUNDS, MIN_X - 10, MIN_Z - 10, out)
    expect(out).toEqual([MIN_X, 0, MIN_Z])
  })
})
