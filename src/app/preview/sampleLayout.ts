/**
 * 样板设施的明确布局配置，位置使用世界米制坐标，尺寸直接传入程序建模器。
 * 这些位置仅用于独立开发预览；没有现场布局数据时不得投放到真实通行路线。
 */
import { RACK_CONFIG } from '@/shared/industrial/facilities'

export const SAMPLE_LAYOUT = {
  cabinet: { x: 2.1, y: 0, z: -0.4, rotation: 0 },
  rack: { x: -0.4, y: 0, z: -2.3, rotation: 0, dimensions: RACK_CONFIG },
  pallet: { x: -2.1, y: 0, z: 0.5, length: 1.2, width: 0.8, height: 0.13 },
}
