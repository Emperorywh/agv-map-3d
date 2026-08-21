/**
 * glTF 点缀资产加载（SPEC §5.4 / §10）：public/assets/ 下的充电桩造型与卷帘门门框。
 *
 * - 资产统一约定：+Z 为正面、米制、原点在底部中心；加载后由场景层按校准规则摆放
 *   （位置经 mapToWorld、朝向经 headingToWorldYaw，均收口于 domain/coordinates.ts）；
 * - 分级降级：任一资产加载失败 / 缺失 → 用调用方提供的程序化占位体替换并
 *   console 警告，**不阻塞场景**（Promise 永不因单资产失败而 reject）；
 * - 返回的模板对象由场景层按摆放逐个 clone（静态网格 clone 共享几何与材质）。
 *
 * infrastructure 为 IO 层，可依赖 domain；不 import config——占位体由场景层
 * （rendering 构建器 + config 常量 / 色值）以工厂函数注入（SPEC §12 依赖矩阵）。
 */

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { Object3D } from 'three'

/** 内置资产文件名（public/assets/ 下，由 scripts/generate-assets.mjs 生成） */
export const CHARGING_PILE_ASSET_FILE = 'charging-pile.gltf'
export const ROLLER_DOOR_FRAME_ASSET_FILE = 'roller-door-frame.gltf'

/** 程序化占位体工厂（加载失败 / 缺失时替换对应资产） */
export interface DecorativeAssetFallbacks {
  chargingPile: () => Object3D
  rollerDoorFrame: () => Object3D
}

/** 点缀资产模板（按摆放克隆使用） */
export interface DecorativeAssets {
  chargingPile: Object3D
  rollerDoorFrame: Object3D
  /** true = 该资产走了程序化占位降级（已 console 警告，SPEC §10） */
  chargingPileUsedFallback: boolean
  rollerDoorFrameUsedFallback: boolean
}

export interface LoadDecorativeAssetsOptions {
  /** 资产目录 URL；缺省 `${import.meta.env.BASE_URL}assets/`（拼 BASE_URL 兼容子路径部署） */
  baseUrl?: string
  fallbacks: DecorativeAssetFallbacks
}

/**
 * 加载全部点缀资产；单资产失败走占位降级并警告，整体永不 reject（场景照常打开）。
 * 两个资产并行加载（本地小文件，毫秒级）。
 */
export async function loadDecorativeAssets(
  options: LoadDecorativeAssetsOptions,
): Promise<DecorativeAssets> {
  const baseUrl = options.baseUrl ?? `${import.meta.env.BASE_URL}assets/`
  const loader = new GLTFLoader()
  const [chargingPile, rollerDoorFrame] = await Promise.all([
    loadOneAsset(loader, `${baseUrl}${CHARGING_PILE_ASSET_FILE}`, '充电桩造型', () =>
      options.fallbacks.chargingPile(),
    ),
    loadOneAsset(loader, `${baseUrl}${ROLLER_DOOR_FRAME_ASSET_FILE}`, '卷帘门门框', () =>
      options.fallbacks.rollerDoorFrame(),
    ),
  ])
  return {
    chargingPile: chargingPile.object,
    rollerDoorFrame: rollerDoorFrame.object,
    chargingPileUsedFallback: chargingPile.usedFallback,
    rollerDoorFrameUsedFallback: rollerDoorFrame.usedFallback,
  }
}

interface LoadedAsset {
  object: Object3D
  usedFallback: boolean
}

/** 加载单个 glTF；失败（缺失 / 网络 / 解析错误）→ console 警告 + 程序化占位体 */
async function loadOneAsset(
  loader: GLTFLoader,
  url: string,
  label: string,
  fallback: () => Object3D,
): Promise<LoadedAsset> {
  try {
    const gltf = await loader.loadAsync(url)
    return { object: gltf.scene, usedFallback: false }
  } catch (error) {
    console.warn(`[assetLoader] ${label} glTF 加载失败，使用程序化占位体替换（${url}）：`, error)
    return { object: fallback(), usedFallback: true }
  }
}
