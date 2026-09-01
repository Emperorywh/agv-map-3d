/*
 * [夹具·负例] shared 反向依赖 Feature。
 * 预期：触发 shared-independence。
 */
import { mapPublic } from '../features/map-visualization/index'

export const impure = mapPublic
