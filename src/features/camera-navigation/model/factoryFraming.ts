/**
 * 室内视锥约束：将屏幕四角射线与地面求交，得到单位观察距离的覆盖范围。
 * 覆盖范围随距离线性缩放，因此可以直接解出缩远上限和平移区间，无需逐帧迭代。
 */
import type { FactoryLayout } from '@/features/map-visualization'

/**
 * 常规监控保留十二米观察距离，避免把相机降成贴地漫游。
 * 极小地图或狭长视口若无法容纳该距离，优先保证完整画面仍落在厂房内。
 */
export const CAMERA_MIN_DISTANCE_M = 12
/**
 * 左键旋转最低俯角放宽到二十五度，允许观察设备侧面和厂房纵深。
 * 默认监控仍采用五十五度，手动降低角度不会改变初始取景。
 */
export const CAMERA_MIN_PITCH_RAD = 25 * Math.PI / 180
export const CAMERA_MAX_PITCH_RAD = 85 * Math.PI / 180
export const CAMERA_MONITOR_PITCH_RAD = 55 * Math.PI / 180
export const CAMERA_MONITOR_DISTANCE_M = 65

export interface FactoryFrameInput {
  readonly layout: FactoryLayout
  readonly fovDeg: number
  readonly aspect: number
  readonly zoom?: number
  readonly pitch: number
  readonly yaw: number
  readonly distance: number
  readonly targetX: number
  readonly targetZ: number
  readonly keepTarget?: boolean
}

/**
 * 屏幕上沿只保留两度俯视余量，让常规视场下的二十五度低角度能够到达。
 * 宽视场仍按实际半视场角保护，避免射线接近水平后地面求交发散。
 */
export function getFactoryMinPitch(fovDeg: number, zoom = 1): number {
  const halfFov = Math.atan(Math.tan(fovDeg * Math.PI / 360) / zoom)
  return Math.min(CAMERA_MAX_PITCH_RAD, Math.max(CAMERA_MIN_PITCH_RAD, halfFov + 2 * Math.PI / 180))
}

export function computeFactoryFrame(input: FactoryFrameInput) {
  const { layout, yaw } = input
  const pitch = Math.max(getFactoryMinPitch(input.fovDeg, input.zoom), Math.min(CAMERA_MAX_PITCH_RAD, input.pitch))
  const sinPitch = Math.sin(pitch)
  const cosPitch = Math.cos(pitch)
  const sinYaw = Math.sin(yaw)
  const cosYaw = Math.cos(yaw)
  const offsetX = cosPitch * sinYaw
  const offsetZ = cosPitch * cosYaw
  const tanV = Math.tan(input.fovDeg * Math.PI / 360) / (input.zoom ?? 1)
  const tanH = tanV * Math.max(input.aspect, 0.001)

  /**
   * 同时纳入相机自身与观察中心，除了画面覆盖，还保证镜头水平位置留在厂内。
   * 地坪比零平面低八毫米，边界内缩半米可覆盖求交高度差及浮点误差。
   */
  let minX = Math.min(0, offsetX)
  let maxX = Math.max(0, offsetX)
  let minZ = Math.min(0, offsetZ)
  let maxZ = Math.max(0, offsetZ)
  for (const screenX of [-1, 1]) {
    for (const screenY of [-1, 1]) {
      const rayX = -offsetX + screenX * tanH * cosYaw - screenY * tanV * sinPitch * sinYaw
      const rayY = -sinPitch + screenY * tanV * cosPitch
      const rayZ = -offsetZ - screenX * tanH * sinYaw - screenY * tanV * sinPitch * cosYaw
      const reach = -sinPitch / Math.min(rayY, -0.000001)
      const x = offsetX + rayX * reach
      const z = offsetZ + rayZ * reach
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)
    }
  }
  const bounds = layout.bounds
  const inset = layout.config.cameraEdgeInsetM
  const left = bounds.minWorldX + inset
  const right = bounds.maxWorldX - inset
  const top = bounds.minWorldZ + inset
  const bottom = bounds.maxWorldZ - inset
  let maxDistance = Math.min((right - left) / (maxX - minX), (bottom - top) / (maxZ - minZ)) * 0.995
  let targetX = Math.max(left, Math.min(right, input.targetX))
  let targetZ = Math.max(top, Math.min(bottom, input.targetZ))

  /**
   * 跟随时优先保持车辆位于画面中心，接近墙边则收近镜头。
   * 自由平移保持当前倍率，通过移动观察中心收敛到允许区间。
   */
  if (input.keepTarget) {
    const anchoredMax = Math.min(
      minX < 0 ? (targetX - left) / -minX : Infinity,
      maxX > 0 ? (right - targetX) / maxX : Infinity,
      minZ < 0 ? (targetZ - top) / -minZ : Infinity,
      maxZ > 0 ? (bottom - targetZ) / maxZ : Infinity,
    )
    maxDistance = Math.min(maxDistance, Math.max(CAMERA_MIN_DISTANCE_M, anchoredMax * 0.995))
  }
  const minDistance = Math.min(CAMERA_MIN_DISTANCE_M, maxDistance)
  const distance = Math.max(minDistance, Math.min(maxDistance, input.distance))
  targetX = Math.max(left - minX * distance, Math.min(right - maxX * distance, targetX))
  targetZ = Math.max(top - minZ * distance, Math.min(bottom - maxZ * distance, targetZ))
  return {
    target: { x: targetX, z: targetZ },
    position: { x: targetX + offsetX * distance, y: sinPitch * distance, z: targetZ + offsetZ * distance },
    minDistance,
    maxDistance,
    pitch,
  }
}
