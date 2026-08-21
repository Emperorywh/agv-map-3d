import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildCorridors } from './corridors'
import { normalizeMapFromJson } from './normalize'
import { buildPolyline } from './polyline'
import type { MapPoint, NormalizedEdge } from './types'

// ---------------------------------------------------------------------------
// 测试夹具：直接构造规范化有向边（LINE 折线）
// ---------------------------------------------------------------------------

function makeEdge(
  id: string,
  from: string,
  to: string,
  overrides?: { isBackEdge?: boolean; points?: MapPoint[] },
): NormalizedEdge {
  return {
    id,
    name: id,
    from,
    to,
    geometry: buildPolyline(overrides?.points ?? [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]),
    sFacing: 0,
    eFacing: 0,
    isBackEdge: overrides?.isBackEdge ?? false,
    cost: 1,
    maxSpeedLoad: null,
    maxSpeedFree: null,
    maxRotationSpeedLoad: null,
    maxRotationSpeedFree: null,
    maxAccelerationLoad: null,
    maxAccelerationFree: null,
    maxDecelerationLoad: null,
    maxDecelerationFree: null,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('corridors：无序节点对配对与去重（SPEC §6.1）', () => {
  it('两条反向边聚合为一条双向走廊，方向 nodeA→nodeB 在前', () => {
    const e1 = makeEdge('e1', 'A', 'B')
    const e2 = makeEdge('e2', 'B', 'A')
    const { corridors, stats } = buildCorridors([e1, e2])

    expect(corridors).toHaveLength(1)
    const corridor = corridors[0]
    expect(corridor.id).toBe('c:A|B')
    expect(corridor.nodeA).toBe('A')
    expect(corridor.nodeB).toBe('B')
    expect(corridor.bidirectional).toBe(true)
    expect(corridor.edgeIds).toEqual(['e1', 'e2'])
    expect(corridor.directions).toEqual([
      { edgeId: 'e1', from: 'A', to: 'B', alongGeometry: true, isBack: false },
      { edgeId: 'e2', from: 'B', to: 'A', alongGeometry: false, isBack: false },
    ])
    // 几何一致时取 nodeA→nodeB 方向边（同一折线对象，渲染与模拟零偏差）
    expect(corridor.geometry).toBe(e1.geometry)
    expect(stats.bidirectional).toBe(1)
    expect(stats.bidirectionalBothForward).toBe(1)
    expect(stats.oneWay).toBe(0)
  })

  it('配对结果与输入边顺序无关（确定性）', () => {
    const e1 = makeEdge('e1', 'A', 'B')
    const e2 = makeEdge('e2', 'B', 'A')
    const a = buildCorridors([e1, e2]).corridors
    const b = buildCorridors([e2, e1]).corridors
    expect(a).toEqual(b)
  })

  it('单边聚合成单向走廊，几何即该边几何', () => {
    const edge = makeEdge('e1', 'B', 'A')
    const { corridors, stats } = buildCorridors([edge])

    expect(corridors).toHaveLength(1)
    const corridor = corridors[0]
    expect(corridor.nodeA).toBe('A')
    expect(corridor.nodeB).toBe('B')
    expect(corridor.bidirectional).toBe(false)
    expect(corridor.directions).toEqual([
      { edgeId: 'e1', from: 'B', to: 'A', alongGeometry: true, isBack: false },
    ])
    expect(corridor.geometry).toBe(edge.geometry)
    expect(stats.oneWay).toBe(1)
  })
})

describe('corridors：通行属性 back 归属（SPEC §6.1）', () => {
  it('双向组恰一条 isBackEdge：back 归属于对应方向', () => {
    const { corridors, stats } = buildCorridors([
      makeEdge('e1', 'A', 'B'),
      makeEdge('e2', 'B', 'A', { isBackEdge: true }),
    ])
    expect(corridors[0].directions[0].isBack).toBe(false)
    expect(corridors[0].directions[1].isBack).toBe(true)
    expect(stats.bidirectionalWithBack).toBe(1)
    expect(stats.bidirectionalBothForward).toBe(0)
  })

  it('双向组两条均 back：计入 bidirectionalBothBack', () => {
    const { stats } = buildCorridors([
      makeEdge('e1', 'A', 'B', { isBackEdge: true }),
      makeEdge('e2', 'B', 'A', { isBackEdge: true }),
    ])
    expect(stats.bidirectionalBothBack).toBe(1)
    expect(stats.bidirectionalWithBack).toBe(0)
  })

  it('单向 back 边计入 oneWayBack', () => {
    const { corridors, stats } = buildCorridors([
      makeEdge('e1', 'A', 'B', { isBackEdge: true }),
    ])
    expect(corridors[0].directions[0].isBack).toBe(true)
    expect(stats.oneWayBack).toBe(1)
    expect(stats.oneWay).toBe(1)
  })
})

describe('corridors：统一几何选择（SPEC §6.1 规则 2 / §15.3）', () => {
  it('配对边几何偏差 ≤ 阈值（默认 0.3m）：取 nodeA→nodeB 方向，无警告', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const forward = makeEdge('e1', 'A', 'B', {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    })
    const backward = makeEdge('e2', 'B', 'A', {
      points: [
        { x: 10, y: 0.1 },
        { x: 0, y: 0.1 },
      ],
    })
    const { corridors, stats } = buildCorridors([forward, backward])
    expect(corridors[0].geometry).toBe(forward.geometry)
    expect(stats.geometryMismatch).toBe(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('配对边几何偏差超阈值：取较短者渲染，console 警告并计数', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const forward = makeEdge('e1', 'A', 'B', {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    })
    // 偏差 3m 超阈值，长度 8m 短于正向 10m
    const backward = makeEdge('e2', 'B', 'A', {
      points: [
        { x: 10, y: 3 },
        { x: 2, y: 3 },
      ],
    })
    const { corridors, stats } = buildCorridors([forward, backward])
    const corridor = corridors[0]
    expect(corridor.geometry).toBe(backward.geometry)
    // 参照边为 B→A：正向逆几何行驶、反向顺几何行驶（模拟器按 §7.2 反转复用）
    expect(corridor.directions[0].alongGeometry).toBe(false)
    expect(corridor.directions[1].alongGeometry).toBe(true)
    expect(stats.geometryMismatch).toBe(1)
    expect(warn).toHaveBeenCalled()
  })

  it('阈值可由调用方配置：放宽后不判定为偏差', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const forward = makeEdge('e1', 'A', 'B')
    const backward = makeEdge('e2', 'B', 'A', {
      points: [
        { x: 10, y: 3 },
        { x: 2, y: 3 },
      ],
    })
    const { corridors, stats } = buildCorridors([forward, backward], {
      geometryDeviationThreshold: 10,
    })
    expect(corridors[0].geometry).toBe(forward.geometry)
    expect(stats.geometryMismatch).toBe(0)
  })

  it('同方向重复边（数据异常）：取较短者，警告并计数', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const long = makeEdge('e1', 'A', 'B', {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    })
    const short = makeEdge('e2', 'A', 'B', {
      points: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
      ],
    })
    const { corridors, stats } = buildCorridors([long, short])
    expect(corridors).toHaveLength(1)
    expect(corridors[0].edgeIds).toEqual(['e2'])
    expect(corridors[0].bidirectional).toBe(false)
    expect(stats.duplicateDirectionEdges).toBe(1)
    expect(warn).toHaveBeenCalled()
  })
})

describe('corridors：真实 map.json 集成（SPEC §4.1 实测分布）', () => {
  it('2046 走廊 = 997 双向（871 恰一 back / 126 双非 back / 0 双 back）+ 1049 单向（7 back）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mapJsonPath = fileURLToPath(new URL('../../public/map.json', import.meta.url))
    const { map, stats } = normalizeMapFromJson(readFileSync(mapJsonPath, 'utf8'))
    const corridorStats = stats.corridors

    // 总数与配对封闭（SPEC §4.1）
    expect(map.corridors).toHaveLength(2046)
    expect(corridorStats.corridors).toBe(2046)
    expect(corridorStats.bidirectional).toBe(997)
    expect(corridorStats.oneWay).toBe(1049)
    expect(corridorStats.bidirectionalWithBack).toBe(871)
    expect(corridorStats.bidirectionalBothForward).toBe(126)
    expect(corridorStats.bidirectionalBothBack).toBe(0)
    expect(corridorStats.bidirectionalWithBack +
      corridorStats.bidirectionalBothForward +
      corridorStats.bidirectionalBothBack).toBe(997)
    expect(corridorStats.oneWayBack).toBe(7)
    // 几何偏差超阈值 0 组、无同方向重复边 → 干净数据零警告
    expect(corridorStats.geometryMismatch).toBe(0)
    expect(corridorStats.duplicateDirectionEdges).toBe(0)
    expect(warn).not.toHaveBeenCalled()

    // back 算术封闭：871（配对组内）+ 7（单向）= 878 = isBackEdge 总数
    const backEdgeTotal = map.edges.filter((edge) => edge.isBackEdge).length
    expect(backEdgeTotal).toBe(878)
    expect(corridorStats.bidirectionalWithBack + corridorStats.oneWayBack).toBe(backEdgeTotal)

    // 每条有向边恰好属于一条走廊（3043 条全部分区）
    const memberEdgeIds = map.corridors.flatMap((corridor) => corridor.edgeIds)
    expect(memberEdgeIds).toHaveLength(3043)
    expect(new Set(memberEdgeIds).size).toBe(3043)
    expect(map.edges.every((edge) => memberEdgeIds.includes(edge.id))).toBe(true)

    for (const corridor of map.corridors) {
      // 统一几何携带累积弧长表：单调不减、首项 0、总长 > 0（模拟器按行驶方向反转复用）
      expect(corridor.geometry.length).toBeGreaterThan(0)
      expect(corridor.geometry.cumulativeLengths[0]).toBe(0)
      for (let i = 1; i < corridor.geometry.cumulativeLengths.length; i++) {
        expect(corridor.geometry.cumulativeLengths[i]).toBeGreaterThanOrEqual(
          corridor.geometry.cumulativeLengths[i - 1],
        )
      }
      if (corridor.bidirectional) {
        // 双向：两方向沿几何一正一反
        expect(corridor.directions).toHaveLength(2)
        expect(corridor.directions[0].alongGeometry).not.toBe(corridor.directions[1].alongGeometry)
      } else {
        // 单向：几何即该边几何，恒顺几何
        expect(corridor.directions).toHaveLength(1)
        expect(corridor.directions[0].alongGeometry).toBe(true)
      }
    }
  })
})
