import { describe, expect, it } from 'vitest'

import {
  EMPTY_FACTORY_DEPTH,
  EMPTY_FACTORY_WIDTH,
  computeMapBounds,
  deriveFactoryBounds,
} from './bounds'
import { mapToWorld } from './coordinates'
import type { FactoryMap, FactoryMapEdge, FactoryMapNode } from './factoryMap'
import { createFactoryMap } from './factoryMap'

const MARGIN = 10 // FACTORY_MARGIN（config/sceneMetrics.ts），domain 测试内联固定值

function makeNode(id: string, x: number, y: number): FactoryMapNode {
  return { id, name: id, type: 'node', x, y, angle: null }
}

function makeLineEdge(id: string, sx: number, sy: number, ex: number, ey: number): FactoryMapEdge {
  return {
    id, name: id, edgeType: 'LINE',
    sx, sy, ex, ey,
    cx: null, cy: null, dx: null, dy: null,
    isBackEdge: false, snodeId: 'a', enodeId: 'b',
  }
}

function makeBezierEdge(
  id: string,
  sx: number, sy: number,
  cx: number, cy: number,
  dx: number, dy: number,
  ex: number, ey: number,
): FactoryMapEdge {
  return {
    id, name: id, edgeType: 'BEZIER',
    sx, sy, ex, ey, cx, cy, dx, dy,
    isBackEdge: false, snodeId: 'a', enodeId: 'b',
  }
}

describe('computeMapBounds（SPEC §6.1、§15.1 bounds 行）', () => {
  it('节点、路径端点与贝塞尔控制点的联合 bbox', () => {
    const map: FactoryMap = createFactoryMap(
      [makeNode('n1', 5, 5)],
      [
        makeLineEdge('e1', -3, 8, 2, 1),
        makeBezierEdge('e2', 0, 0, 12, -7, -4, 3, 1, 1),
      ],
    )
    expect(computeMapBounds(map)).toEqual({ minX: -4, maxX: 12, minY: -7, maxY: 8 })
  })

  it('LINE 的 null 控制点不参与 bbox', () => {
    const map = createFactoryMap([], [makeLineEdge('e1', 1, 2, 3, 4)])
    expect(computeMapBounds(map)).toEqual({ minX: 1, maxX: 3, minY: 2, maxY: 4 })
  })

  it('负坐标参与 min/max', () => {
    const map = createFactoryMap([makeNode('n1', -20, -30), makeNode('n2', -5, -10)], [])
    expect(computeMapBounds(map)).toEqual({ minX: -20, maxX: -5, minY: -30, maxY: -10 })
  })

  it('仅节点无路径：bbox 只取节点坐标', () => {
    const map = createFactoryMap([makeNode('n1', 1, 1), makeNode('n2', 9, 6)], [])
    expect(computeMapBounds(map)).toEqual({ minX: 1, maxX: 9, minY: 1, maxY: 6 })
  })

  it('空地图（nodes 与 edges 同时为空）返回 null', () => {
    expect(computeMapBounds(createFactoryMap([], []))).toBeNull()
  })

  it('返回不可变值对象', () => {
    const bounds = computeMapBounds(createFactoryMap([makeNode('n1', 1, 2)], []))
    expect(bounds).not.toBeNull()
    expect(Object.isFrozen(bounds)).toBe(true)
  })
})

describe('deriveFactoryBounds（SPEC §6.1）', () => {
  it('bbox 四周各外扩 margin，z 由 -y 推导', () => {
    const factory = deriveFactoryBounds({ minX: -3, maxX: 12, minY: -7, maxY: 8 }, MARGIN)
    expect(factory).toEqual({
      innerMinX: -13,
      innerMaxX: 22,
      innerMinZ: -18, // -maxY - margin
      innerMaxZ: 17, // -minY + margin
      centerX: 4.5,
      centerZ: -0.5,
      innerWidth: 35,
      innerDepth: 35,
    })
  })

  it('空态使用 60m × 40m 空场景尺寸并居中于原点', () => {
    const factory = deriveFactoryBounds(null, MARGIN)
    expect(factory.innerWidth).toBe(EMPTY_FACTORY_WIDTH)
    expect(factory.innerDepth).toBe(EMPTY_FACTORY_DEPTH)
    expect(EMPTY_FACTORY_WIDTH).toBe(60)
    expect(EMPTY_FACTORY_DEPTH).toBe(40)
    expect(factory).toEqual({
      innerMinX: -30,
      innerMaxX: 30,
      innerMinZ: -20,
      innerMaxZ: 20,
      centerX: 0,
      centerZ: 0,
      innerWidth: 60,
      innerDepth: 40,
    })
  })

  it('innerMinX/innerMinZ 是厂房内边界而非平移量：地图世界坐标不二次平移', () => {
    // 单节点地图：节点世界坐标必须保持 mapToWorld 原值，且落在内边界之内
    const map = createFactoryMap([makeNode('n1', 50, -20)], [])
    const bounds = computeMapBounds(map)
    const factory = deriveFactoryBounds(bounds, MARGIN)

    const world = mapToWorld(50, -20)
    expect(world.x).toBe(50) // 不减去 innerMinX，不做任何二次平移
    expect(world.z).toBe(20)
    expect(factory.innerMinX).toBe(40)
    expect(factory.innerMaxX).toBe(60)
    expect(factory.innerMinZ).toBe(10)
    expect(factory.innerMaxZ).toBe(30)
    expect(world.x).toBeGreaterThanOrEqual(factory.innerMinX)
    expect(world.x).toBeLessThanOrEqual(factory.innerMaxX)
    expect(world.z).toBeGreaterThanOrEqual(factory.innerMinZ)
    expect(world.z).toBeLessThanOrEqual(factory.innerMaxZ)
    // 内边界围绕原始地图坐标展开，中心即节点本身
    expect(factory.centerX).toBe(50)
    expect(factory.centerZ).toBe(20)
  })

  it('基准数据尺度：bbox 167.84m × 75.32m → 内空 187.84m × 95.32m（§3.4、§6.1）', () => {
    const map = createFactoryMap(
      [makeNode('n1', 0, 0), makeNode('n2', 167.84, 75.32)],
      [],
    )
    const factory = deriveFactoryBounds(computeMapBounds(map), MARGIN)
    expect(factory.innerWidth).toBeCloseTo(187.84, 10)
    expect(factory.innerDepth).toBeCloseTo(95.32, 10)
  })

  it('返回不可变值对象', () => {
    expect(Object.isFrozen(deriveFactoryBounds({ minX: 0, maxX: 1, minY: 0, maxY: 1 }, MARGIN))).toBe(true)
    expect(Object.isFrozen(deriveFactoryBounds(null, MARGIN))).toBe(true)
  })
})
