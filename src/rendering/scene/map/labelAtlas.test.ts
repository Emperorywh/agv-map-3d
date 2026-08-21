import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  LABEL_ATLAS_CELL_SIZE,
  LABEL_ATLAS_MAX_SIZE,
} from '../../../config/constants'
import { normalizeMapFromJson } from '../../../domain/normalize'
import {
  collectUniqueChars,
  computeAtlasLayout,
  fitCharsToAtlas,
} from './labelAtlas'

// ---------------------------------------------------------------------------
// 同名字符合并（SPEC §6.4）
// ---------------------------------------------------------------------------

describe('labelAtlas：同名字符合并 collectUniqueChars（SPEC §6.4）', () => {
  it('中英文混合文本按码点去重，保持首次出现顺序', () => {
    const chars = collectUniqueChars(['门口充电桩1', '门口充电桩2', '丝网充电桩1'])
    expect(chars).toEqual(['门', '口', '充', '电', '桩', '1', '2', '丝', '网'])
  })

  it('跨文本同名字符只出现一次（禁止每标签一张纹理的前提）', () => {
    const chars = collectUniqueChars(['ABC', 'BCA', 'AB'])
    expect(chars).toEqual(['A', 'B', 'C'])
  })

  it('空输入 / 空字符串返回空数组', () => {
    expect(collectUniqueChars([])).toEqual([])
    expect(collectUniqueChars(['', ''])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 图集布局（纯函数）
// ---------------------------------------------------------------------------

describe('labelAtlas：computeAtlasLayout 网格布局', () => {
  it('39 个字符 / 64px 格 → 最小 2 幂边长 512（8 列 × 5 行）', () => {
    const chars = Array.from({ length: 39 }, (_, i) => `c${i}`)
    const layout = computeAtlasLayout(chars, 64, 2048)
    expect(layout).not.toBeNull()
    expect(layout?.size).toBe(512)
    expect(layout?.columns).toBe(8)
    expect(layout?.rows).toBe(5)
    // 全部字符入格，格位不重叠且在网格范围内
    const occupied = new Set<string>()
    for (const char of chars) {
      const cell = layout?.cells.get(char)
      expect(cell).toBeDefined()
      expect(cell?.column).toBeLessThan(8)
      expect(cell?.row).toBeLessThan(5)
      const key = `${cell?.column},${cell?.row}`
      expect(occupied.has(key)).toBe(false)
      occupied.add(key)
    }
    expect(layout?.cells.size).toBe(39)
  })

  it('1 个字符取能容纳单元格的最小边长；0 字符返回空布局', () => {
    const single = computeAtlasLayout(['中'], 64, 2048)
    expect(single?.size).toBe(64)
    expect(single?.columns).toBe(1)
    expect(single?.rows).toBe(1)
    expect(single?.cells.get('中')).toEqual({ column: 0, row: 0 })

    const empty = computeAtlasLayout([], 64, 2048)
    expect(empty?.size).toBe(64)
    expect(empty?.columns).toBe(0)
    expect(empty?.rows).toBe(0)
    expect(empty?.cells.size).toBe(0)
  })

  it('恰好装满容量：4 字符 / 64px 格 / max 128 → 128（2 列 × 2 行）', () => {
    const layout = computeAtlasLayout(['a', 'b', 'c', 'd'], 64, 128)
    expect(layout?.size).toBe(128)
    expect(layout?.columns).toBe(2)
    expect(layout?.rows).toBe(2)
  })

  it('超出 maxSize 容量返回 null', () => {
    expect(computeAtlasLayout(['a', 'b', 'c', 'd', 'e'], 64, 128)).toBeNull()
  })
})

describe('labelAtlas：fitCharsToAtlas 容量装配', () => {
  it('容量充足时全部字符入集，droppedCount = 0', () => {
    const fit = fitCharsToAtlas(['门', '口', '桩'], 64, 2048)
    expect(fit.fitted).toEqual(['门', '口', '桩'])
    expect(fit.droppedCount).toBe(0)
    expect(fit.layout.cells.size).toBe(3)
  })

  it('容量不足时按容量截断并计数（SPEC §10 分级降级，不阻塞场景）', () => {
    const fit = fitCharsToAtlas(['a', 'b', 'c', 'd', 'e'], 64, 128)
    expect(fit.fitted).toEqual(['a', 'b', 'c', 'd'])
    expect(fit.droppedCount).toBe(1)
    expect(fit.layout.size).toBe(128)
    expect(fit.layout.cells.has('e')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 真实 map.json：字符集规模决定图集机制单纹理可行（SPEC §4.1 / §6.4）
// ---------------------------------------------------------------------------

describe('labelAtlas：真实 map.json 字符集（SPEC §6.4）', () => {
  it('全部 1767 个节点名去重后字符集被单张图集完整装下', () => {
    const mapJsonPath = fileURLToPath(new URL('../../../../public/map.json', import.meta.url))
    const { map } = normalizeMapFromJson(readFileSync(mapJsonPath, 'utf8'))
    expect(map.nodes).toHaveLength(1767)

    const chars = collectUniqueChars(map.nodes.map((node) => node.name))
    // 实测去重字符 39 个（含"门口充电桩1"等中文），单张小图集即可装下
    expect(chars).toHaveLength(39)

    const fit = fitCharsToAtlas(chars, LABEL_ATLAS_CELL_SIZE, LABEL_ATLAS_MAX_SIZE)
    expect(fit.droppedCount).toBe(0)
    expect(fit.layout.size).toBe(512)
    for (const char of chars) {
      expect(fit.layout.cells.has(char)).toBe(true)
    }
  })
})
