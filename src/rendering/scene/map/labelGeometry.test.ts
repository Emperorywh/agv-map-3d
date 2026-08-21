import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { BufferAttribute } from 'three'

import {
  LABEL_ANCHOR_HEIGHT,
  LABEL_ATLAS_CELL_SIZE,
  LABEL_ATLAS_MAX_SIZE,
  LABEL_ORTHO_MAX_VIEW_WIDTH,
  LABEL_PERSPECTIVE_MAX_DISTANCE,
} from '../../../config/constants'
import { mapToWorld } from '../../../domain/coordinates'
import { normalizeMapFromJson } from '../../../domain/normalize'
import type { Calibration, NodeKind, NormalizedNode } from '../../../domain/types'
import type { AtlasGlyph } from './labelAtlas'
import { collectUniqueChars, computeAtlasLayout } from './labelAtlas'
import type { LabelAnchor, LabelGlyphSource, LabelVisibilityThresholds } from './labelGeometry'
import {
  LABEL_LEVEL_COUNT,
  buildLabelBatch,
  buildNodeLabelAnchors,
  layoutLabelQuads,
  nodeKindToLabelLevel,
  resolveLabelVisibility,
} from './labelGeometry'

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

const CONFIG_THRESHOLDS: LabelVisibilityThresholds = {
  perspectiveMaxDistance: LABEL_PERSPECTIVE_MAX_DISTANCE,
  orthoMaxViewWidth: LABEL_ORTHO_MAX_VIEW_WIDTH,
}

/** 手工字形：aspect 与 UV 显式给定，验证几何层对字形表的透传 */
function makeGlyph(char: string, aspect: number): AtlasGlyph {
  return { char, aspect, u0: 0.1, v0: 0.2, u1: 0.3, v1: 0.4 }
}

function makeSource(glyphs: Record<string, number>): LabelGlyphSource {
  return {
    getGlyph(char: string) {
      const aspect = glyphs[char]
      return aspect === undefined ? null : makeGlyph(char, aspect)
    },
  }
}

let nextId = 0
function makeNode(kind: NodeKind, name: string, x: number, y: number): NormalizedNode {
  nextId += 1
  return { id: `n${nextId}`, name, kind, x, y, angle: null }
}

// ---------------------------------------------------------------------------
// 标签等级映射（SPEC §6.4）
// ---------------------------------------------------------------------------

describe('labelGeometry：节点类型 → 标签等级', () => {
  it('work / charge → 关键(0)，park → 1，node → 2，elevator 不渲染(null)', () => {
    expect(nodeKindToLabelLevel('work')).toBe(0)
    expect(nodeKindToLabelLevel('charge')).toBe(0)
    expect(nodeKindToLabelLevel('park')).toBe(1)
    expect(nodeKindToLabelLevel('node')).toBe(2)
    expect(nodeKindToLabelLevel('elevator')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 距离 / 视野宽度分级（纯函数，阈值来自 config 常量）
// ---------------------------------------------------------------------------

describe('labelGeometry：透视距离分级（SPEC §6.4：>80 隐藏 / 20~80 仅 work、charge / ≤20 全部）', () => {
  const vis = (distance: number) =>
    resolveLabelVisibility({ mode: 'perspective', cameraDistance: distance }, CONFIG_THRESHOLDS)

  it('距离 > 80m：全部等级隐藏', () => {
    expect(vis(81)).toEqual([false, false, false])
    expect(vis(400)).toEqual([false, false, false])
  })

  it('20m < 距离 ≤ 80m：仅 work/charge（等级 0）可见', () => {
    expect(vis(80)).toEqual([true, false, false])
    expect(vis(50)).toEqual([true, false, false])
    expect(vis(20.5)).toEqual([true, false, false])
  })

  it('距离 ≤ 20m：全部等级可见（边界值取 ≤，与 node 整类隐藏同口径）', () => {
    expect(vis(20)).toEqual([true, true, true])
    expect(vis(5)).toEqual([true, true, true])
  })
})

describe('labelGeometry：正交俯视视野宽度分级（SPEC §6.4：>160 仅 work、charge / 60~160 加 park / ≤60 全部）', () => {
  const vis = (viewWidth: number) =>
    resolveLabelVisibility({ mode: 'orthographic', viewWidth }, CONFIG_THRESHOLDS)

  it('视野 > 160m：仅 work/charge 可见（等级 0 不限宽，全图关键标签恒可读）', () => {
    expect(vis(400)).toEqual([true, false, false])
    expect(vis(160.5)).toEqual([true, false, false])
  })

  it('60m < 视野 ≤ 160m：work/charge + park', () => {
    expect(vis(160)).toEqual([true, true, false])
    expect(vis(100)).toEqual([true, true, false])
    expect(vis(60.5)).toEqual([true, true, false])
  })

  it('视野 ≤ 60m：全部等级可见', () => {
    expect(vis(60)).toEqual([true, true, true])
    expect(vis(30)).toEqual([true, true, true])
  })
})

describe('labelGeometry：分级阈值可调（SPEC §6.4 阈值常量可调）', () => {
  it('自定义阈值表生效，等级维度 = LABEL_LEVEL_COUNT', () => {
    expect(LABEL_LEVEL_COUNT).toBe(3)
    const custom: LabelVisibilityThresholds = {
      perspectiveMaxDistance: [100, 50, 50],
      orthoMaxViewWidth: [Number.POSITIVE_INFINITY, 200, 80],
    }
    expect(
      resolveLabelVisibility({ mode: 'perspective', cameraDistance: 90 }, custom),
    ).toEqual([true, false, false])
    expect(
      resolveLabelVisibility({ mode: 'perspective', cameraDistance: 40 }, custom),
    ).toEqual([true, true, true])
    expect(resolveLabelVisibility({ mode: 'orthographic', viewWidth: 180 }, custom)).toEqual([
      true,
      true,
      false,
    ])
  })
})

// ---------------------------------------------------------------------------
// quad 排版（纯函数）
// ---------------------------------------------------------------------------

describe('labelGeometry：layoutLabelQuads 单行排版', () => {
  it('逐字符一个 quad，宽度 = aspect × 字高，整行相对锚点水平居中', () => {
    const quads = layoutLabelQuads('中K', makeSource({ 中: 1, K: 0.5 }), 1.0)
    expect(quads).toHaveLength(2)
    // 总宽 1.5：'中' 中心 -0.75 + 0.5 = -0.25；'K' 中心 -0.75 + 1.0 + 0.25 = 0.5
    expect(quads[0].offsetX).toBeCloseTo(-0.25, 6)
    expect(quads[0].width).toBeCloseTo(1.0, 6)
    expect(quads[0].height).toBeCloseTo(1.0, 6)
    expect(quads[1].offsetX).toBeCloseTo(0.5, 6)
    expect(quads[1].width).toBeCloseTo(0.5, 6)
    // 左右对称：首 quad 左缘 = -总宽/2，末 quad 右缘 = +总宽/2
    expect(quads[0].offsetX - quads[0].width / 2).toBeCloseTo(-0.75, 6)
    expect(quads[1].offsetX + quads[1].width / 2).toBeCloseTo(0.75, 6)
  })

  it('UV 透传字形表；缺字字符跳过、不阻断其余字符', () => {
    const quads = layoutLabelQuads('门X桩', makeSource({ 门: 1, 桩: 1 }), 2.0)
    expect(quads).toHaveLength(2)
    expect(quads[0].u0).toBeCloseTo(0.1, 6)
    expect(quads[0].v0).toBeCloseTo(0.2, 6)
    expect(quads[0].u1).toBeCloseTo(0.3, 6)
    expect(quads[0].v1).toBeCloseTo(0.4, 6)
    // 缺字 'X' 不占宽度：总宽 = 2 × 2.0 = 4
    expect(quads[0].offsetX).toBeCloseTo(-1.0, 6)
    expect(quads[1].offsetX).toBeCloseTo(1.0, 6)
  })

  it('空文本 / 全部缺字返回空数组', () => {
    expect(layoutLabelQuads('', makeSource({ 中: 1 }), 1.0)).toEqual([])
    expect(layoutLabelQuads('XYZ', makeSource({ 中: 1 }), 1.0)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 节点标签锚点（世界坐标经 coordinates.ts 统一转换）
// ---------------------------------------------------------------------------

describe('labelGeometry：buildNodeLabelAnchors（SPEC §4.3 / §6.4）', () => {
  it('世界坐标 = mapToWorld 输出 + 锚点高度；elevator 与空白名跳过', () => {
    const calibration: Calibration = { scale: 1, rotationRad: 0, offsetX: 5, offsetY: -3 }
    const nodes = [
      makeNode('work', '站点1', 12.5, -7.25),
      makeNode('elevator', '电梯', 0, 0),
      makeNode('node', '   ', 1, 1),
      makeNode('charge', '门口充电桩1', 2, 3),
    ]
    const anchors = buildNodeLabelAnchors(nodes, calibration, LABEL_ANCHOR_HEIGHT)
    expect(anchors).toHaveLength(2)
    const world = mapToWorld({ x: 12.5, y: -7.25 }, calibration)
    expect(anchors[0].x).toBeCloseTo(world.x, 6)
    expect(anchors[0].y).toBe(LABEL_ANCHOR_HEIGHT)
    expect(anchors[0].z).toBeCloseTo(world.z, 6)
    expect(anchors[0].level).toBe(0)
    expect(anchors[1].text).toBe('门口充电桩1')
    expect(anchors[1].level).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 合并标签几何批（单 draw call 结构 + 强制显示接口）
// ---------------------------------------------------------------------------

describe('labelGeometry：buildLabelBatch 合并几何（SPEC §6.4 批渲染）', () => {
  const source = makeSource({ 门: 1, 口: 1, 充: 1, 电: 1, 桩: 1, '1': 0.5, K: 0.6 })
  const anchors: LabelAnchor[] = [
    { id: 'a', text: '门口充电桩1', level: 0, x: 1, y: 0.8, z: -2 },
    { id: 'b', text: 'K1', level: 2, x: -3, y: 0.8, z: 4 },
  ]

  it('全部标签合并为单个 BufferGeometry：顶点 = quad × 4，索引 = quad × 6', () => {
    const batch = buildLabelBatch(anchors, source, 1.0)
    expect(batch.labelCount).toBe(2)
    expect(batch.quadCount).toBe(8) // 6 + 2 个字符
    const position = batch.geometry.getAttribute('position')
    expect(position.count).toBe(32)
    expect(batch.geometry.getAttribute('aOffset').count).toBe(32)
    expect(batch.geometry.getAttribute('uv').count).toBe(32)
    expect(batch.geometry.getAttribute('aLevel').count).toBe(32)
    expect(batch.geometry.getAttribute('aForceVisible').count).toBe(32)
    expect(batch.geometry.getIndex()?.count).toBe(48)
    batch.dispose()
  })

  it('每顶点 position = 锚点世界坐标，aLevel = 标签等级', () => {
    const batch = buildLabelBatch(anchors, source, 1.0)
    const position = batch.geometry.getAttribute('position')
    const levels = batch.geometry.getAttribute('aLevel')
    // 标签 a 的 6 字符 × 4 顶点
    for (let i = 0; i < 24; i++) {
      expect(position.getX(i)).toBeCloseTo(1, 6)
      expect(position.getY(i)).toBeCloseTo(0.8, 6)
      expect(position.getZ(i)).toBeCloseTo(-2, 6)
      expect(levels.getX(i)).toBe(0)
    }
    for (let i = 24; i < 32; i++) {
      expect(position.getX(i)).toBeCloseTo(-3, 6)
      expect(position.getZ(i)).toBeCloseTo(4, 6)
      expect(levels.getX(i)).toBe(2)
    }
    batch.dispose()
  })

  it('aOffset 四角 = quad 中心 ± 半宽/半高，uv 四角与角点对应', () => {
    const batch = buildLabelBatch([anchors[1]], source, 2.0)
    const offsets = batch.geometry.getAttribute('aOffset')
    const uvs = batch.geometry.getAttribute('uv')
    // 'K'：宽 0.6×2=1.2，总宽 (0.6+0.5)×2=2.2，中心 = -1.1 + 0.6 = -0.5
    const expectedX = [-1.1, 0.1, 0.1, -1.1]
    const expectedY = [-1, -1, 1, 1]
    const expectedU = [0.1, 0.3, 0.3, 0.1]
    const expectedV = [0.2, 0.2, 0.4, 0.4]
    for (let corner = 0; corner < 4; corner++) {
      expect(offsets.getX(corner)).toBeCloseTo(expectedX[corner], 5)
      expect(offsets.getY(corner)).toBeCloseTo(expectedY[corner], 5)
      expect(uvs.getX(corner)).toBeCloseTo(expectedU[corner], 6)
      expect(uvs.getY(corner)).toBeCloseTo(expectedV[corner], 6)
    }
    batch.dispose()
  })

  it('空锚点 / 全部缺字：合法空几何（0 顶点 0 索引）', () => {
    const empty = buildLabelBatch([], source, 1.0)
    expect(empty.quadCount).toBe(0)
    expect(empty.geometry.getAttribute('position').count).toBe(0)
    expect(empty.geometry.getIndex()?.count).toBe(0)
    expect(empty.setForceVisible('a', true)).toBe(false)
    empty.dispose()

    const noGlyph = buildLabelBatch([{ id: 'x', text: '无字', level: 0, x: 0, y: 0, z: 0 }], source, 1)
    expect(noGlyph.quadCount).toBe(0)
    expect(noGlyph.labelCount).toBe(0)
    noGlyph.dispose()
  })

  it('强制显示接口：按 id 写 aForceVisible 区间并标记更新；未知 id 返回 false', () => {
    const batch = buildLabelBatch(anchors, source, 1.0)
    const force = batch.geometry.getAttribute('aForceVisible') as BufferAttribute
    expect(force.version).toBe(0)
    for (let i = 0; i < 32; i++) {
      expect(force.getX(i)).toBe(0)
    }

    expect(batch.setForceVisible('b', true)).toBe(true)
    expect(force.version).toBe(1)
    for (let i = 0; i < 24; i++) {
      expect(force.getX(i)).toBe(0)
    }
    for (let i = 24; i < 32; i++) {
      expect(force.getX(i)).toBe(1)
    }

    // 取消强制显示：区间回写 0
    expect(batch.setForceVisible('b', false)).toBe(true)
    expect(force.version).toBe(2)
    for (let i = 24; i < 32; i++) {
      expect(force.getX(i)).toBe(0)
    }
    expect(batch.setForceVisible('不存在', true)).toBe(false)
    batch.dispose()
  })
})

// ---------------------------------------------------------------------------
// 真实 map.json 集成（SPEC §4.1 / §6.4）
// ---------------------------------------------------------------------------

describe('labelGeometry：真实 map.json 集成（SPEC §4.1 / §6.4）', () => {
  it('1767 个节点生成标签锚点，等级分布 = 关键 400 / park 64 / node 1303，字符全覆盖成 quad', () => {
    const mapJsonPath = fileURLToPath(new URL('../../../../public/map.json', import.meta.url))
    const { map } = normalizeMapFromJson(readFileSync(mapJsonPath, 'utf8'))

    const anchors = buildNodeLabelAnchors(map.nodes, map.calibration, LABEL_ANCHOR_HEIGHT)
    expect(anchors).toHaveLength(1767)
    const byLevel = [0, 0, 0]
    for (const anchor of anchors) {
      byLevel[anchor.level] += 1
    }
    expect(byLevel).toEqual([389 + 11, 64, 1303])

    // 用真实字符集 + 真实图集布局构造字形源：验证每个名字字符都能取到字形（无缺字 quad 丢失）
    const chars = collectUniqueChars(map.nodes.map((node) => node.name))
    const layout = computeAtlasLayout(chars, LABEL_ATLAS_CELL_SIZE, LABEL_ATLAS_MAX_SIZE)
    expect(layout).not.toBeNull()
    const cellSize = LABEL_ATLAS_CELL_SIZE
    const size = layout?.size ?? 1
    const atlasSource: LabelGlyphSource = {
      getGlyph(char: string) {
        const cell = layout?.cells.get(char)
        if (cell === undefined) {
          return null
        }
        return {
          char,
          u0: (cell.column * cellSize) / size,
          u1: ((cell.column + 1) * cellSize) / size,
          v0: 1 - ((cell.row + 1) * cellSize) / size,
          v1: 1 - (cell.row * cellSize) / size,
          aspect: 1,
        }
      },
    }
    const batch = buildLabelBatch(anchors, atlasSource, 1.0)
    const expectedQuads = map.nodes.reduce((sum, node) => sum + [...node.name].length, 0)
    expect(batch.quadCount).toBe(expectedQuads)
    expect(batch.labelCount).toBe(1767)
    // 坐标抽查：锚点与 mapToWorld 一致（Float32Array 精度放宽）
    const nodeById = new Map(map.nodes.map((node) => [node.id, node]))
    for (const anchor of anchors.slice(0, 20)) {
      const node = nodeById.get(anchor.id)
      const world = mapToWorld({ x: node?.x ?? 0, y: node?.y ?? 0 }, map.calibration)
      expect(anchor.x).toBeCloseTo(world.x, 4)
      expect(anchor.z).toBeCloseTo(world.z, 4)
      expect(anchor.y).toBe(LABEL_ANCHOR_HEIGHT)
    }
    // 强制显示接口按真实节点 id 寻址
    expect(batch.setForceVisible(anchors[0].id, true)).toBe(true)
    expect(batch.setForceVisible('nonexistent', true)).toBe(false)
    batch.dispose()
  })
})
