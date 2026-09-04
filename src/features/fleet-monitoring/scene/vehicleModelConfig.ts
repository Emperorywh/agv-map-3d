/**
 * 明确的模型适配档案：当前资产为 AGV_FUTURE，长 2.449 米、宽 1.32 米、高 0.5365 米，
 * 车头正 X、底面零米、货舱面 0.433 米（与 assets/agv_future 验证报告一致）。
 * 过渡期策略：忽略申报车型与长宽，全部车辆统一使用精修资产渲染；
 * 尺寸档案仅供加载校验和部件摆放（载货面、信标、阴影）使用，不再筛选车辆。
 * 不做距离分档：任何缩放级别都展示精修模型，程序轮廓仅在资源加载完成前占位。
 */
import type { VehicleSnapshot } from '../model/types'

export const INDUSTRIAL_AGV_MODEL = Object.freeze({
  url: './models/AGV_FUTURE.glb',
  length: 2.449,
  width: 1.32,
  height: 0.5365,
  platformTop: 0.433,
  dimensionToleranceM: 0.001,
})

/**
 * 过渡期判定：不再按尺寸档案筛选车辆，所有可用精修资源的车辆一律使用 GLB。
 * 保留函数形态与调用点，待车型字典明确后再恢复按类型/尺寸的差异化适配。
 */
export function usesIndustrialModel(_snapshot: VehicleSnapshot): boolean {
  return true
}
