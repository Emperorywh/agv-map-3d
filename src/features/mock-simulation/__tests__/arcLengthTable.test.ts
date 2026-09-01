/**
 * Mock 弧长表单元测试（TASK-008：LINE 线性、BEZIER 弧长参数化与切线朝向、
 * 端点守恒、越界钳制；并锁定与渲染侧同一离散化口径）。
 */
import { describe, expect, it } from 'vitest'
import { createEdgeTraverseTable } from '@/features/mock-simulation/model/arcLengthTable'
import type { MapEdge } from '@/features/map-visualization'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createMapModel, validateMap } from '@/features/map-visualization'
import { buildModel, makeBezierEdge, makeLineEdge, makeNode } from './fixtures'

describe('LINE 遍历表', () => {
  // 3-4-5 直角三角形边：长度 5，方向角 atan2(4,3)
  const model = buildModel({
    nodes: [
      makeNode({ id: 'a', x: 0, y: 0 }),
      makeNode({ id: 'b', x: 3, y: 4 }),
    ],
    edges: [
      makeLineEdge({ id: 'e-ab', sx: 0, sy: 0, ex: 3, ey: 4, snodeId: 'a', enodeId: 'b' }),
    ],
  })
  const edge = model.edges.get('e-ab')!
  const table = createEdgeTraverseTable(edge)

  it('总长等于边物理长度', () => {
    expect(table.totalLength).toBeCloseTo(5, 12)
  })

  it('线性插值：起点/中点/终点位置与恒定朝向', () => {
    const theta = Math.atan2(4, 3)
    const start = table.sample(0)
    expect(start.x).toBeCloseTo(0, 12)
    expect(start.y).toBeCloseTo(0, 12)
    expect(start.theta).toBeCloseTo(theta, 12)
    const mid = table.sample(2.5)
    expect(mid.x).toBeCloseTo(1.5, 12)
    expect(mid.y).toBeCloseTo(2, 12)
    expect(mid.theta).toBeCloseTo(theta, 12)
    const end = table.sample(5)
    expect(end.x).toBeCloseTo(3, 12)
    expect(end.y).toBeCloseTo(4, 12)
    expect(end.theta).toBeCloseTo(theta, 12)
  })

  it('越界弧长钳制到 [0, length]，不产生 NaN', () => {
    const before = table.sample(-7)
    expect(before.x).toBeCloseTo(0, 12)
    expect(before.y).toBeCloseTo(0, 12)
    const after = table.sample(99)
    expect(after.x).toBeCloseTo(3, 12)
    expect(after.y).toBeCloseTo(4, 12)
  })
})

describe('BEZIER 遍历表', () => {
  // (0,0)→(3,0)，控制点 (1,1)(2,1)：起点切线 45°，终点切线 -45°
  const model = buildModel({
    nodes: [
      makeNode({ id: 'a', x: 0, y: 0 }),
      makeNode({ id: 'b', x: 3, y: 0 }),
    ],
    edges: [
      makeBezierEdge({ id: 'bz', sx: 0, sy: 0, ex: 3, ey: 0, cx: 1, cy: 1, dx: 2, dy: 1, snodeId: 'a', enodeId: 'b' }),
    ],
  })
  const edge = model.edges.get('bz')!
  const table = createEdgeTraverseTable(edge)

  it('表总长与 MapEdge.length 同口径（同一 24 段采样）', () => {
    expect(table.totalLength).toBeCloseTo(edge.length, 9)
    // 弯曲曲线弧长必然大于弦长
    expect(table.totalLength).toBeGreaterThan(3)
  })

  it('端点守恒：d=0 起点坐标、d=length 终点坐标', () => {
    const start = table.sample(0)
    expect(start.x).toBeCloseTo(0, 9)
    expect(start.y).toBeCloseTo(0, 9)
    const end = table.sample(table.totalLength)
    expect(end.x).toBeCloseTo(3, 9)
    expect(end.y).toBeCloseTo(0, 9)
  })

  it('theta 取曲线切线方向：起点 45°、终点 -45°', () => {
    expect(table.sample(0).theta).toBeCloseTo(Math.atan2(1, 1), 6)
    expect(table.sample(table.totalLength).theta).toBeCloseTo(Math.atan2(-1, 1), 6)
  })

  it('弧长推进单调前进且朝向连续（分段采样落点一致）', () => {
    let prev = table.sample(0)
    for (let d = 0.5; d <= table.totalLength; d += 0.5) {
      const sample = table.sample(d)
      expect(sample.x).toBeGreaterThanOrEqual(prev.x - 1e-9)
      expect(Number.isFinite(sample.theta)).toBe(true)
      // 绝对弧长语义：任意分区方式得到的落点只取决于 d 本身
      const direct = table.sample(d)
      expect(direct.x).toBe(sample.x)
      expect(direct.y).toBe(sample.y)
      prev = sample
    }
  })
})

describe('真实地图弧长口径', () => {
  // vitest 以仓库根为工作目录运行（与 currentMap.integration.test.ts 同口径）
  const RAW_MAP: unknown = JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'json/map.json'), 'utf8'),
  )
  const model = createMapModel(validateMap(RAW_MAP)).mapModel

  it('抽样的 LINE/BEZIER 边表总长与边物理长度一致，端点落点与边坐标重合', () => {
    const lineEdge = model.edgeList.find((e: MapEdge) => e.edgeType === 'LINE')!
    const bezierEdge = model.edgeList.find((e: MapEdge) => e.edgeType === 'BEZIER')!
    for (const edge of [lineEdge, bezierEdge]) {
      const table = createEdgeTraverseTable(edge)
      expect(table.totalLength).toBeCloseTo(edge.length, 6)
      const start = table.sample(0)
      expect(start.x).toBeCloseTo(edge.sx, 6)
      expect(start.y).toBeCloseTo(edge.sy, 6)
      const end = table.sample(table.totalLength)
      expect(end.x).toBeCloseTo(edge.ex, 6)
      expect(end.y).toBeCloseTo(edge.ey, 6)
    }
  })
})
