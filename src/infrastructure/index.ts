/**
 * infrastructure 层：IO（mapLoader fetch + Worker、normalize.worker、
 * assetLoader glTF），可依赖 domain；禁止被 rendering / domain 反向引用（SPEC §12）。
 */
export { loadMap } from './mapLoader'
export type { LoadedMap, LoadMapOptions, MapLoadProgress } from './mapLoader'
export {
  CHARGING_PILE_ASSET_FILE,
  loadDecorativeAssets,
  ROLLER_DOOR_FRAME_ASSET_FILE,
} from './assetLoader'
export type {
  DecorativeAssetFallbacks,
  DecorativeAssets,
  LoadDecorativeAssetsOptions,
} from './assetLoader'
export { isWebGLSupported } from './webglSupport'
