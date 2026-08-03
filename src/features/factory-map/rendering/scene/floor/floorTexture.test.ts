/**
 * floorTexture 单元测试（SPEC §6.2、§15.1 程序纹理确定性要求）。
 *
 * - xorshift32 序列回归锚点；
 * - 512×512 RGBA、alpha 全 255（不透明）、每通道噪声 ∈ [-6,+6] 整数；
 * - 同 seed 两次生成逐字节一致（确定性）、不同 seed 结果不同；
 * - 保留 texel (0,0) 为纯净基色（侧面/底面 UV 采样点）；
 * - 首组像素逐字节回归锚点（seed 0x4D415033）。
 */

import { describe, expect, it } from 'vitest'

import { FLOOR_TEXTURE_SEED } from '../../../config/sceneMetrics'
import { FACTORY_FLOOR_COLOR } from '../../../config/visualTheme'
import {
  FLOOR_TEXTURE_NOISE_RANGE,
  FLOOR_TEXTURE_SIZE,
  floorTextureCleanTexelUv,
  generateFloorTexturePixels,
  parseHexColorRgb,
  xorshift32Next,
} from './floorTexture'

describe('xorshift32Next', () => {
  it('从 FLOOR_TEXTURE_SEED 推进的序列与回归锚点一致', () => {
    let state = FLOOR_TEXTURE_SEED
    const sequence: number[] = []
    for (let i = 0; i < 8; i += 1) {
      state = xorshift32Next(state)
      sequence.push(state)
    }
    expect(sequence).toEqual([
      2410115472, 1396533786, 833941893, 1594150567,
      484045871, 1776067873, 1382516797, 3480176685,
    ])
  })

  it('返回 32 位无符号整数', () => {
    let state = 1
    for (let i = 0; i < 32; i += 1) {
      state = xorshift32Next(state)
      expect(Number.isInteger(state)).toBe(true)
      expect(state).toBeGreaterThanOrEqual(0)
      expect(state).toBeLessThanOrEqual(0xffffffff)
    }
  })
})

describe('parseHexColorRgb', () => {
  it('解析 visualTheme 地坪基色 #A9A6A0 → [169, 166, 160]', () => {
    expect(parseHexColorRgb(FACTORY_FLOOR_COLOR)).toEqual([169, 166, 160])
  })

  it('解析纯黑/纯白', () => {
    expect(parseHexColorRgb('#000000')).toEqual([0, 0, 0])
    expect(parseHexColorRgb('#ffffff')).toEqual([255, 255, 255])
  })
})

describe('generateFloorTexturePixels（§6.2）', () => {
  const pixels = generateFloorTexturePixels(FLOOR_TEXTURE_SEED, FLOOR_TEXTURE_SIZE)

  it('输出 512×512 RGBA，alpha 全 255（不透明）', () => {
    expect(pixels.length).toBe(FLOOR_TEXTURE_SIZE * FLOOR_TEXTURE_SIZE * 4)
    for (let i = 3; i < pixels.length; i += 4) {
      expect(pixels[i]).toBe(255)
    }
  })

  it('同 seed 两次生成逐字节一致（确定性）', () => {
    const again = generateFloorTexturePixels(FLOOR_TEXTURE_SEED, FLOOR_TEXTURE_SIZE)
    expect(again).toEqual(pixels)
  })

  it('不同 seed 生成结果不同', () => {
    const other = generateFloorTexturePixels(0x12345678, FLOOR_TEXTURE_SIZE)
    expect(other).not.toEqual(pixels)
  })

  it('每个 RGB 通道噪声 ∈ [-6,+6] 且全图命中基色 ±6 极值', () => {
    const [baseR, baseG, baseB] = [169, 166, 160]
    const min = [255, 255, 255]
    const max = [0, 0, 0]
    for (let i = 0; i < pixels.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        const value = pixels[i + c]
        if (value < min[c]) min[c] = value
        if (value > max[c]) max[c] = value
      }
    }
    // 基色 ± FLOOR_TEXTURE_NOISE_RANGE 之外不得出现任何字节
    expect(min).toEqual([baseR - FLOOR_TEXTURE_NOISE_RANGE, baseG - FLOOR_TEXTURE_NOISE_RANGE, baseB - FLOOR_TEXTURE_NOISE_RANGE])
    expect(max).toEqual([baseR + FLOOR_TEXTURE_NOISE_RANGE, baseG + FLOOR_TEXTURE_NOISE_RANGE, baseB + FLOOR_TEXTURE_NOISE_RANGE])
  })

  it('保留 texel (0,0) 为纯净基色（侧面/底面 UV 采样点）', () => {
    expect([pixels[0], pixels[1], pixels[2], pixels[3]]).toEqual([169, 166, 160, 255])
  })

  it('前 8 个像素逐字节回归锚点（seed 0x4D415033）', () => {
    const expected = [
      [169, 166, 160, 255], // texel (0,0)：覆写为纯净基色
      [172, 170, 162, 255],
      [175, 171, 159, 255],
      [170, 169, 162, 255],
      [175, 166, 163, 255],
      [169, 169, 161, 255],
      [170, 165, 160, 255],
      [165, 165, 155, 255],
    ]
    for (let i = 0; i < expected.length; i += 1) {
      expect([...pixels.slice(i * 4, i * 4 + 4)]).toEqual(expected[i])
    }
  })
})

describe('floorTextureCleanTexelUv', () => {
  it('指向保留 texel (0,0) 中心：0.5/size', () => {
    expect(floorTextureCleanTexelUv(FLOOR_TEXTURE_SIZE)).toEqual([0.5 / 512, 0.5 / 512])
  })
})
