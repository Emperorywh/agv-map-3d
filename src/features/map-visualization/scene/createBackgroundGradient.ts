/**
 * 页面背景渐变纹理（SPEC §7.1 清屏口径的视觉增强；视觉差距分析 P2-6）。
 *
 * 职责：生成一张屏幕空间的渐变 + 暗角 Canvas 纹理（顶部冷灰蓝 → 底部更深、
 *       四角向黑压暗），挂到 scene.background 替代纯色清屏，提供 Reference
 *       的聚焦感。Canvas 2D 不可得（无头测试环境）时返回 null，由调用方
 *       降级为 MAP_CLEAR_COLOR 纯色（与地坪贴图、名称图集同口径）。
 * 边界：本模块只产出纹理；挂载与释放编排归 MapVisualizationFeature。雾色
 *       仍为清屏底色（远处地面渐隐进背景中间档），暗角只压屏幕边缘。
 * 关键不变量：
 * 1. 纹理由创建方拥有：调用方负责在卸载/重建时 dispose（幂等）；
 * 2. 纹理颜色空间 SRGB，与 MAP_CLEAR_COLOR 的取色管线一致。
 */
import * as THREE from 'three'
import {
  BACKGROUND_BOTTOM_COLOR,
  BACKGROUND_TEXTURE_PX,
  BACKGROUND_TOP_COLOR,
  BACKGROUND_VIGNETTE_STRENGTH,
} from './mapAppearance'

/** 背景纹理句柄：texture 挂 scene.background，dispose 释放 GPU 资源 */
export interface BackgroundHandle {
  readonly texture: THREE.Texture
  dispose(): void
}

/**
 * 生成背景渐变纹理：线性垂直渐变（顶部冷灰蓝 → 底部深）叠加径向暗角
 * （中心不压暗、四角向黑压暗 BACKGROUND_VIGNETTE_STRENGTH）。
 * Canvas 不可用时返回 null。
 */
export function createBackgroundGradient(): BackgroundHandle | null {
  const size = BACKGROUND_TEXTURE_PX
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx === null) {
    return null
  }

  const gradient = ctx.createLinearGradient(0, 0, 0, size)
  gradient.addColorStop(0, BACKGROUND_TOP_COLOR)
  gradient.addColorStop(1, BACKGROUND_BOTTOM_COLOR)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)

  // 暗角：径向黑色罩（中心 alpha 0 → 四角 alpha = 强度），source-over 压暗边缘
  const vignette = ctx.createRadialGradient(
    size / 2,
    size / 2,
    size * 0.3,
    size / 2,
    size / 2,
    size * 0.72,
  )
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)')
  vignette.addColorStop(1, `rgba(0, 0, 0, ${BACKGROUND_VIGNETTE_STRENGTH})`)
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, size, size)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  // 屏幕空间背景不需要平铺与 mipmap（一次覆盖全屏）
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false

  let disposed = false
  return {
    texture,
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      texture.dispose()
    },
  }
}
