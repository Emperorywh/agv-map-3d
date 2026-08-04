/**
 * 地图实例局部几何单元测试（SPEC §7.2、§7.3、§7.4）。
 *
 * 几何契约随 TASK-005 冻结：本测试的顶点坐标断言原位于
 * infrastructure/worker/builders 测试（局部几何的唯一消费者是主线程
 * MapSceneResources，故随 TASK-011 与实现一并迁至 rendering/scene/map，
 * 断言逐字保留）。
 */

import { describe, expect, it } from 'vitest'

import type { GeometryBatchDto } from '../../../application/factorySceneModel'
import {
  NODE_GEOMETRY_SEGMENTS,
  createChevronGeometryXZ,
  createDiskGeometryXZ,
  createRingGeometryXZ,
  createStationDirectionGeometryXZ,
} from './instanceGeometry'

interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

function verticesOf(batch: GeometryBatchDto): Vec3[] {
  const out: Vec3[] = []
  for (let i = 0; i < batch.positions.length; i += 3) {
    out.push({ x: batch.positions[i], y: batch.positions[i + 1], z: batch.positions[i + 2] })
  }
  return out
}

function expectAllFinite(batch: GeometryBatchDto): void {
  for (const v of batch.positions) expect(Number.isFinite(v)).toBe(true)
  for (const v of batch.normals) expect(Number.isFinite(v)).toBe(true)
}

/** 全部三角形法线为 +Y（世界坐标叉积 y 分量 > 0），法线属性恒为 (0,1,0) */
function expectUpwardFacing(batch: GeometryBatchDto): void {
  const { positions, normals, indices } = batch
  for (let i = 0; i < normals.length; i += 3) {
    expect([normals[i], normals[i + 1], normals[i + 2]]).toEqual([0, 1, 0])
  }
  for (let i = 0; i < indices.length; i += 3) {
    const [ia, ib, ic] = [indices[i] * 3, indices[i + 1] * 3, indices[i + 2] * 3]
    const crossY =
      (positions[ib + 2] - positions[ia + 2]) * (positions[ic] - positions[ia])
      - (positions[ib] - positions[ia]) * (positions[ic + 2] - positions[ia + 2])
    expect(crossY).toBeGreaterThan(0)
  }
}

function expectVertexNear(verts: readonly Vec3[], x: number, y: number, z: number, tol = 1e-6): void {
  const found = verts.some(
    (v) => Math.abs(v.x - x) <= tol && Math.abs(v.y - y) <= tol && Math.abs(v.z - z) <= tol,
  )
  expect(found, `应存在顶点 (${x.toFixed(5)}, ${y.toFixed(5)}, ${z.toFixed(5)})`).toBe(true)
}

describe('createDiskGeometryXZ（§7.3 普通节点圆盘）', () => {
  it('24 段三角扇：1 中心 + 24 圆周顶点、24 三角形、半径 0.10m、法线 +Y', () => {
    const disk = createDiskGeometryXZ(NODE_GEOMETRY_SEGMENTS, 0.1)
    expect(disk.positions).toHaveLength(25 * 3)
    expect(disk.indices).toHaveLength(24 * 3)
    const verts = verticesOf(disk)
    expectVertexNear(verts, 0, 0, 0)
    // 圆周顶点（本地 XZ 平面：(r·cosφ, 0, -r·sinφ)）：φ=0 → (0.1, 0, 0)
    expectVertexNear(verts, 0.1, 0, 0)
    for (const v of verts.slice(1)) {
      expect(Math.hypot(v.x, v.z)).toBeCloseTo(0.1, 6)
    }
    expectAllFinite(disk)
    expectUpwardFacing(disk)
  })
})

describe('createRingGeometryXZ（§7.3 站点圆环）', () => {
  it('24 段：外圈 24 + 内圈 24 顶点、48 三角形、外 0.15 / 内 0.09、法线 +Y', () => {
    const ring = createRingGeometryXZ(NODE_GEOMETRY_SEGMENTS, 0.15, 0.09)
    expect(ring.positions).toHaveLength(48 * 3)
    expect(ring.indices).toHaveLength(48 * 3)
    const radii = verticesOf(ring).map((v) => Math.hypot(v.x, v.z))
    const outer = radii.filter((r) => r > 0.12)
    const inner = radii.filter((r) => r <= 0.12)
    expect(outer).toHaveLength(24)
    expect(inner).toHaveLength(24)
    for (const r of outer) expect(r).toBeCloseTo(0.15, 6)
    for (const r of inner) expect(r).toBeCloseTo(0.09, 6)
    expectAllFinite(ring)
    expectUpwardFacing(ring)
  })
})

describe('createStationDirectionGeometryXZ（§7.4 站点朝向符号）', () => {
  it('两片 quad：顶点 (+0.55r,0)、翼端 (0,±0.5r)、条宽 0.05m（r=0.15），+X 前向', () => {
    const symbol = createStationDirectionGeometryXZ(0.15)
    expect(symbol.positions).toHaveLength(8 * 3)
    expect(symbol.indices).toHaveLength(4 * 3)
    const verts = verticesOf(symbol)
    const expected: Array<[number, number]> = [
      [0.0656832, 0.0184985], [0.0993168, -0.0184985], [-0.0168168, -0.0565015], [0.0168168, -0.0934985],
      [0.0993168, 0.0184985], [0.0656832, -0.0184985], [0.0168168, 0.0934985], [-0.0168168, 0.0565015],
    ]
    for (const [x, z] of expected) {
      expectVertexNear(verts, x, 0, z)
    }
    // +X 前向：符号尖端在 +X 侧，翼端在原点附近
    const xs = verts.map((v) => v.x)
    expect(Math.max(...xs)).toBeCloseTo(0.0993168, 5)
    expect(Math.min(...xs)).toBeCloseTo(-0.0168168, 5)
    expectAllFinite(symbol)
    expectUpwardFacing(symbol)
  })
})

describe('createChevronGeometryXZ（SPEC §7.2 实例局部几何）', () => {
  it('两片 quad：8 顶点 4 三角形，顶点 (+0.18,0)、翼端 (-0.10,±0.14)、条宽 0.06m', () => {
    const geometry = createChevronGeometryXZ()
    expect(geometry.positions).toHaveLength(8 * 3)
    expect(geometry.indices).toHaveLength(4 * 3)
    const verts = verticesOf(geometry)
    // 叶片顶点集合（数据坐标 (x, y) → 本地世界 (x, 0, -y)）
    const expected: Array<[number, number]> = [
      [0.1665836, 0.0268328], [0.1934164, -0.0268328], [-0.1134164, -0.1131672], [-0.0865836, -0.1668328],
      [0.1934164, 0.0268328], [0.1665836, -0.0268328], [-0.0865836, 0.1668328], [-0.1134164, 0.1131672],
    ]
    for (const [x, z] of expected) {
      expectVertexNear(verts, x, 0, z, 1e-6)
    }
    // +X 前向：最前点 x > 0.18（顶点附近），最后点 x < -0.08
    const xs = verts.map((v) => v.x)
    expect(Math.max(...xs)).toBeCloseTo(0.1934164, 5)
    expect(Math.min(...xs)).toBeCloseTo(-0.1134164, 5)
    expectAllFinite(geometry)
    expectUpwardFacing(geometry)
  })
})
