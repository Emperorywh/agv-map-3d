/**
 * floorGeometry 单元测试（SPEC §6.2、§4.3）。
 *
 * - 地坪 Box：顶面 y=0、厚 0.3m；仅顶面世界坐标 UV（u=x/12、v=z/12），
 *   侧面/底面 UV 全部为纯净基色 texel；各面法线朝外；全部三角形绕序与法线一致；
 * - 分缝：6m 世界对齐、宽 0.02m、y=+0.002、单一 BufferGeometry；边界重合缝不生成。
 */

import { BufferGeometry } from 'three'
import { describe, expect, it } from 'vitest'

import type { FactoryBoundsDto } from '../../../application/factorySceneModel'
import { FLOOR_JOINT } from '../../../config/sceneMetrics'
import {
  FLOOR_JOINT_WIDTH,
  FLOOR_JOINT_Y,
  FLOOR_TEXTURE_REPEAT_METERS,
  FLOOR_THICKNESS,
  buildFloorGeometry,
  buildFloorJointGeometry,
} from './floorGeometry'
import { FLOOR_TEXTURE_SIZE } from './floorTexture'

/** 空态厂房边界（60×40，居中于原点，§6.1） */
const EMPTY_BOUNDS: FactoryBoundsDto = {
  innerMinX: -30,
  innerMaxX: 30,
  innerMinZ: -20,
  innerMaxZ: 20,
  centerX: 0,
  centerZ: 0,
}

/** 非居中、非整数边界（世界坐标不再二次平移的直接验证） */
const OFFSET_BOUNDS: FactoryBoundsDto = {
  innerMinX: -93.92,
  innerMaxX: 93.92,
  innerMinZ: -47.66,
  innerMaxZ: 47.66,
  centerX: 0,
  centerZ: 0,
}

/** double → float32 舍入（BufferAttribute Float32Array 存储语义） */
const f32 = Math.fround

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

describe('buildFloorGeometry（§6.2）', () => {
  const geometry = buildFloorGeometry(OFFSET_BOUNDS)

  it('6 面盒体：24 顶点、36 索引，索引全部合法且坐标有限', () => {
    expect(positionsOf(geometry).length).toBe(24 * 3)
    expect(indicesOf(geometry).length).toBe(36)
    for (const index of indicesOf(geometry)) {
      expect(index).toBeLessThan(24)
    }
    for (const value of positionsOf(geometry)) {
      expect(Number.isFinite(value)).toBe(true)
    }
  })

  it('顶面 y=0、底面 y=-0.3，水平范围等于厂房内空边界', () => {
    const positions = positionsOf(geometry)
    const xs = new Set<number>()
    const ys = new Set<number>()
    const zs = new Set<number>()
    for (let i = 0; i < positions.length; i += 3) {
      xs.add(positions[i])
      ys.add(positions[i + 1])
      zs.add(positions[i + 2])
    }
    expect([...xs].sort((a, b) => a - b)).toEqual([f32(OFFSET_BOUNDS.innerMinX), f32(OFFSET_BOUNDS.innerMaxX)])
    expect([...ys].sort((a, b) => a - b)).toEqual([f32(-FLOOR_THICKNESS), 0])
    expect([...zs].sort((a, b) => a - b)).toEqual([f32(OFFSET_BOUNDS.innerMinZ), f32(OFFSET_BOUNDS.innerMaxZ)])
  })

  it('各面法线朝外：+Y / -Y / +X / -X / +Z / -Z', () => {
    const normals = normalsOf(geometry)
    const expected = [
      [0, 1, 0],
      [0, -1, 0],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1],
    ]
    for (let face = 0; face < 6; face += 1) {
      for (let v = 0; v < 4; v += 1) {
        const offset = (face * 4 + v) * 3
        expect([normals[offset], normals[offset + 1], normals[offset + 2]]).toEqual(expected[face])
      }
    }
  })

  it('仅顶面使用世界坐标 UV（每 12m 重复）；侧面/底面 UV 为纯净基色 texel', () => {
    const positions = positionsOf(geometry)
    const uv = geometry.getAttribute('uv').array as Float32Array
    const clean = 0.5 / FLOOR_TEXTURE_SIZE
    for (let i = 0; i < 24; i += 1) {
      const x = positions[i * 3]
      const y = positions[i * 3 + 1]
      const z = positions[i * 3 + 2]
      if (y === 0 && i < 4) {
        // 顶面（前 4 个顶点）：世界坐标 UV
        expect(uv[i * 2]).toBeCloseTo(x / FLOOR_TEXTURE_REPEAT_METERS, 4)
        expect(uv[i * 2 + 1]).toBeCloseTo(z / FLOOR_TEXTURE_REPEAT_METERS, 4)
      } else {
        expect(uv[i * 2]).toBe(clean)
        expect(uv[i * 2 + 1]).toBe(clean)
      }
    }
  })

  it('全部三角形绕序与法线一致（正面朝外）', () => {
    expectWindingMatchesNormals(geometry)
  })
})

describe('buildFloorJointGeometry（§6.2、§4.3）', () => {
  it('空态 60×40 边界：x 缝 9 条、z 缝 7 条（边界重合缝不生成）', () => {
    // x ∈ (-30, 30) 内 6 的倍数：-24..24 → 9；z ∈ (-20, 20)：-18..18 → 7
    const geometry = buildFloorJointGeometry(EMPTY_BOUNDS)
    expect(positionsOf(geometry).length).toBe((9 + 7) * 4 * 3)
    expect(indicesOf(geometry).length).toBe((9 + 7) * 6)
  })

  it('边界恰为 6 的整数倍时不生成贴墙缝', () => {
    const bounds: FactoryBoundsDto = {
      innerMinX: -30,
      innerMaxX: 30,
      innerMinZ: -18,
      innerMaxZ: 18,
      centerX: 0,
      centerZ: 0,
    }
    const geometry = buildFloorJointGeometry(bounds)
    // x：-24..24 → 9 条；z：-12..12 → 5 条（±18 与墙重合，排除）
    expect(positionsOf(geometry).length).toBe((9 + 5) * 4 * 3)
  })

  it('细条宽 0.02m、y=+0.002、法线 +Y、横贯对向全尺寸', () => {
    const geometry = buildFloorJointGeometry(EMPTY_BOUNDS)
    const positions = positionsOf(geometry)
    const normals = normalsOf(geometry)
    const half = FLOOR_JOINT_WIDTH / 2

    // 首条 x 缝（x = -24）：顶点 (x∓half, +0.002, minZ/maxZ)
    expect([...positions.slice(0, 12)]).toEqual([
      f32(-24 - half), f32(FLOOR_JOINT_Y), EMPTY_BOUNDS.innerMinZ,
      f32(-24 - half), f32(FLOOR_JOINT_Y), EMPTY_BOUNDS.innerMaxZ,
      f32(-24 + half), f32(FLOOR_JOINT_Y), EMPTY_BOUNDS.innerMaxZ,
      f32(-24 + half), f32(FLOOR_JOINT_Y), EMPTY_BOUNDS.innerMinZ,
    ])
    for (let i = 0; i < normals.length; i += 3) {
      expect([normals[i], normals[i + 1], normals[i + 2]]).toEqual([0, 1, 0])
    }
    for (let i = 1; i < positions.length; i += 3) {
      expect(positions[i]).toBe(f32(FLOOR_JOINT_Y))
    }
    // 每条缝短边恰为 0.02m、长边横贯对向全尺寸
    const quadCount = positions.length / 12
    for (let q = 0; q < quadCount; q += 1) {
      let minX = Infinity
      let maxX = -Infinity
      let minZ = Infinity
      let maxZ = -Infinity
      for (let v = 0; v < 4; v += 1) {
        const x = positions[q * 12 + v * 3]
        const z = positions[q * 12 + v * 3 + 2]
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
      }
      const extentX = maxX - minX
      const extentZ = maxZ - minZ
      expect(Math.min(extentX, extentZ)).toBeCloseTo(FLOOR_JOINT_WIDTH, 5)
      expect(Math.max(extentX, extentZ)).toBeCloseTo(
        extentX > extentZ
          ? EMPTY_BOUNDS.innerMaxX - EMPTY_BOUNDS.innerMinX
          : EMPTY_BOUNDS.innerMaxZ - EMPTY_BOUNDS.innerMinZ,
        5,
      )
    }
  })

  it('无 uv attribute（无贴图材质），绕序与法线一致', () => {
    const geometry = buildFloorJointGeometry(EMPTY_BOUNDS)
    expect(geometry.getAttribute('uv')).toBeUndefined()
    expectWindingMatchesNormals(geometry)
  })

  it('范围内不含 6 的倍数时不生成任何缝（空几何）', () => {
    // (1, 3) 内没有 6 的整数倍（注意 0 是 6 的倍数：过原点的厂房本来就有缝）
    const sliver: FactoryBoundsDto = {
      innerMinX: 1,
      innerMaxX: 3,
      innerMinZ: 1,
      innerMaxZ: 3,
      centerX: 2,
      centerZ: 2,
    }
    const geometry = buildFloorJointGeometry(sliver)
    expect(positionsOf(geometry).length).toBe(0)
    expect(indicesOf(geometry).length).toBe(0)
  })

  it('非居中边界的世界对齐：缝位置是 6 的世界倍数而非边界偏移', () => {
    const geometry = buildFloorJointGeometry(OFFSET_BOUNDS)
    const positions = positionsOf(geometry)
    // 首条 x 缝中心 x = ceil(-93.92 / 6) * 6 = -90（世界对齐，不是 -93.92 + 间距）
    expect(positions[0]).toBe(f32(-90 - FLOOR_JOINT_WIDTH / 2))
    expect(FLOOR_JOINT).toBe(6)
  })
})
