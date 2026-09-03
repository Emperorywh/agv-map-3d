/**
 * 地图专属 WebGL 名称资源（SPEC §2.3、§5.1、§7.2；TASK-005）。
 *
 * 职责：
 * 1. collectMapNameLabels：从只读 MapModel 收集全部需要绘制的名称条目
 *    （停车符号字形；独占区分组名称与仓库节点名称已分别随图层移除与 P0-5
 *    移除），供图集一次性栅格化；
 * 2. layoutNameAtlas：纯函数货架式排布——按测量的文字宽度把条目装箱进
 *    固定宽度的图集画布，产出每个条目的像素矩形与归一化 UV 矩形；容量不足
 *    时丢弃放不下的条目（逐项隔离）而不是崩溃；
 * 3. createMapNameAtlas：真实 Canvas 2D 工厂——测量、排布、绘制（描边 + 填充，
 *    中文可用）并包装为 THREE.CanvasTexture；
 * 4. buildNameQuadGeometry：把「世界锚点 + 图集矩形」烘焙为平贴地面的静态
 *    合批四边形 BufferGeometry（一个 Mesh 渲染全部名称 = 一个 Draw Call）。
 * 边界：本模块是地图名称的唯一栅格化入口；不使用 DOM/drei Html/每名称独立
 *       材质或纹理；车辆标签属 fleet-monitoring 的 labelAtlas（TASK-011），
 *       两者互不共享图集。不发起请求、不进 React。
 * 关键不变量：
 * 1. 图集纹理与几何由创建方显式释放（dispose 幂等），共享静态资源遵守
 *    「单一所有者」：图集由 MapVisualizationFeature 持有，图层只消费；
 * 2. 布局是纯函数：同一批条目与测量输入得到逐字节相同的矩形排布，测试可以
 *    用注入测量器在无 Canvas 环境下完全复现真实工厂的排布结果；
 * 3. 单元矩形以「key → cell」映射，未放进图集的 key 不产生四边形顶点——
 *    名称缺失只表现为该名称不可见，绝不悬空引用 UV 区域；
 * 4. 画布坐标 y 向下、纹理坐标 v 向上：cell 的 v0/v1 已按画布高度翻转，
 *    消费方必须使用 cell 的 UV 字段而不是自行换算像素矩形。
 */
import * as THREE from 'three'
import { StructuredError } from '@/shared/diagnostics'
import type { MapModel } from '../model/types'
import {
  MAP_NAME_CANVAS_MAX_HEIGHT,
  MAP_NAME_CANVAS_WIDTH,
  MAP_NAME_FONT_FAMILY,
  MAP_NAME_FONT_PX,
  MAP_NAME_PADDING_PX,
  NAME_STROKE_COLOR,
  PARK_GLYPH_COLOR,
} from './mapAppearance'

/** 一条待栅格化的名称：key 唯一锚定消费方（节点/分组/停车符号） */
export interface MapNameLabelSpec {
  /** 消费方主键：'node:<节点id>' / 'group:<分组id>' / '__park_glyph__' */
  readonly key: string
  readonly text: string
  /** 文字填充色（CSS 颜色字符串） */
  readonly color: string
}

/** 图集单元矩形：像素矩形（画布坐标，y 向下）与归一化 UV 矩形（v 向上） */
export interface MapNameCell {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly u0: number
  readonly v0: number
  readonly u1: number
  readonly v1: number
}

/** 图集排布结果：全部单元、画布尺寸（2 的幂高）与被隔离丢弃的条目 */
export interface MapNameAtlasLayout {
  readonly cells: ReadonlyMap<string, MapNameCell>
  readonly width: number
  readonly height: number
  readonly fontPx: number
  /** 因图集容量不足被丢弃的条目 key（逐项隔离，不阻断其余名称） */
  readonly droppedKeys: readonly string[]
}

/** 文字宽度测量器：与图集字体对应的像素宽度（工厂用 Canvas measureText） */
export type NameTextMeasurer = (text: string) => number

export interface LayoutNameAtlasOptions {
  readonly fontPx: number
  readonly paddingPx: number
  readonly canvasWidth: number
  /** 画布高度上限（2 的幂）；超出即丢弃剩余条目 */
  readonly maxHeight: number
  readonly measure: NameTextMeasurer
}

/**
 * 货架式排布：条目按输入顺序放入当前行，行满换行；行高 = fontPx + 2×padding。
 * 画布高度取「已用高度」之上最小的 2 的幂（mipmap 友好、节省显存），受
 * maxHeight 约束：换行后仍放不下的条目被丢弃隔离（不崩溃、不阻断其余名称）。
 */
export function layoutNameAtlas(
  specs: readonly MapNameLabelSpec[],
  options: LayoutNameAtlasOptions,
): MapNameAtlasLayout {
  const { fontPx, paddingPx, canvasWidth, maxHeight, measure } = options
  const rowHeight = fontPx + paddingPx * 2
  const droppedKeys: string[] = []

  // 第一遍：纯像素排布，确定每个单元的像素矩形与画布最终高度
  interface PixelPlacement {
    spec: MapNameLabelSpec
    x: number
    y: number
    w: number
    h: number
  }
  const placements: PixelPlacement[] = []
  let cursorX = paddingPx
  let cursorY = 0
  for (const spec of specs) {
    const textWidth = Math.max(1, Math.ceil(measure(spec.text)))
    const cellWidth = textWidth + paddingPx * 2
    // 行尾放不下：换行；换行后仍超高的条目只能丢弃隔离
    if (cursorX + cellWidth + paddingPx > canvasWidth) {
      cursorX = paddingPx
      cursorY += rowHeight
    }
    if (cursorY + rowHeight > maxHeight) {
      droppedKeys.push(spec.key)
      continue
    }
    placements.push({ spec, x: cursorX, y: cursorY, w: cellWidth, h: rowHeight })
    cursorX += cellWidth
  }

  // 画布高度：已用高度之上最小的 2 的幂（下限 64 保证纹理合法、上限 maxHeight）
  const usedHeight = Math.max(cursorY + rowHeight, 64)
  let canvasHeight = 64
  while (canvasHeight < usedHeight && canvasHeight < maxHeight) {
    canvasHeight *= 2
  }
  canvasHeight = Math.min(canvasHeight, maxHeight)

  // 第二遍：用最终画布高度产出归一化 UV（画布 y 向下 → 纹理 v 向上）
  const cells = new Map<string, MapNameCell>()
  for (const placement of placements) {
    cells.set(placement.spec.key, {
      x: placement.x,
      y: placement.y,
      w: placement.w,
      h: placement.h,
      u0: placement.x / canvasWidth,
      u1: (placement.x + placement.w) / canvasWidth,
      v0: 1 - (placement.y + placement.h) / canvasHeight,
      v1: 1 - placement.y / canvasHeight,
    })
  }

  return {
    cells,
    width: canvasWidth,
    height: canvasHeight,
    fontPx,
    droppedKeys: Object.freeze(droppedKeys),
  }
}

/** 停车符号在图集中的固定 key（紫色停车方垫之上的白色 P 字形） */
export const PARK_GLYPH_KEY = '__park_glyph__'

/**
 * 从 MapModel 收集全部地图名称条目：停车符号字形（白色 P，仅存在 park 节点
 * 时加入）。独占区分组名称已随独占区图层整体移除；视觉差距分析 P0-5：仓库
 * 节点名称不再收集（Reference 中不存在仓库名称文字）。
 * 顺序稳定，保证同一地图得到同一图集排布。
 */
export function collectMapNameLabels(mapModel: MapModel): MapNameLabelSpec[] {
  const specs: MapNameLabelSpec[] = []
  const hasPark = mapModel.nodeList.some((node) => node.category === 'park')
  if (hasPark) {
    specs.push({ key: PARK_GLYPH_KEY, text: 'P', color: PARK_GLYPH_COLOR })
  }
  return specs
}

/** 已构建的名称图集（纹理 + 单元映射）；纹理由本对象拥有并释放 */
export interface MapNameAtlas {
  readonly texture: THREE.Texture
  readonly cells: ReadonlyMap<string, MapNameCell>
  readonly width: number
  readonly height: number
  readonly fontPx: number
  /** 被隔离丢弃的条目 key（逐项隔离） */
  readonly droppedKeys: readonly string[]
  /** 释放图集纹理；幂等 */
  dispose(): void
}

export interface CreateMapNameAtlasOptions {
  readonly fontPx?: number
  readonly paddingPx?: number
  readonly canvasWidth?: number
  readonly maxHeight?: number
}

/**
 * 真实图集工厂：Canvas 2D 测量 → 排布 → 绘制 → CanvasTexture。
 * 环境无 2D 上下文（如测试 jsdom）时抛出稳定错误码 MAP_NAME_ATLAS_UNAVAILABLE，
 * 由调用方降级为无名称图层并记录诊断，不阻断地图其余内容。
 */
export function createMapNameAtlas(
  specs: readonly MapNameLabelSpec[],
  options: CreateMapNameAtlasOptions = {},
): MapNameAtlas {
  const fontPx = options.fontPx ?? MAP_NAME_FONT_PX
  const paddingPx = options.paddingPx ?? MAP_NAME_PADDING_PX
  const canvasWidth = options.canvasWidth ?? MAP_NAME_CANVAS_WIDTH
  const maxHeight = options.maxHeight ?? MAP_NAME_CANVAS_MAX_HEIGHT

  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (context === null) {
    throw new StructuredError({
      code: 'MAP_NAME_ATLAS_UNAVAILABLE',
      message: '当前环境无 Canvas 2D 上下文，地图名称图层降级为不显示名称',
      context: { canvasWidth, maxHeight },
    })
  }
  const font = `600 ${fontPx}px ${MAP_NAME_FONT_FAMILY}`
  context.font = font
  const layout = layoutNameAtlas(specs, {
    fontPx,
    paddingPx,
    canvasWidth,
    maxHeight,
    measure: (text) => context.measureText(text).width,
  })

  // 先定尺寸再绘制：设置画布尺寸会重置上下文状态，字体必须重新设置
  canvas.width = layout.width
  canvas.height = layout.height
  context.font = font
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  for (const spec of specs) {
    const cell = layout.cells.get(spec.key)
    if (cell === undefined) {
      continue
    }
    const centerX = cell.x + cell.w / 2
    const centerY = cell.y + cell.h / 2
    // 深色描边 + 彩色填充：保证任意底图上的可读性
    context.lineWidth = 3
    context.strokeStyle = NAME_STROKE_COLOR
    context.strokeText(spec.text, centerX, centerY)
    context.fillStyle = spec.color
    context.fillText(spec.text, centerX, centerY)
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.anisotropy = 4
  texture.generateMipmaps = true

  let disposed = false
  return {
    texture,
    cells: layout.cells,
    width: layout.width,
    height: layout.height,
    fontPx: layout.fontPx,
    droppedKeys: layout.droppedKeys,
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      texture.dispose()
    },
  }
}

/** 名称四边形输入：世界锚点（平贴地面）+ 图集单元 + 世界高度 */
export interface NameQuadInput {
  readonly x: number
  readonly z: number
  /** cell 的 u0/u1/v0/v1 已是 0..1 归一化 UV，直接写入几何 */
  readonly cell: MapNameCell
  /** 四边形世界高度（米）；宽度 = 单元宽高比 × 高度 */
  readonly heightM: number
}

/**
 * 把名称四边形烘焙为单个静态合批 BufferGeometry：全部顶点直接位于世界坐标
 * （几何挂载在原点、无变换），文字顶边朝 -z（自 +z 侧观察为正读方向）。
 * y 为四边形的世界高度（来自 mapAppearance 阶梯的 NAME_QUAD_Y）。
 * 消费方负责在卸载时 dispose 本几何。
 */
export function buildNameQuadGeometry(
  inputs: readonly NameQuadInput[],
  y: number,
): THREE.BufferGeometry {
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  for (const input of inputs) {
    const widthM = (input.cell.w / input.cell.h) * input.heightM
    const halfW = widthM / 2
    const halfH = input.heightM / 2
    const base = positions.length / 3
    // 顶点序：左上、右上、右下、左下（俯视，文字顶边朝 -z）
    positions.push(
      input.x - halfW,
      y,
      input.z - halfH,
      input.x + halfW,
      y,
      input.z - halfH,
      input.x + halfW,
      y,
      input.z + halfH,
      input.x - halfW,
      y,
      input.z + halfH,
    )
    uvs.push(
      input.cell.u0,
      input.cell.v1,
      input.cell.u1,
      input.cell.v1,
      input.cell.u1,
      input.cell.v0,
      input.cell.u0,
      input.cell.v0,
    )
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}
