/**
 * 室内自动取景：默认监控和主动总览共享厂房视锥约束。
 * 默认只展开可读的作业区，总览再尝试更高俯角与合适方位以容纳整张地图。
 */
import { getFactoryLayout, type FactoryLayout, type SceneBounds } from '@/features/map-visualization'
import {
  CAMERA_MIN_DISTANCE_M,
  CAMERA_MONITOR_DISTANCE_M,
  CAMERA_MONITOR_PITCH_RAD,
  computeFactoryFrame,
} from './factoryFraming'

export { CAMERA_MIN_DISTANCE_M } from './factoryFraming'

/**
 * 近裁剪保留设备近景细节；远裁剪按整个厂房包络配置。
 * 距离限制由当前视口和厂房共同决定，不再使用地图对角线的固定倍数。
 */
export interface OverviewPose {
  readonly position: { readonly x: number; readonly y: number; readonly z: number }
  readonly target: { readonly x: number; readonly z: number }
  readonly near: number
  readonly far: number
  readonly minDistance: number
  readonly maxDistance: number
}

export function computeOverviewPose(
  bounds: SceneBounds,
  fovDeg: number,
  aspect: number,
  layout: FactoryLayout = getFactoryLayout(bounds),
  mode: 'monitor' | 'overview' = 'overview',
): OverviewPose {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const safeFov = Number.isFinite(fovDeg) ? Math.max(1, Math.min(120, fovDeg)) : 45
  const tanV = Math.tan(safeFov * Math.PI / 360)
  const tanH = tanV * safeAspect
  const corners = [
    [bounds.minWorldX, bounds.minWorldZ],
    [bounds.maxWorldX, bounds.minWorldZ],
    [bounds.minWorldX, bounds.maxWorldZ],
    [bounds.maxWorldX, bounds.maxWorldZ],
  ] as const

  /**
   * 对地图四角求透视包络，之后再验证厂房约束修正后的真实画面。
   * 总览可改变方位以适应横屏、竖屏；默认监控始终保留斜俯视方向。
   */
  const candidate = (pitch: number, yaw: number) => {
    const sinPitch = Math.sin(pitch)
    const cosPitch = Math.cos(pitch)
    const sinYaw = Math.sin(yaw)
    const cosYaw = Math.cos(yaw)
    let fitDistance = CAMERA_MIN_DISTANCE_M
    for (const [x, z] of corners) {
      const dx = x - bounds.centerWorldX
      const dz = z - bounds.centerWorldZ
      const across = dx * cosYaw - dz * sinYaw
      const along = dx * sinYaw + dz * cosYaw
      fitDistance = Math.max(fitDistance, Math.abs(across) / tanH + along * cosPitch, Math.abs(along * sinPitch) / tanV + along * cosPitch)
    }
    const frame = computeFactoryFrame({
      layout,
      fovDeg: safeFov,
      aspect: safeAspect,
      pitch,
      yaw,
      distance: mode === 'monitor' ? Math.min(CAMERA_MONITOR_DISTANCE_M, fitDistance * 1.08) : fitDistance * 1.05,
      targetX: bounds.centerWorldX,
      targetZ: bounds.centerWorldZ,
    })
    let overflow = 0
    const actualDistance = frame.position.y / Math.sin(frame.pitch)
    for (const [x, z] of corners) {
      const dx = x - frame.target.x
      const dz = z - frame.target.z
      const across = dx * cosYaw - dz * sinYaw
      const along = dx * sinYaw + dz * cosYaw
      const depth = Math.max(0.001, actualDistance - along * Math.cos(frame.pitch))
      overflow = Math.max(overflow, Math.abs(across) / (depth * tanH), Math.abs(along * Math.sin(frame.pitch)) / (depth * tanV))
    }
    return { frame, overflow }
  }
  let best = candidate(CAMERA_MONITOR_PITCH_RAD, Math.PI / 4)
  if (mode === 'overview') {
    let fitted = false
    for (const pitchDeg of [60, 70, 80, 85]) {
      for (const yaw of [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4]) {
        const next = candidate(pitchDeg * Math.PI / 180, yaw)
        if (next.overflow < best.overflow) best = next
        if (next.overflow <= 1) {
          best = next
          fitted = true
          break
        }
      }
      if (fitted) break
    }
  }
  return {
    position: best.frame.position,
    target: best.frame.target,
    near: 0.05,
    far: Math.max(layout.bounds.diagonal * 3, 200),
    minDistance: best.frame.minDistance,
    maxDistance: best.frame.maxDistance,
  }
}
