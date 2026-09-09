/**
 * 相机导航的公开控制合同，不再暴露第三方控制器及其隐藏的鼠标状态。
 * 高频位姿保留在 Three 对象中，预览和调试入口通过此合同读取或提交机位。
 */
import type { Vector3 } from 'three'

export interface NavigationLimits {
  readonly target: Vector3
  minDistance: number
  maxDistance: number
  minPolarAngle: number
  maxPolarAngle: number
  minAzimuthAngle: number
  maxAzimuthAngle: number
  rotateSpeed: number
}

export interface CameraNavigationControls extends NavigationLimits {
  enabled: boolean
  enableRotate: boolean
  enablePan: boolean
  enableZoom: boolean
  zoomSpeed: number
  update(): boolean
  cancelGesture(): void
  dispose(): void
}
