/**
 * 明确的模型适配档案：当前资产为一米八乘七十厘米，车头正 X、底面零米。
 * 未确认的原始车型枚举不猜含义；只允许明确配置的尺寸档案使用精修资产。
 * 后续得到车型字典后填写原始类型映射，差异尺寸始终走程序模型而不拉伸 GLB。
 */
import type { VehicleSnapshot } from '../model/types'

export const INDUSTRIAL_AGV_MODEL = Object.freeze({
  url: './models/agv_industrial.glb',
  length: 1.8,
  width: 0.7,
  height: 0.35,
  platformTop: 0.342,
  dimensionToleranceM: 0.001,
  /**
   * 远景采用轻量程序轮廓，进入和退出距离不同以避免边界反复闪切。
   * 近景仍展示完整精修倒角，距离只影响细节而不改变业务尺寸或位置。
   */
  detailedEnterM: 16,
  detailedExitM: 20,
})

export const VEHICLE_TYPE_MODELS: Readonly<Record<string, 'industrial' | 'procedural'>> = Object.freeze({})

export function usesIndustrialModel(snapshot: VehicleSnapshot): boolean {
  const type = typeof snapshot.rawType === 'string' || typeof snapshot.rawType === 'number'
    ? VEHICLE_TYPE_MODELS[String(snapshot.rawType)] : undefined
  if (type === 'procedural') return false
  const config = INDUSTRIAL_AGV_MODEL
  return snapshot.dimensionValid &&
    Math.abs(snapshot.dimension.length - config.length) <= config.dimensionToleranceM &&
    Math.abs(snapshot.dimension.width - config.width) <= config.dimensionToleranceM
}
