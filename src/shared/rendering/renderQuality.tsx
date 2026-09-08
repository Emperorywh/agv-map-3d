/**
 * 监控场景的显式画质预算，默认均衡档限制多通道开销。
 * 所有档位保持业务数据、选中和告警语义一致，不依据瞬时帧率反复切换资源。
 */
import { createContext, useContext } from 'react'

export type RenderQualityPreset = 'performance' | 'balanced' | 'high'
/**
 * 高模阈值提高后，车体与设施在中远景优先使用低模，近景仍保留原模型。
 * 透射按水晶自身的投影尺寸和可见数量双重限额；性能档使用简化水晶。
 * 高画质主画面保留精修几何，所有档位的阴影与倒影都使用最低可用几何。
 * 抗锯齿预算控制最终 FXAA 通道，不再为后处理分配多重采样缓冲。
 * 均衡与高画质保留边缘平滑，性能档维持最少通道。
 */
export const RENDER_QUALITY = {
  performance: { maxDpr: 1, antialias: false, bloomScale: 0.5, transmissionScale: 0.35, reflectionSize: 256, reflectionFps: 15, pointLights: 4, lodPixels: [240, 80], crystalPixels: 160, crystalLimit: 0 },
  balanced: { maxDpr: 1.25, antialias: true, bloomScale: 1, transmissionScale: 0.5, reflectionSize: 512, reflectionFps: 30, pointLights: 8, lodPixels: [180, 60], crystalPixels: 160, crystalLimit: 1 },
  high: { maxDpr: 2, antialias: true, bloomScale: 2, transmissionScale: 1, reflectionSize: 1024, reflectionFps: 60, pointLights: 64, lodPixels: [0, 0], crystalPixels: 80, crystalLimit: 4 },
} as const
export type RenderQuality = (typeof RENDER_QUALITY)[RenderQualityPreset]
export const RenderQualityContext = createContext<RenderQuality>(RENDER_QUALITY.balanced)
export const useRenderQuality = () => useContext(RenderQualityContext)
