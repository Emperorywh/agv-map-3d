/*
 * [夹具·负例] 深层导入 map-visualization 内部文件。
 * 预期：触发 feature-map-visualization-deep-import-forbidden。
 */
import { mapInternal } from '../map-visualization/internal'

export const deep = mapInternal
