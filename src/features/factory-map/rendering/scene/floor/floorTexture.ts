/**
 * 厂房地坪程序纹理像素生成（SPEC §6.2）。
 *
 * 纯函数、无 DOM：以 FLOOR_TEXTURE_SEED=0x4D415033（config/sceneMetrics.ts）驱动
 * xorshift32，为基色 #A9A6A0（visualTheme.FACTORY_FLOOR_COLOR）的每个 RGB 通道加入
 * [-6,+6] 整数噪声，输出 512×512 RGBA 不透明像素；同 seed 两次生成逐字节一致。
 *
 * Canvas 组装（CanvasTexture、SRGBColorSpace、RepeatWrapping、anisotropy）由
 * rendering/resources/FactorySceneResources 负责，本模块不依赖 DOM。
 *
 * 保留 texel：(0,0) 写入无噪声的纯净基色。地坪 Box 侧面/底面 UV 全部采样该 texel
 * 中心（floorGeometry.ts），实现「侧面无纹理同色」且地坪保持单 mesh 单 draw call
 *（§6.2、§6.7）。
 */

import { FACTORY_FLOOR_COLOR } from '../../../config/visualTheme'

/** 程序纹理边长（§6.2：512×512，未列入 §13 配置表，唯一定义于此） */
export const FLOOR_TEXTURE_SIZE = 512

/** 每通道整数噪声幅度（§6.2：[-6,+6]） */
export const FLOOR_TEXTURE_NOISE_RANGE = 6

/** anisotropy 上限（§6.2：min(8, renderer.capabilities.getMaxAnisotropy())） */
export const FLOOR_TEXTURE_ANISOTROPY_CAP = 8

/**
 * xorshift32 单步推进，返回新的 32 位无符号状态。
 * seed 必须非零（FLOOR_TEXTURE_SEED=0x4D415033 满足；零 seed 会退化为恒定序列）。
 */
export function xorshift32Next(state: number): number {
  let x = state >>> 0
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  return x >>> 0
}

/** '#RRGGBB' → [r, g, b] 字节（0~255）；输入为 visualTheme 的固定字面量 */
export function parseHexColorRgb(hex: string): readonly [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/**
 * 生成 size×size RGBA 像素（行优先，每像素 RGBA 四字节）。
 * 每像素从 xorshift32 连续取三个状态，分别映射为 R/G/B 通道的 [-6,+6] 整数噪声
 * （state % 13 - 6）；alpha 恒为 255（不透明）。texel (0,0) 最后覆写为纯净基色
 *（见模块头注释的保留 texel 约定）。
 */
export function generateFloorTexturePixels(seed: number, size: number): Uint8ClampedArray {
  const [baseR, baseG, baseB] = parseHexColorRgb(FACTORY_FLOOR_COLOR)
  const span = FLOOR_TEXTURE_NOISE_RANGE * 2 + 1 // 13 个整数档位：-6..+6
  const pixels = new Uint8ClampedArray(size * size * 4)
  let state = seed >>> 0
  for (let i = 0; i < size * size; i += 1) {
    state = xorshift32Next(state)
    const noiseR = (state % span) - FLOOR_TEXTURE_NOISE_RANGE
    state = xorshift32Next(state)
    const noiseG = (state % span) - FLOOR_TEXTURE_NOISE_RANGE
    state = xorshift32Next(state)
    const noiseB = (state % span) - FLOOR_TEXTURE_NOISE_RANGE
    const offset = i * 4
    pixels[offset] = baseR + noiseR
    pixels[offset + 1] = baseG + noiseG
    pixels[offset + 2] = baseB + noiseB
    pixels[offset + 3] = 255
  }
  // 保留 texel (0,0) 为纯净基色：地坪 Box 侧面/底面 UV 的唯一采样点
  pixels[0] = baseR
  pixels[1] = baseG
  pixels[2] = baseB
  pixels[3] = 255
  return pixels
}

/** 保留 texel (0,0) 中心的 UV 坐标（侧面/底面采样点） */
export function floorTextureCleanTexelUv(size: number): readonly [number, number] {
  return [0.5 / size, 0.5 / size]
}
