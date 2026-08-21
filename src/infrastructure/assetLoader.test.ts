/**
 * assetLoader 降级路径与内置 glTF 资产约定测试（SPEC §5.4 / §10）。
 *
 * GLTFLoader 的 FileLoader 进度事件依赖浏览器全局 ProgressEvent，
 * Node 测试环境补齐最小 polyfill（仅测试环境，不影响生产代码）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Box3, Group, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CHARGING_PILE_ASSET_FILE,
  loadDecorativeAssets,
  ROLLER_DOOR_FRAME_ASSET_FILE,
} from './assetLoader'

if (typeof globalThis.ProgressEvent === 'undefined') {
  globalThis.ProgressEvent = class ProgressEvent {
    readonly type: string
    readonly lengthComputable: boolean
    readonly loaded: number
    readonly total: number
    constructor(type: string, init: { lengthComputable?: boolean; loaded?: number; total?: number }) {
      this.type = type
      this.lengthComputable = init.lengthComputable ?? false
      this.loaded = init.loaded ?? 0
      this.total = init.total ?? 0
    }
  } as typeof ProgressEvent
}

function parseAsset(fileName: string): Promise<GLTF> {
  const assetPath = fileURLToPath(new URL(`../../public/assets/${fileName}`, import.meta.url))
  const text = readFileSync(assetPath, 'utf8')
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(text, '', resolve, reject)
  })
}

describe('assetLoader：glTF 加载失败 / 缺失的分级降级（SPEC §10）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('加载失败 → 程序化占位体替换 + console 警告，Promise 不 reject（场景照常打开）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pileFallback = new Group()
    const frameFallback = new Group()
    // data: URL 内容不是合法 glTF → 两个资产都走解析失败路径
    const assets = await loadDecorativeAssets({
      baseUrl: 'data:text/plain,broken-',
      fallbacks: {
        chargingPile: () => pileFallback,
        rollerDoorFrame: () => frameFallback,
      },
    })
    expect(assets.chargingPileUsedFallback).toBe(true)
    expect(assets.rollerDoorFrameUsedFallback).toBe(true)
    expect(assets.chargingPile).toBe(pileFallback)
    expect(assets.rollerDoorFrame).toBe(frameFallback)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('加载成功 → 使用 glTF 场景，无降级无警告', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const assetPath = fileURLToPath(
      new URL(`../../public/assets/${CHARGING_PILE_ASSET_FILE}`, import.meta.url),
    )
    // data: URL 直供文件内容（# 后文件名为 fragment，fetch 时剥离），验证 loadAsync 成功路径
    const base64 = readFileSync(assetPath).toString('base64')
    const assets = await loadDecorativeAssets({
      baseUrl: `data:application/json;base64,${base64}#`,
      fallbacks: { chargingPile: () => new Group(), rollerDoorFrame: () => new Group() },
    })
    expect(assets.chargingPileUsedFallback).toBe(false)
    expect(assets.rollerDoorFrameUsedFallback).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    // 两个 URL 解析到同一 glTF 内容：均为含 3 个网格的充电桩场景
    let meshCount = 0
    assets.chargingPile.traverse((object) => {
      if ((object as { isMesh?: boolean }).isMesh === true) {
        meshCount++
      }
    })
    expect(meshCount).toBe(3)
  })
})

describe('assetLoader：public/assets 内置资产约定（SPEC §5.4 +Z 正面、米制、原点底部中心）', () => {
  it('充电桩：原点在底部中心、米制总高 1.33m、机身 / 屏幕 / 指示条 3 图元', async () => {
    const gltf = await parseAsset(CHARGING_PILE_ASSET_FILE)
    let meshCount = 0
    gltf.scene.traverse((object) => {
      if ((object as { isMesh?: boolean }).isMesh === true) {
        meshCount++
      }
    })
    expect(meshCount).toBe(3)
    const bbox = new Box3().setFromObject(gltf.scene)
    const center = bbox.getCenter(new Vector3())
    const size = bbox.getSize(new Vector3())
    expect(bbox.min.y).toBeCloseTo(0, 6) // 原点底部
    expect(Math.abs(center.x)).toBeLessThan(1e-6) // 水平居中
    expect(Math.abs(center.z)).toBeLessThan(0.05) // 正面（+Z）屏幕微凸，机身居中
    expect(size.y).toBeCloseTo(1.33, 6) // 米制
  })

  it('卷帘门门框：原点在底部中心、门洞净宽 3m / 净高 3m、总高 3.3m', async () => {
    const gltf = await parseAsset(ROLLER_DOOR_FRAME_ASSET_FILE)
    const bbox = new Box3().setFromObject(gltf.scene)
    const center = bbox.getCenter(new Vector3())
    const size = bbox.getSize(new Vector3())
    expect(bbox.min.y).toBeCloseTo(0, 6)
    expect(Math.abs(center.x)).toBeLessThan(1e-6)
    expect(Math.abs(center.z)).toBeLessThan(1e-6)
    // 总宽 = 净宽 3.0 + 两柱各 0.2；总高 = 净高 3.0 + 横梁 0.3（米制）
    expect(size.x).toBeCloseTo(3.4, 6)
    expect(size.y).toBeCloseTo(3.3, 6)
    expect(size.z).toBeCloseTo(0.3, 6)
  })
})
