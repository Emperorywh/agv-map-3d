/**
 * roofFrameGeometry 单元测试（SPEC §6.4）。
 *
 * - 主梁沿短跨方向、间距 8m、截面 0.35×0.7、梁底标高 8m；檩条沿长跨方向、
 *   间距 4m、截面 0.15×0.3、置于主梁顶（顶标高 9.0 = STRUCTURE_MAX_Y）；
 * - 居中对称排布 n = max(1, floor(span/spacing))，两端等距留白；
 * - 各一个实例批次，实例矩阵为纯平移；无屋面板、无室内立柱。
 */

import { BufferGeometry } from 'three'
import { describe, expect, it } from 'vitest'

import type { FactoryBoundsDto } from '../../../application/factorySceneModel'
import {
  PURLIN_SPACING,
  STRUCTURE_MAX_Y,
  TRUSS_SPACING,
  WALL_HEIGHT,
} from '../../../config/sceneMetrics'
import type { InstanceGeometryBatch } from './buildingGeometry'
import {
  PURLIN_HEIGHT,
  PURLIN_WIDTH,
  TRUSS_BEAM_HEIGHT,
  TRUSS_BEAM_WIDTH,
  buildRoofBeamInstances,
  buildRoofPurlinInstances,
} from './roofFrameGeometry'

/** 100m（X，长跨）× 60m（Z，短跨）厂房 */
const WIDE_BOUNDS: FactoryBoundsDto = {
  innerMinX: -50,
  innerMaxX: 50,
  innerMinZ: -30,
  innerMaxZ: 30,
  centerX: 0,
  centerZ: 0,
}

/** 60m（X，短跨）× 100m（Z，长跨）厂房 */
const DEEP_BOUNDS: FactoryBoundsDto = {
  innerMinX: -30,
  innerMaxX: 30,
  innerMinZ: -50,
  innerMaxZ: 50,
  centerX: 0,
  centerZ: 0,
}

function positionsOf(geometry: BufferGeometry): Float32Array {
  return geometry.getAttribute('position').array as Float32Array
}

function normalsOf(geometry: BufferGeometry): Float32Array {
  return geometry.getAttribute('normal').array as Float32Array
}

function indicesOf(geometry: BufferGeometry): Uint32Array {
  return geometry.getIndex()!.array as Uint32Array
}

/** 每个三角形 (v1-v0)×(v2-v0) 与顶点法线点积 > 0（绕序与法线一致） */
function expectWindingMatchesNormals(geometry: BufferGeometry): void {
  const positions = positionsOf(geometry)
  const normals = normalsOf(geometry)
  const indices = indicesOf(geometry)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3
    const b = indices[t + 1] * 3
    const c = indices[t + 2] * 3
    const e1 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]]
    const e2 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]]
    const cross = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ]
    const dot = cross[0] * normals[a] + cross[1] * normals[a + 1] + cross[2] * normals[a + 2]
    expect(dot, `三角形 ${t / 3} 绕序与法线不一致`).toBeGreaterThan(0)
  }
}

/** 实例几何在某轴上的半长（原点居中盒体） */
function halfExtent(geometry: BufferGeometry, offset: number): number {
  const positions = positionsOf(geometry)
  let min = Infinity
  let max = -Infinity
  for (let i = offset; i < positions.length; i += 3) {
    if (positions[i] < min) min = positions[i]
    if (positions[i] > max) max = positions[i]
  }
  return (max - min) / 2
}

/** 全部实例矩阵的平移分量 */
function translationsOf(batch: InstanceGeometryBatch): [number, number, number][] {
  const out: [number, number, number][] = []
  for (let i = 0; i < batch.count; i += 1) {
    out.push([
      batch.matrices[i * 16 + 12],
      batch.matrices[i * 16 + 13],
      batch.matrices[i * 16 + 14],
    ])
  }
  return out
}

/** 全部实例矩阵旋转/缩放部分为单位阵 */
function expectIdentityRotation(batch: InstanceGeometryBatch): void {
  const identityPattern = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]
  for (let i = 0; i < batch.count; i += 1) {
    expect([...batch.matrices.slice(i * 16, i * 16 + 12)]).toEqual(identityPattern)
  }
}

describe('buildRoofBeamInstances（§6.4 主梁）', () => {
  const batch = buildRoofBeamInstances(WIDE_BOUNDS)

  it('短跨为 Z 时主梁沿 Z 通长：截面 0.35(X)×0.7(Y)，梁长 = 60m', () => {
    expect(halfExtent(batch.geometry, 0)).toBeCloseTo(TRUSS_BEAM_WIDTH / 2, 5)
    expect(halfExtent(batch.geometry, 1)).toBeCloseTo(TRUSS_BEAM_HEIGHT / 2, 5)
    expect(halfExtent(batch.geometry, 2)).toBeCloseTo(30, 5)
  })

  it('沿长跨 8m 间距居中排布：n=12，x = -44 + i·8，梁底标高 8m', () => {
    expect(batch.count).toBe(12)
    const translations = translationsOf(batch)
    for (let i = 0; i < 12; i += 1) {
      expect(translations[i][0]).toBeCloseTo(-44 + i * TRUSS_SPACING, 5)
      expect(translations[i][1]).toBeCloseTo(WALL_HEIGHT + TRUSS_BEAM_HEIGHT / 2, 5)
      expect(translations[i][2]).toBe(0)
    }
    expectIdentityRotation(batch)
    expectWindingMatchesNormals(batch.geometry)
  })

  it('短跨为 X 时主梁沿 X 通长，沿 Z 排布（方向互换）', () => {
    const deep = buildRoofBeamInstances(DEEP_BOUNDS)
    expect(halfExtent(deep.geometry, 0)).toBeCloseTo(30, 5)
    expect(halfExtent(deep.geometry, 1)).toBeCloseTo(TRUSS_BEAM_HEIGHT / 2, 5)
    expect(halfExtent(deep.geometry, 2)).toBeCloseTo(TRUSS_BEAM_WIDTH / 2, 5)
    expect(deep.count).toBe(12)
    const translations = translationsOf(deep)
    for (let i = 0; i < 12; i += 1) {
      expect(translations[i][0]).toBe(0)
      expect(translations[i][2]).toBeCloseTo(-44 + i * TRUSS_SPACING, 5)
    }
  })

  it('正方形厂房（等宽平局）主梁沿 Z（确定性规则）', () => {
    const square: FactoryBoundsDto = {
      innerMinX: -40,
      innerMaxX: 40,
      innerMinZ: -40,
      innerMaxZ: 40,
      centerX: 0,
      centerZ: 0,
    }
    const tie = buildRoofBeamInstances(square)
    expect(halfExtent(tie.geometry, 2)).toBeCloseTo(40, 5)
    expect(halfExtent(tie.geometry, 0)).toBeCloseTo(TRUSS_BEAM_WIDTH / 2, 5)
  })

  it('跨度不足 8m 时居中放 1 根（n = max(1, floor(span/8))）', () => {
    const small: FactoryBoundsDto = {
      innerMinX: -2.5,
      innerMaxX: 2.5,
      innerMinZ: -2,
      innerMaxZ: 2,
      centerX: 0,
      centerZ: 0,
    }
    const single = buildRoofBeamInstances(small)
    expect(single.count).toBe(1)
    const [tx, ty, tz] = translationsOf(single)[0]
    expect(tx).toBe(0)
    expect(ty).toBeCloseTo(WALL_HEIGHT + TRUSS_BEAM_HEIGHT / 2, 5)
    expect(tz).toBe(0)
  })
})

describe('buildRoofPurlinInstances（§6.4 檩条）', () => {
  const batch = buildRoofPurlinInstances(WIDE_BOUNDS)

  it('长跨为 X 时檩条沿 X 通长：截面 0.15(Z)×0.3(Y)，梁长 = 100m', () => {
    expect(halfExtent(batch.geometry, 0)).toBeCloseTo(50, 5)
    expect(halfExtent(batch.geometry, 1)).toBeCloseTo(PURLIN_HEIGHT / 2, 5)
    expect(halfExtent(batch.geometry, 2)).toBeCloseTo(PURLIN_WIDTH / 2, 5)
  })

  it('沿短跨 4m 间距居中排布：n=15，z = -28 + i·4，置于主梁顶', () => {
    expect(batch.count).toBe(15)
    const translations = translationsOf(batch)
    for (let i = 0; i < 15; i += 1) {
      expect(translations[i][0]).toBe(0)
      expect(translations[i][1]).toBeCloseTo(WALL_HEIGHT + TRUSS_BEAM_HEIGHT + PURLIN_HEIGHT / 2, 5)
      expect(translations[i][2]).toBeCloseTo(-28 + i * PURLIN_SPACING, 5)
    }
    expectIdentityRotation(batch)
    expectWindingMatchesNormals(batch.geometry)
  })

  it('檩条顶标高 = STRUCTURE_MAX_Y(9.0m)（§9.1 结构包围盒一致性）', () => {
    const translations = translationsOf(batch)
    expect(translations[0][1] + PURLIN_HEIGHT / 2).toBeCloseTo(STRUCTURE_MAX_Y, 5)
  })

  it('长跨为 Z 时檩条沿 Z 通长，沿 X 排布（方向互换）', () => {
    const deep = buildRoofPurlinInstances(DEEP_BOUNDS)
    expect(halfExtent(deep.geometry, 0)).toBeCloseTo(PURLIN_WIDTH / 2, 5)
    expect(halfExtent(deep.geometry, 2)).toBeCloseTo(50, 5)
    expect(deep.count).toBe(15)
    const translations = translationsOf(deep)
    for (let i = 0; i < 15; i += 1) {
      expect(translations[i][0]).toBeCloseTo(-28 + i * PURLIN_SPACING, 5)
      expect(translations[i][2]).toBe(0)
    }
  })
})
