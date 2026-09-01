/*
 * [夹具·负例] 核心三 Feature 之间互相导入。
 * 预期：触发 core-feature-render-quality-no-cross-feature-import。
 */
import { mapPublic } from '../map-visualization/index'

export const quality = mapPublic
