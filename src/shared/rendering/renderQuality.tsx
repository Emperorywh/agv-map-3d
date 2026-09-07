/**
 * 监控场景的显式画质预算，默认均衡档限制多通道开销。
 * 所有档位保持业务数据、选中和告警语义一致，不依据瞬时帧率反复切换资源。
 */
import { createContext, useContext } from 'react'

export type RenderQualityPreset = 'performance' | 'balanced' | 'high'
/**
 * 水晶达到整塔投影像素阈值后才启用主画面的真实透射，远景保留发光与半透明轮廓。
 * 高画质阈值为零，主画面始终保留原水晶；倒影统一使用单次绘制的简化材质。
 */
export const RENDER_QUALITY = {
  performance: { maxDpr: 1, msaa: 0, bloomScale: 0.5, transmissionScale: 0.35, reflectionSize: 256, reflectionFps: 15, pointLights: 4, lodPixels: [180, 60], crystalPixels: 180 },
  balanced: { maxDpr: 1.25, msaa: 2, bloomScale: 1, transmissionScale: 0.5, reflectionSize: 512, reflectionFps: 30, pointLights: 8, lodPixels: [120, 36], crystalPixels: 120 },
  high: { maxDpr: 2, msaa: 4, bloomScale: 2, transmissionScale: 1, reflectionSize: 1024, reflectionFps: 60, pointLights: 64, lodPixels: [0, 0], crystalPixels: 0 },
} as const
export type RenderQuality = (typeof RENDER_QUALITY)[RenderQualityPreset]
export const RenderQualityContext = createContext<RenderQuality>(RENDER_QUALITY.balanced)
export const useRenderQuality = () => useContext(RenderQualityContext)
