/**
 * 文字图集（SPEC §6.4）：Canvas 绘制文字（支持中文，如"门口充电桩1"），
 * 同名字符合并、全部标签共用单张图集纹理，禁止每标签一张纹理。
 *
 * - 布局部分（collectUniqueChars / computeAtlasLayout / fitCharsToAtlas）为纯函数，可单测；
 * - 绘制部分（createLabelAtlas）依赖浏览器 Canvas，产出去重字符 → 图集 UV 的字形表
 *   与单张 CanvasTexture；标签批渲染（labelGeometry.ts）按字形表写 quad UV；
 * - 字符集可按需扩充：ensureTexts 登记缺失字符、syncTexture 一次性重建纹理
 *   （同帧多次登记只重建一次）；重建后字形 UV 变化，消费方需重建标签几何——
 *   调用方应在创建时一次性纳入全部预期文本（本模块机制由 TASK-010 AGV 编号标签复用）；
 * - 图集容量不足时按最大容量截断并 console 警告计数（SPEC §10 分级降级，不阻塞场景）。
 *
 * rendering 层可 import three 与 config，禁止 import infrastructure（SPEC §12）。
 */

import { CanvasTexture, SRGBColorSpace } from 'three'

// ---------------------------------------------------------------------------
// 字符收集与图集布局（纯函数）
// ---------------------------------------------------------------------------

/**
 * 收集全部文本中的去重字符（同名字符合并，SPEC §6.4）。
 * 按码点迭代（for-of，代理对安全）；返回顺序为字符首次出现顺序（确定性输出）。
 */
export function collectUniqueChars(texts: readonly string[]): string[] {
  const seen = new Set<string>()
  const chars: string[] = []
  for (const text of texts) {
    for (const char of text) {
      if (!seen.has(char)) {
        seen.add(char)
        chars.push(char)
      }
    }
  }
  return chars
}

/** 单个字符在图集中的网格位置 */
export interface AtlasCell {
  column: number
  row: number
}

/** 图集布局：等边网格排列，纹理边长为能容纳全部字符的最小 2 的幂 */
export interface AtlasLayout {
  /** 纹理边长（像素，2 的幂，≥ cellSize） */
  size: number
  /** 每行单元格数 */
  columns: number
  /** 行数 */
  rows: number
  /** 字符 → 网格位置（按输入字符顺序顺次填充） */
  cells: ReadonlyMap<string, AtlasCell>
}

/** 不小于 value 的最小 2 的幂 */
function nextPowerOfTwo(value: number): number {
  let size = 1
  while (size < value) {
    size *= 2
  }
  return size
}

/**
 * 计算图集布局：从能容纳单元格的最小 2 幂边长起逐级放大，
 * 取首个能容纳全部字符的边长；maxSize 仍装不下返回 null。
 * 空字符集返回 columns / rows 为 0 的最小布局。
 */
export function computeAtlasLayout(
  chars: readonly string[],
  cellSize: number,
  maxSize: number,
): AtlasLayout | null {
  const minSize = nextPowerOfTwo(cellSize)
  if (chars.length === 0) {
    return { size: minSize, columns: 0, rows: 0, cells: new Map() }
  }
  for (let size = minSize; size <= maxSize; size *= 2) {
    const columns = Math.floor(size / cellSize)
    const rows = Math.ceil(chars.length / columns)
    if (rows * cellSize <= size) {
      const cells = new Map<string, AtlasCell>()
      for (let i = 0; i < chars.length; i++) {
        cells.set(chars[i], { column: i % columns, row: Math.floor(i / columns) })
      }
      return { size, columns, rows, cells }
    }
  }
  return null
}

/** 图集容量装配结果（布局必然非空：超出 maxSize 容量时按容量截断） */
export interface AtlasFit {
  /** 实际入图集的字符（容量不足时为输入的前 capacity 个） */
  fitted: string[]
  layout: AtlasLayout
  /** 被截断丢弃的字符数（0 = 全部装下） */
  droppedCount: number
}

/**
 * 把字符集装配进图集：优先完整布局；超容量时按 maxSize 网格容量截断
 * （capacity = floor(maxSize / cellSize)²，恰满必然可布局），由调用方警告计数。
 */
export function fitCharsToAtlas(
  chars: readonly string[],
  cellSize: number,
  maxSize: number,
): AtlasFit {
  const layout = computeAtlasLayout(chars, cellSize, maxSize)
  if (layout !== null) {
    return { fitted: [...chars], layout, droppedCount: 0 }
  }
  const cellsPerSide = Math.floor(maxSize / cellSize)
  const capacity = cellsPerSide * cellsPerSide
  const fitted = chars.slice(0, capacity)
  const truncatedLayout = computeAtlasLayout(fitted, cellSize, maxSize)
  if (truncatedLayout === null) {
    // capacity 由 floor(maxSize / cellSize)² 导出，必然可布局；此处仅为类型守卫
    throw new Error('图集容量参数非法：maxSize 必须 ≥ cellSize')
  }
  return { fitted, layout: truncatedLayout, droppedCount: chars.length - fitted.length }
}

// ---------------------------------------------------------------------------
// Canvas 图集（浏览器环境）
// ---------------------------------------------------------------------------

/** 单个字符的图集字形（供标签 quad 写 UV 与宽度） */
export interface AtlasGlyph {
  char: string
  /** 图集 UV（已按 CanvasTexture flipY 换算：v0 底 / v1 顶，v0 < v1） */
  u0: number
  v0: number
  u1: number
  v1: number
  /** 字形宽高比（测量宽 / 绘制字号）：quad 宽 = aspect × 世界字高 */
  aspect: number
}

/** 图集绘制参数（值取自 config/constants.ts 与 config/theme.ts，由场景层注入） */
export interface LabelAtlasOptions {
  /** 单元格边长（像素） */
  cellSize: number
  /** 格内绘制字号（像素） */
  fontSize: number
  /** 字体族（需覆盖中文） */
  fontFamily: string
  /** 文字颜色 */
  textColor: string
  /** 纹理边长上限（像素，2 的幂） */
  maxSize: number
}

/**
 * 文字图集句柄：单张 CanvasTexture + 字形表。
 * 机制对节点标签与 AGV 编号标签通用（TASK-010 复用，SPEC §7.3）。
 */
export interface LabelAtlas {
  /** 单张图集纹理（全部标签共用） */
  readonly texture: CanvasTexture
  /** 已入图集的字符数 */
  readonly charCount: number
  /** 因容量不足被截断的字符数（SPEC §10 计数） */
  readonly droppedCharCount: number
  /** 查字符字形；未入图集返回 null */
  getGlyph(char: string): AtlasGlyph | null
  /**
   * 登记文本所需字符：新字符进入待重建集合（同帧多次登记合并）；
   * 已在图集的字符无操作。
   */
  ensureTexts(texts: readonly string[]): void
  /**
   * 若存在待重建字符则一次性重建纹理与字形表（幂等，每帧至多调用一次）；
   * 返回 true 表示发生了重建——字形 UV 已变化，消费方须重建标签几何。
   */
  syncTexture(): boolean
  dispose(): void
}

/**
 * 创建文字图集：一次性纳入 texts 的全部去重字符并同步绘制。
 * 调用方应尽量把未来文本（如全部 AGV 编号）一并纳入，避免运行时重建。
 */
export function createLabelAtlas(
  texts: readonly string[],
  options: LabelAtlasOptions,
): LabelAtlas {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (context === null) {
    throw new Error('无法创建 2D Canvas 上下文绘制文字图集')
  }
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace

  // 已入图集字符（保持登记顺序，重建时旧字符在前、新字符在后，输出确定）
  let knownChars: string[] = []
  const knownSet = new Set<string>()
  let pendingChars: string[] = []
  const pendingSet = new Set<string>()
  let glyphs = new Map<string, AtlasGlyph>()
  let droppedCharCount = 0

  const redraw = (allChars: string[]): void => {
    const fit = fitCharsToAtlas(allChars, options.cellSize, options.maxSize)
    if (fit.droppedCount > 0) {
      console.warn(
        `文字图集容量不足：${fit.droppedCount} 个字符被截断（共 ${allChars.length} 个，` +
          `容量 ${Math.floor(options.maxSize / options.cellSize) ** 2}）`,
      )
    }
    droppedCharCount += fit.droppedCount
    const { layout } = fit
    canvas.width = layout.size
    canvas.height = layout.size
    context.clearRect(0, 0, layout.size, layout.size)
    context.fillStyle = options.textColor
    context.font = `${options.fontSize}px ${options.fontFamily}`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    const nextGlyphs = new Map<string, AtlasGlyph>()
    for (const char of fit.fitted) {
      const cell = layout.cells.get(char)
      if (cell === undefined) {
        continue
      }
      const x = cell.column * options.cellSize
      const y = cell.row * options.cellSize
      const metrics = context.measureText(char)
      context.fillText(char, x + options.cellSize / 2, y + options.cellSize / 2)
      nextGlyphs.set(char, {
        char,
        u0: x / layout.size,
        u1: (x + options.cellSize) / layout.size,
        // CanvasTexture flipY：canvas 顶部（y 小）对应 UV 顶部（v 大）
        v0: 1 - (y + options.cellSize) / layout.size,
        v1: 1 - y / layout.size,
        aspect: metrics.width / options.fontSize,
      })
    }
    glyphs = nextGlyphs
    texture.needsUpdate = true
  }

  redraw(collectUniqueChars(texts))
  knownChars = collectUniqueChars(texts)
  for (const char of knownChars) {
    knownSet.add(char)
  }
  // 初始截断的字符不进入 knownSet（glyphs 中本就无其字形）

  return {
    texture,
    get charCount() {
      return glyphs.size
    },
    get droppedCharCount() {
      return droppedCharCount
    },
    getGlyph(char: string) {
      return glyphs.get(char) ?? null
    },
    ensureTexts(newTexts: readonly string[]) {
      for (const char of collectUniqueChars(newTexts)) {
        if (!knownSet.has(char) && !pendingSet.has(char)) {
          pendingSet.add(char)
          pendingChars.push(char)
        }
      }
    },
    syncTexture() {
      if (pendingChars.length === 0) {
        return false
      }
      const allChars = [...knownChars, ...pendingChars]
      redraw(allChars)
      knownChars = allChars
      for (const char of pendingChars) {
        knownSet.add(char)
      }
      pendingChars = []
      pendingSet.clear()
      return true
    },
    dispose() {
      texture.dispose()
    },
  }
}
