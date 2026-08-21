/**
 * 标签批渲染几何（SPEC §6.4）：全部标签合并为**单个** BufferGeometry
 * （每字符一个 quad，共享图集纹理与 UV），配合 billboard shader 单 draw call 渲染，
 * 禁止每标签一个 Sprite（§9 性能预算）。
 *
 * - 分级：标签按等级 0 关键（work/charge）/ 1（park）/ 2（node）写入 aLevel 顶点属性；
 *   透视按相机距离、正交俯视按视野宽度的分级判定收敛于纯函数 resolveLabelVisibility，
 *   场景层每帧把结果写入 shader uniform，GPU 裁剪不可见等级（CPU 零遍历）；
 * - 强制显示：setForceVisible(id, true) 写 aForceVisible 顶点属性，shader 跳过分级——
 *   hover / 选中交互（TASK-013）经此接口接入（SPEC §6.4 / §8.2）；
 * - billboard：顶点 position 存标签锚点（世界坐标）、aOffset 存 quad 角点相对锚点偏移，
 *   朝向相机的展开在场景层材质 shader 中完成（见 MapLayer），几何本身与相机无关；
 * - 机制对 AGV 编号标签通用（TASK-010 复用）：锚点直接接受世界坐标，与节点无关。
 *
 * rendering 层可 import three 与 config，禁止 import infrastructure（SPEC §12）；
 * 世界坐标转换只经 domain/coordinates.ts（z 取反唯一收口，SPEC §4.3）。
 */

import { BufferAttribute, BufferGeometry } from 'three'

import { mapToWorld } from '../../../domain/coordinates'
import type { Calibration, NodeKind, NormalizedNode } from '../../../domain/types'
import type { AtlasGlyph } from './labelAtlas'

// ---------------------------------------------------------------------------
// 标签等级与距离/视野分级（纯函数）
// ---------------------------------------------------------------------------

/** 标签等级（SPEC §6.4 分级顺序：关键 → park → 其他） */
export type LabelLevel = 0 | 1 | 2
/** 关键标签（work / charge） */
export const LABEL_LEVEL_KEY: LabelLevel = 0
/** park 标签 */
export const LABEL_LEVEL_PARK: LabelLevel = 1
/** 普通导航点等其他标签 */
export const LABEL_LEVEL_NAV: LabelLevel = 2
/** 等级总数（阈值表 / shader uniform 维度） */
export const LABEL_LEVEL_COUNT = 3

/** 节点类型 → 标签等级；elevator 本期不渲染标签（SPEC §6.3），返回 null */
export function nodeKindToLabelLevel(kind: NodeKind): LabelLevel | null {
  switch (kind) {
    case 'work':
    case 'charge':
      return LABEL_LEVEL_KEY
    case 'park':
      return LABEL_LEVEL_PARK
    case 'node':
      return LABEL_LEVEL_NAV
    case 'elevator':
      return null
  }
}

/** 分级阈值（值取自 config/constants.ts，由场景层注入；均为可调常量） */
export interface LabelVisibilityThresholds {
  /** 透视模式：各等级最大可见相机距离（米），超过隐藏（> 阈值隐藏，≤ 可见） */
  perspectiveMaxDistance: readonly [number, number, number]
  /** 正交俯视：各等级最大可见视野宽度（米）；Infinity = 不限宽（全图关键标签恒可读） */
  orthoMaxViewWidth: readonly [number, number, number]
}

/** 分级判定的相机视图参数：透视给相机距离，正交给视野宽度 */
export type LabelCameraView =
  | { mode: 'perspective'; cameraDistance: number }
  | { mode: 'orthographic'; viewWidth: number }

/**
 * 分级判定（SPEC §6.4）：
 * - 透视：> 80m 全部隐藏、20~80m 仅 work/charge、≤ 20m 全部（阈值可调）；
 * - 正交俯视：视野 > 160m 仅 work/charge、60~160m 加 park、≤ 60m 全部（阈值可调）。
 * 返回各等级可见性（索引 = 等级），与 shouldHideNavNodes 同口径：超过阈值隐藏。
 */
export function resolveLabelVisibility(
  view: LabelCameraView,
  thresholds: LabelVisibilityThresholds,
): readonly [boolean, boolean, boolean] {
  if (view.mode === 'perspective') {
    const [key, park, nav] = thresholds.perspectiveMaxDistance
    return [
      view.cameraDistance <= key,
      view.cameraDistance <= park,
      view.cameraDistance <= nav,
    ]
  }
  const [key, park, nav] = thresholds.orthoMaxViewWidth
  return [view.viewWidth <= key, view.viewWidth <= park, view.viewWidth <= nav]
}

// ---------------------------------------------------------------------------
// 标签 quad 排版（纯函数）
// ---------------------------------------------------------------------------

/** 单字符 quad 排版结果（billboard 平面内，相对标签锚点） */
export interface LabelQuadSpec {
  /** quad 中心相对锚点的偏移（米）：x 沿标签行、y 竖直（恒 0，锚点为标签中心） */
  offsetX: number
  offsetY: number
  /** quad 宽 / 高（米，高恒为世界字高） */
  width: number
  height: number
  /** 图集 UV */
  u0: number
  v0: number
  u1: number
  v1: number
}

/** 字形查询来源（LabelAtlas 或测试替身） */
export interface LabelGlyphSource {
  getGlyph(char: string): AtlasGlyph | null
}

/**
 * 单行排版：逐字符取字形，宽度 = aspect × 世界字高，整行相对锚点水平居中；
 * 无字形的字符跳过（图集缺字不阻断其余字符）；空文本 / 全部缺字返回空数组。
 */
export function layoutLabelQuads(
  text: string,
  source: LabelGlyphSource,
  fontWorldHeight: number,
): LabelQuadSpec[] {
  const glyphs: AtlasGlyph[] = []
  for (const char of text) {
    const glyph = source.getGlyph(char)
    if (glyph !== null) {
      glyphs.push(glyph)
    }
  }
  let totalWidth = 0
  for (const glyph of glyphs) {
    totalWidth += glyph.aspect * fontWorldHeight
  }
  let cursor = -totalWidth / 2
  const quads: LabelQuadSpec[] = []
  for (const glyph of glyphs) {
    const width = glyph.aspect * fontWorldHeight
    quads.push({
      offsetX: cursor + width / 2,
      offsetY: 0,
      width,
      height: fontWorldHeight,
      u0: glyph.u0,
      v0: glyph.v0,
      u1: glyph.u1,
      v1: glyph.v1,
    })
    cursor += width
  }
  return quads
}

// ---------------------------------------------------------------------------
// 标签锚点（世界坐标转换收口于 domain/coordinates.ts）
// ---------------------------------------------------------------------------

/** 单个标签的批渲染输入（机制与节点无关，AGV 编号标签同用） */
export interface LabelAnchor {
  /** 标签所属对象 id（节点 id / AGV id），强制显示接口按 id 寻址，须唯一 */
  id: string
  text: string
  level: LabelLevel
  /** 世界坐标锚点（标签 quad 中心） */
  x: number
  y: number
  z: number
}

/**
 * 由规范化节点构建标签锚点：elevator 与空白名跳过；
 * 世界坐标经 mapToWorld 统一转换（本模块不做任何手写 z 取反，SPEC §4.3）。
 */
export function buildNodeLabelAnchors(
  nodes: readonly NormalizedNode[],
  calibration: Calibration,
  anchorHeight: number,
): LabelAnchor[] {
  const anchors: LabelAnchor[] = []
  for (const node of nodes) {
    const level = nodeKindToLabelLevel(node.kind)
    if (level === null || node.name.trim() === '') {
      continue
    }
    const world = mapToWorld({ x: node.x, y: node.y }, calibration)
    anchors.push({
      id: node.id,
      text: node.name,
      level,
      x: world.x,
      y: anchorHeight,
      z: world.z,
    })
  }
  return anchors
}

// ---------------------------------------------------------------------------
// 合并标签几何批（单 draw call；强制显示接口）
// ---------------------------------------------------------------------------

/** 标签几何批：单 mesh 单 draw call 渲染全部标签 */
export interface LabelBatch {
  geometry: BufferGeometry
  /** 标签数（有 quad 输出的锚点数） */
  labelCount: number
  /** 字符 quad 总数（顶点数 = quadCount × 4，三角形数 = quadCount × 2） */
  quadCount: number
  /**
   * hover / 选中强制显示接口（SPEC §6.4 / §8.2，交互由 TASK-013 接入）：
   * 写入该标签全部顶点的 aForceVisible 属性并标记更新；id 不存在返回 false。
   */
  setForceVisible(id: string, force: boolean): boolean
  dispose(): void
}

/** quad 四角顺序（面向相机逆时针）：左下 → 右下 → 右上 → 左上 */
const CORNER_SIGNS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
]

/**
 * 构建合并标签几何：全部锚点的全部字符 quad 写入单个 BufferGeometry。
 * 顶点属性：position（锚点，vec3）、aOffset（角点偏移，vec2）、uv（图集 UV）、
 * aLevel（标签等级）、aForceVisible（强制显示，初始 0）。
 * id 重复的锚点以后者覆盖（消费方约定 id 唯一）。
 */
export function buildLabelBatch(
  anchors: readonly LabelAnchor[],
  source: LabelGlyphSource,
  fontWorldHeight: number,
): LabelBatch {
  const quadsPerAnchor = anchors.map((anchor) =>
    layoutLabelQuads(anchor.text, source, fontWorldHeight),
  )
  let quadCount = 0
  for (const quads of quadsPerAnchor) {
    quadCount += quads.length
  }

  const vertexCount = quadCount * 4
  const positions = new Float32Array(vertexCount * 3)
  const offsets = new Float32Array(vertexCount * 2)
  const uvs = new Float32Array(vertexCount * 2)
  const levels = new Float32Array(vertexCount)
  const forceVisible = new Float32Array(vertexCount)
  // 顶点数可能超过 65535（全图近万 quad），统一 32 位索引
  const indices = new Uint32Array(quadCount * 6)
  const ranges = new Map<string, { start: number; count: number }>()

  let labelCount = 0
  let quadCursor = 0
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i]
    const quads = quadsPerAnchor[i]
    if (quads.length > 0) {
      labelCount += 1
    }
    const vertexStart = quadCursor * 4
    for (const quad of quads) {
      for (let corner = 0; corner < 4; corner++) {
        const vertexIndex = quadCursor * 4 + corner
        positions[vertexIndex * 3] = anchor.x
        positions[vertexIndex * 3 + 1] = anchor.y
        positions[vertexIndex * 3 + 2] = anchor.z
        const [signX, signY] = CORNER_SIGNS[corner]
        offsets[vertexIndex * 2] = quad.offsetX + (signX * quad.width) / 2
        offsets[vertexIndex * 2 + 1] = quad.offsetY + (signY * quad.height) / 2
        uvs[vertexIndex * 2] = signX < 0 ? quad.u0 : quad.u1
        uvs[vertexIndex * 2 + 1] = signY < 0 ? quad.v0 : quad.v1
        levels[vertexIndex] = anchor.level
      }
      const indexBase = quadCursor * 6
      const vertexBase = quadCursor * 4
      indices[indexBase] = vertexBase
      indices[indexBase + 1] = vertexBase + 1
      indices[indexBase + 2] = vertexBase + 2
      indices[indexBase + 3] = vertexBase
      indices[indexBase + 4] = vertexBase + 2
      indices[indexBase + 5] = vertexBase + 3
      quadCursor += 1
    }
    if (quads.length > 0) {
      ranges.set(anchor.id, { start: vertexStart, count: quads.length * 4 })
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('aOffset', new BufferAttribute(offsets, 2))
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2))
  geometry.setAttribute('aLevel', new BufferAttribute(levels, 1))
  const forceAttribute = new BufferAttribute(forceVisible, 1)
  geometry.setAttribute('aForceVisible', forceAttribute)
  geometry.setIndex(new BufferAttribute(indices, 1))

  return {
    geometry,
    labelCount,
    quadCount,
    setForceVisible(id: string, force: boolean) {
      const range = ranges.get(id)
      if (range === undefined) {
        return false
      }
      forceAttribute.array.fill(force ? 1 : 0, range.start, range.start + range.count)
      forceAttribute.needsUpdate = true
      return true
    },
    dispose() {
      geometry.dispose()
    },
  }
}
