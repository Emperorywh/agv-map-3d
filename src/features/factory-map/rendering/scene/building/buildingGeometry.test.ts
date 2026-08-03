/**
 * buildingGeometry 单元测试（SPEC §6.3）。
 *
 * - 围墙三段高度区间 0~4.0 / 4.0~6.5 / 6.5~8.0；实墙合并几何只含下/上两段
 *  （玻璃带后方不存在不透明几何）；玻璃单独合并；
 * - 墙角：沿 X 墙板外延半厚补角、沿 Z 墙板内缩半厚，无重叠无缝隙；
 * - 墙柱：世界对齐每 6m 一根、0~8m 全高贯通、单一批次实例矩阵为纯平移。
 */

import { BufferGeometry } from 'three'
import { describe, expect, it } from 'vitest'

import type { FactoryBoundsDto } from '../../../application/factorySceneModel'
import { FLOOR_JOINT, WALL_HEIGHT, WINDOW_BAND_BOTTOM, WINDOW_BAND_TOP } from '../../../config/sceneMetrics'
import {
  WALL_COLUMN_SECTION,
  WALL_THICKNESS,
  buildWallColumnInstances,
  buildWallGeometries,
} from './buildingGeometry'

/** 100m × 60m 厂房（居中于原点） */
const BOUNDS: FactoryBoundsDto = {
  innerMinX: -50,
  innerMaxX: 50,
  innerMinZ: -30,
  innerMaxZ: 30,
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

/** 某坐标分量的去重排序值 */
function uniqueSorted(values: Float32Array, stride: number, offset: number): number[] {
  const set = new Set<number>()
  for (let i = offset; i < values.length; i += stride) set.add(values[i])
  return [...set].sort((a, b) => a - b)
}

describe('buildWallGeometries（§6.3）', () => {
  const { solid, glass } = buildWallGeometries(BOUNDS)
  const halfT = WALL_THICKNESS / 2

  it('实墙：4 面墙 × 2 段 = 8 块薄板合并（192 顶点 / 288 索引）', () => {
    expect(positionsOf(solid).length).toBe(8 * 24 * 3)
    expect(indicesOf(solid).length).toBe(8 * 36)
  })

  it('玻璃：4 面墙 × 1 段 = 4 块薄板合并（96 顶点 / 144 索引）', () => {
    expect(positionsOf(glass).length).toBe(4 * 24 * 3)
    expect(indicesOf(glass).length).toBe(4 * 36)
  })

  it('三段高度区间正确：实墙 y ∈ {0, 4, 6.5, 8}，玻璃 y ∈ {4, 6.5}', () => {
    expect(uniqueSorted(positionsOf(solid), 3, 1)).toEqual([
      0, WINDOW_BAND_BOTTOM, WINDOW_BAND_TOP, WALL_HEIGHT,
    ])
    expect(uniqueSorted(positionsOf(glass), 3, 1)).toEqual([WINDOW_BAND_BOTTOM, WINDOW_BAND_TOP])
  })

  it('玻璃带后方无不透明几何：实墙没有任何 4.0 < y < 6.5 的顶点', () => {
    const ys = uniqueSorted(positionsOf(solid), 3, 1)
    for (const y of ys) {
      expect(y <= WINDOW_BAND_BOTTOM || y >= WINDOW_BAND_TOP).toBe(true)
    }
  })

  it('墙角构造：x 顶点 ∈ {±(50+半厚), ±(50-半厚)}，z 顶点 ∈ {±(30+半厚), ±(30-半厚)}', () => {
    const xs = uniqueSorted(positionsOf(solid), 3, 0)
    const zs = uniqueSorted(positionsOf(solid), 3, 2)
    expect(xs.length).toBe(4)
    expect(zs.length).toBe(4)
    const expectedXs = [-50 - halfT, -50 + halfT, 50 - halfT, 50 + halfT]
    const expectedZs = [-30 - halfT, -30 + halfT, 30 - halfT, 30 + halfT]
    for (let i = 0; i < 4; i += 1) {
      expect(xs[i]).toBeCloseTo(expectedXs[i], 5)
      expect(zs[i]).toBeCloseTo(expectedZs[i], 5)
    }
  })

  it('玻璃与实墙同 footprint（同 x/z 顶点集合）', () => {
    expect(uniqueSorted(positionsOf(glass), 3, 0)).toEqual(uniqueSorted(positionsOf(solid), 3, 0))
    expect(uniqueSorted(positionsOf(glass), 3, 2)).toEqual(uniqueSorted(positionsOf(solid), 3, 2))
  })

  it('索引合法、坐标有限、法线轴对齐单位向量、绕序一致', () => {
    for (const geometry of [solid, glass]) {
      const positions = positionsOf(geometry)
      const vertexCount = positions.length / 3
      for (const index of indicesOf(geometry)) {
        expect(index).toBeLessThan(vertexCount)
      }
      for (const value of positions) {
        expect(Number.isFinite(value)).toBe(true)
      }
      const normals = normalsOf(geometry)
      for (let i = 0; i < normals.length; i += 3) {
        const magnitude = Math.hypot(normals[i], normals[i + 1], normals[i + 2])
        expect(magnitude).toBeCloseTo(1, 10)
        const components = [Math.abs(normals[i]), Math.abs(normals[i + 1]), Math.abs(normals[i + 2])].sort((a, b) => a - b)
        expect(components[0]).toBe(0)
        expect(components[1]).toBe(0)
        expect(components[2]).toBe(1)
      }
      expectWindingMatchesNormals(geometry)
    }
  })

  it('进深不足墙厚时沿 Z 墙板退化为不生成（沿 X 墙板仍完整）', () => {
    const shallow: FactoryBoundsDto = {
      innerMinX: -1,
      innerMaxX: 1,
      innerMinZ: -0.05,
      innerMaxZ: 0.05,
      centerX: 0,
      centerZ: 0,
    }
    const pair = buildWallGeometries(shallow)
    // 实墙只剩沿 X 的 2 面 × 2 段 = 4 块；玻璃只剩沿 X 的 2 面 = 2 块
    expect(positionsOf(pair.solid).length).toBe(4 * 24 * 3)
    expect(positionsOf(pair.glass).length).toBe(2 * 24 * 3)
  })
})

describe('buildWallColumnInstances（§6.3）', () => {
  const batch = buildWallColumnInstances(BOUNDS)

  it('世界对齐每 6m 一根：x 向 17×2 + z 向 9×2 = 52 根（100m×60m）', () => {
    // x ∈ (-50, 50)：-48..48 → 17 根/面 × 2 面；z ∈ (-30, 30)：-24..24 → 9 根/面 × 2 面
    expect(batch.count).toBe(17 * 2 + 9 * 2)
    expect(batch.matrices.length).toBe(batch.count * 16)
    expect(FLOOR_JOINT).toBe(6)
  })

  it('实例矩阵为纯平移：旋转/缩放部分恒等，柱底 y=0（平移 y=4），柱心压墙板中心线', () => {
    const identityPattern = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]
    let onXWall = 0
    let onZWall = 0
    for (let i = 0; i < batch.count; i += 1) {
      const offset = i * 16
      expect([...batch.matrices.slice(offset, offset + 12)]).toEqual(identityPattern)
      const tx = batch.matrices[offset + 12]
      const ty = batch.matrices[offset + 13]
      const tz = batch.matrices[offset + 14]
      expect(ty).toBe(WALL_HEIGHT / 2)
      expect(Number.isFinite(tx)).toBe(true)
      expect(Number.isFinite(tz)).toBe(true)
      const onX = tz === BOUNDS.innerMinZ || tz === BOUNDS.innerMaxZ
      const onZ = tx === BOUNDS.innerMinX || tx === BOUNDS.innerMaxX
      // 每根柱恰在一面墙上：沿 X 墙板则 x 为 6 的倍数；沿 Z 墙板则 z 为 6 的倍数
      expect(onX !== onZ).toBe(true)
      if (onX) {
        // 注意 -48 % 6 === -0，用 === 0 而非 toBe(0)（Object.is 区分 ±0）
        expect(tx % FLOOR_JOINT === 0).toBe(true)
        onXWall += 1
      } else {
        expect(tz % FLOOR_JOINT === 0).toBe(true)
        onZWall += 1
      }
    }
    expect(onXWall).toBe(34)
    expect(onZWall).toBe(18)
  })

  it('实例几何为 0.26×8×0.26 原点居中盒体（凸出墙面，全高贯通穿过玻璃带）', () => {
    const positions = positionsOf(batch.geometry)
    expect(positions.length).toBe(24 * 3)
    const xs = uniqueSorted(positions, 3, 0)
    const ys = uniqueSorted(positions, 3, 1)
    const zs = uniqueSorted(positions, 3, 2)
    expect(xs[0]).toBeCloseTo(-WALL_COLUMN_SECTION / 2, 5)
    expect(xs[1]).toBeCloseTo(WALL_COLUMN_SECTION / 2, 5)
    expect(ys[0]).toBeCloseTo(-WALL_HEIGHT / 2, 5)
    expect(ys[1]).toBeCloseTo(WALL_HEIGHT / 2, 5)
    expect(zs[0]).toBeCloseTo(-WALL_COLUMN_SECTION / 2, 5)
    expect(zs[1]).toBeCloseTo(WALL_COLUMN_SECTION / 2, 5)
    expectWindingMatchesNormals(batch.geometry)
  })

  it('范围内不含 6 的倍数时无柱（count=0，矩阵为空）', () => {
    // (1, 3) 内没有 6 的整数倍（注意 0 是 6 的倍数：过原点的厂房本来就有柱）
    const sliver: FactoryBoundsDto = {
      innerMinX: 1,
      innerMaxX: 3,
      innerMinZ: 1,
      innerMaxZ: 3,
      centerX: 2,
      centerZ: 2,
    }
    const empty = buildWallColumnInstances(sliver)
    expect(empty.count).toBe(0)
    expect(empty.matrices.length).toBe(0)
  })
})
