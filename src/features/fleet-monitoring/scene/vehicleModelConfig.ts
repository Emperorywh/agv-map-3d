/**
 * 明确的模型适配档案：当前资产为设计一，长 1.038 米、宽 0.631 米、高 1.64 米，
 * 原始车头正 Z，加载后烘焙为正 X；底面零米、承载平台顶面 0.287 米。
 * 过渡期策略：忽略申报车型与长宽，全部车辆统一使用精修资产渲染；
 * 尺寸档案仅供加载校验和部件摆放（载货面、信标、阴影）使用，不再筛选车辆。
 * 精修、中景和远景模型共享本尺寸档案，按屏幕投影大小切换几何。
 * 程序轮廓仅在资源加载完成前占位，高画质档固定使用原始精修资产。
 */
import type { VehicleSnapshot } from '../model/types'
/**
 * 直接引用设计一资产及其两档派生几何，由构建工具统一发布并生成资源地址。
 * 精修与中远景始终使用同一车型，避免距离切换时重新显示旧车辆。
 */
import modelUrl from '../../../../assets/agv_design1/agv_design1.glb?url'
import modelLod1Url from '../../../../assets/agv_design1/agv_design1_LOD1.glb?url'
import modelLod2Url from '../../../../assets/agv_design1/agv_design1_LOD2.glb?url'

export const INDUSTRIAL_AGV_MODEL = Object.freeze({
  url: modelUrl,
  lodUrls: [modelLod1Url, modelLod2Url],
  length: 1.038,
  width: 0.631,
  height: 1.64,
  platformTop: 0.287,
  dimensionToleranceM: 0.001,
})

/**
 * 过渡期判定：不再按尺寸档案筛选车辆，所有可用精修资源的车辆一律使用 GLB。
 * 保留函数形态与调用点，待车型字典明确后再恢复按类型/尺寸的差异化适配。
 */
export function usesIndustrialModel(_snapshot: VehicleSnapshot): boolean {
  return true
}
