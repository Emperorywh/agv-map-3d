/*
 * [夹具·负例] camera-navigation 导入未授权的 render-quality 公开入口。
 * 预期：触发 adapter-feature-public-entry-only。
 */
import { quality } from '../render-quality/index'

export const camera = quality
