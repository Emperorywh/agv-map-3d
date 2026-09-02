/*
 * 地图名称图集测试（与实现共置；TASK-005）。
 *
 * 职责：锁定「地图专属 WebGL 名称资源」的纯逻辑合同：
 * 1. layoutNameAtlas 排布：单元互不重叠、全部在画布内、行满换行、容量不足
 *    时逐项丢弃（隔离不崩溃）、画布高度为不超过上限的最小 2 的幂；
 * 2. collectMapNameLabels：只收集仓库名称 + 独占区名称 + 停车字形，顺序稳定、
 *    key 唯一；work/charge/unknown 节点不产生名称；
 * 3. buildNameQuadGeometry：锚点 + 图集单元 → 世界坐标合批四边形，UV 与单元
 *    一致、宽度 = 宽高比 × 高度、索引为两个三角形；
 * 4. 真实工厂在无 Canvas 2D 环境（jsdom）下抛出稳定错误码，调用方可降级。
 */
import { describe, expect, it } from 'vitest'
import { StructuredError } from '@/shared/diagnostics'
import { createMapModel } from '../model/createMapModel'
import { validateMap } from '../model/validateMap'
import {
  buildNameQuadGeometry,
  collectMapNameLabels,
  createMapNameAtlas,
  layoutNameAtlas,
  PARK_GLYPH_KEY,
  type MapNameLabelSpec,
} from '../scene/mapNameAtlas'
import { makeGroup, makeNode } from './fixtures'

function buildModel() {
  return createMapModel(
    validateMap({
      nodes: [
        makeNode({ id: 'w1', name: 'AMR-PICK001', type: 'warehouse', x: 0, y: 0 }),
        makeNode({ id: 'w2', name: 'AMR-PICK002', type: 'warehouse', x: 5, y: 0 }),
        makeNode({ id: 'c1', name: '充电1', type: 'charge', x: 9, y: 0 }),
        makeNode({ id: 'p1', name: '847', type: 'park', x: 12, y: 0 }),
        makeNode({ id: 'a', name: 'A', type: 'work', x: 2, y: 3 }),
        makeNode({ id: 'u1', name: '未知站', type: 'weird', x: 7, y: 7 }),
      ],
      edges: [],
      zones: [],
      nodeEdgeGroups: [
        makeGroup({ id: 'g1', name: '独占区1' }),
        makeGroup({ id: 'g2', name: '独占区2' }),
      ],
    }),
  )
}

/** 固定宽度测量器：ASCII 每字符 width，中文每字符 2×width（确定性、可复现） */
function makeMeasurer(width: number) {
  return (text: string): number => {
    let total = 0
    for (const char of text) {
      total += char.charCodeAt(0) > 0x2e80 ? width * 2 : width
    }
    return total
  }
}

describe('layoutNameAtlas 排布', () => {
  const specs: MapNameLabelSpec[] = [
    { key: 'k1', text: 'AAA', color: '#fff' },
    { key: 'k2', text: 'BB', color: '#fff' },
    { key: 'k3', text: '独占区1', color: '#fff' },
  ]

  it('单元互不重叠且全部位于画布内，行满后换行', () => {
    const layout = layoutNameAtlas(specs, {
      fontPx: 20,
      paddingPx: 6,
      canvasWidth: 120,
      maxHeight: 512,
      measure: makeMeasurer(10),
    })
    expect(layout.cells.size).toBe(3)
    expect(layout.droppedKeys).toEqual([])
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = []
    for (const cell of layout.cells.values()) {
      placed.push({ x0: cell.x, y0: cell.y, x1: cell.x + cell.w, y1: cell.y + cell.h })
      expect(cell.x).toBeGreaterThanOrEqual(0)
      expect(cell.y).toBeGreaterThanOrEqual(0)
      expect(cell.x + cell.w).toBeLessThanOrEqual(layout.width)
      expect(cell.y + cell.h).toBeLessThanOrEqual(layout.height)
    }
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i]
        const b = placed[j]
        const overlaps =
          a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
        expect(overlaps).toBe(false)
      }
    }
    // 120 宽画布只装得下 'AAA'(42) 与 'BB'(32)；中文条目(82)必须换行
    const k1 = layout.cells.get('k1')!
    const k3 = layout.cells.get('k3')!
    expect(k3.y).toBeGreaterThanOrEqual(k1.y + k1.h)
  })

  it('画布高度为已用高度之上最小的 2 的幂，且不超过上限', () => {
    const layout = layoutNameAtlas(specs, {
      fontPx: 20,
      paddingPx: 6,
      canvasWidth: 4096,
      maxHeight: 4096,
      measure: makeMeasurer(10),
    })
    // 全部条目同一行：已用高度 = 32 → 画布高度 64
    expect(layout.height).toBe(64)

    const many: MapNameLabelSpec[] = Array.from({ length: 100 }, (_, i) => ({
      key: `m${i}`,
      text: `name-${i}`,
      color: '#fff',
    }))
    const wide = layoutNameAtlas(many, {
      fontPx: 20,
      paddingPx: 6,
      canvasWidth: 128,
      maxHeight: 512,
      measure: makeMeasurer(10),
    })
    // 100 条 × 每行约 1 条 → 行数远超 512/32=16 行上限 → 发生丢弃而不是崩溃
    expect(wide.droppedKeys.length).toBeGreaterThan(0)
    expect(wide.height).toBeLessThanOrEqual(512)
    expect(wide.cells.size + wide.droppedKeys.length).toBe(many.length)
  })

  it('容量不足时逐项丢弃并保持已放置条目完整（隔离不级联）', () => {
    // 60 宽画布只放得下 'AAA'；'BB' 与 '独占区1' 换行后超出 32 高上限被丢弃
    const layout = layoutNameAtlas(specs, {
      fontPx: 20,
      paddingPx: 6,
      canvasWidth: 60,
      maxHeight: 32,
      measure: makeMeasurer(10),
    })
    expect(layout.cells.has('k1')).toBe(true)
    expect(layout.cells.has('k2')).toBe(false)
    expect(layout.cells.has('k3')).toBe(false)
    expect(layout.droppedKeys).toEqual(['k2', 'k3'])
  })
})

describe('collectMapNameLabels 收集', () => {
  it('P0-5：仓库节点名称不再收集；只收集独占区名称与停车字形，顺序稳定、key 唯一', () => {
    const labels = collectMapNameLabels(buildModel().mapModel)
    // 2 分组名称 + 1 停车字形；warehouse/work/charge/unknown 均不产生名称
    expect(labels.map((label) => label.key)).toEqual([
      'group:g1',
      'group:g2',
      PARK_GLYPH_KEY,
    ])
    expect(labels[0]).toMatchObject({ text: '独占区1' })
    expect(labels[2]).toMatchObject({ text: 'P' })
  })

  it('无 park 节点时不产生停车字形条目', () => {
    const model = createMapModel(
      validateMap({
        nodes: [makeNode({ id: 'w1', name: 'W', type: 'warehouse', x: 0, y: 0 })],
        edges: [],
        zones: [],
        nodeEdgeGroups: [],
      }),
    )
    const labels = collectMapNameLabels(model.mapModel)
    expect(labels).toHaveLength(0)
  })
})

describe('buildNameQuadGeometry 名称四边形', () => {
  it('单个锚点 → 世界坐标四边形：UV 与图集单元一致，宽度 = 宽高比 × 高度', () => {
    const cell = { x: 32, y: 16, w: 96, h: 32, u0: 0.25, v0: 0.5, u1: 0.75, v1: 0.75 }
    const geometry = buildNameQuadGeometry(
      [{ x: 10, z: -4, cell, heightM: 2 }],
      0.09,
    )
    const position = geometry.getAttribute('position')
    expect(position.count).toBe(4)
    // 宽度 = (96/32) × 2 = 6 → x ∈ [7, 13]；高度 2 → z ∈ [-5, -3]
    expect(position.getX(0)).toBeCloseTo(7, 6)
    expect(position.getX(1)).toBeCloseTo(13, 6)
    expect(position.getY(0)).toBeCloseTo(0.09, 6)
    expect(position.getZ(0)).toBeCloseTo(-5, 6)
    expect(position.getZ(2)).toBeCloseTo(-3, 6)
    const uv = geometry.getAttribute('uv')
    expect(uv.getX(0)).toBeCloseTo(0.25, 6)
    expect(uv.getY(0)).toBeCloseTo(0.75, 6)
    expect(uv.getX(2)).toBeCloseTo(0.75, 6)
    expect(uv.getY(2)).toBeCloseTo(0.5, 6)
    expect(geometry.getIndex()?.count).toBe(6)
  })

  it('多个锚点合批为单个几何（一个 Draw Call 渲染全部名称）', () => {
    const cell = { x: 0, y: 0, w: 64, h: 32, u0: 0, v0: 0, u1: 1, v1: 1 }
    const geometry = buildNameQuadGeometry(
      [
        { x: 0, z: 0, cell, heightM: 1 },
        { x: 5, z: 5, cell, heightM: 2 },
      ],
      0.09,
    )
    expect(geometry.getAttribute('position').count).toBe(8)
    expect(geometry.getAttribute('uv').count).toBe(8)
  })
})

describe('createMapNameAtlas 真实工厂', () => {
  it('无 Canvas 2D 上下文的环境抛出稳定错误码 MAP_NAME_ATLAS_UNAVAILABLE', () => {
    const specs: MapNameLabelSpec[] = [{ key: 'k1', text: 'X', color: '#fff' }]
    let thrown: unknown
    try {
      createMapNameAtlas(specs)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(StructuredError)
    expect((thrown as StructuredError).code).toBe('MAP_NAME_ATLAS_UNAVAILABLE')
  })
})
