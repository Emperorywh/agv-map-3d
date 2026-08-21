/**
 * infrastructure 层：IO（mapLoader fetch + Worker、normalize.worker、
 * assetLoader glTF），可依赖 domain；禁止被 rendering / domain 反向引用（SPEC §12）。
 * assetLoader 由 TASK-007 起实现。
 */
export { loadMap } from './mapLoader'
export type { LoadedMap, LoadMapOptions, MapLoadProgress } from './mapLoader'
export { isWebGLSupported } from './webglSupport'
