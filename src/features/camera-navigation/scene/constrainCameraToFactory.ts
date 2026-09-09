/**
 * 手动浏览只约束镜头和观察中心的实际空间位置，不要求屏幕四角全部留在厂房内。
 * 自动取景仍使用 factoryFraming 的视锥包络，避免取景算法持续抵消用户的平移。
 */
import { MathUtils, type PerspectiveCamera } from 'three'
import type { FactoryLayout } from '@/features/map-visualization'
import type { NavigationLimits } from '../model/navigationControls'
import { CAMERA_MAX_PITCH_RAD, CAMERA_MIN_DISTANCE_M, getFactoryMinPitch } from '../model/factoryFraming'
import { getCameraMinimumHeight } from './constrainCameraToGround'

export function constrainCameraToFactory(
  camera: PerspectiveCamera,
  controls: NavigationLimits,
  layout: FactoryLayout,
  keepTarget: boolean,
): boolean {
  const { bounds, config } = layout
  const left = bounds.minWorldX + config.cameraEdgeInsetM
  const right = bounds.maxWorldX - config.cameraEdgeInsetM
  const top = bounds.minWorldZ + config.cameraEdgeInsetM
  const bottom = bounds.maxWorldZ - config.cameraEdgeInsetM
  const dx = camera.position.x - controls.target.x
  const dz = camera.position.z - controls.target.z
  const yaw = Math.atan2(dx, dz)
  const minPitch = getFactoryMinPitch(camera.fov, camera.zoom)
  const pitch = MathUtils.clamp(Math.atan2(camera.position.y, Math.hypot(dx, dz)), minPitch, CAMERA_MAX_PITCH_RAD)
  const sinPitch = Math.sin(pitch)
  const offsetX = Math.cos(pitch) * Math.sin(yaw)
  const offsetZ = Math.cos(pitch) * Math.cos(yaw)
  const minDistance = Math.max(CAMERA_MIN_DISTANCE_M, getCameraMinimumHeight(camera) / sinPitch)
  const tanV = Math.tan(camera.getEffectiveFOV() * Math.PI / 360)
  const range = bounds.diagonal / Math.max(Math.min(tanV, tanV * camera.aspect), 0.001)
  let maxDistance = Math.max(minDistance, Math.min(
    range,
    (right - left) / Math.max(Math.abs(offsetX), 0.000001),
    (bottom - top) / Math.max(Math.abs(offsetZ), 0.000001),
  ) * 0.995)
  let targetX = MathUtils.clamp(controls.target.x, left, right)
  let targetZ = MathUtils.clamp(controls.target.z, top, bottom)
  /**
   * 跟随优先保持车辆所在观察中心，只缩短相机偏移；到达净空下限时再滑动中心。
   * 自由平移分别截断两个坐标轴，贴墙后仍可沿墙移动，反向拖动立即恢复。
   */
  if (keepTarget) {
    const availableX = offsetX >= 0 ? right - targetX : targetX - left
    const availableZ = offsetZ >= 0 ? bottom - targetZ : targetZ - top
    /**
     * 与墙平行的方向不会占用该轴空间，不能用零余量除以伪分母把跟随距离压成零。
     * 只在确实朝向该侧墙面时，才用剩余空间限制相机偏移。
     */
    maxDistance = Math.max(minDistance, Math.min(maxDistance,
      Math.abs(offsetX) > 1e-9 ? availableX / Math.abs(offsetX) : Infinity,
      Math.abs(offsetZ) > 1e-9 ? availableZ / Math.abs(offsetZ) : Infinity,
    ))
  }
  const distance = MathUtils.clamp(Math.hypot(dx, camera.position.y, dz), minDistance, maxDistance)
  const x = offsetX * distance
  const z = offsetZ * distance
  targetX = MathUtils.clamp(targetX, left - Math.min(0, x), right - Math.max(0, x))
  targetZ = MathUtils.clamp(targetZ, top - Math.min(0, z), bottom - Math.max(0, z))
  const y = sinPitch * distance
  controls.minDistance = minDistance
  controls.maxDistance = maxDistance
  controls.minPolarAngle = Math.PI / 2 - CAMERA_MAX_PITCH_RAD
  controls.maxPolarAngle = Math.PI / 2 - minPitch
  const changed = Math.abs(camera.position.x - targetX - x) > 1e-9 ||
    Math.abs(camera.position.y - y) > 1e-9 || Math.abs(camera.position.z - targetZ - z) > 1e-9 ||
    Math.abs(controls.target.x - targetX) > 1e-9 || Math.abs(controls.target.z - targetZ) > 1e-9 || controls.target.y !== 0
  if (changed) {
    controls.target.set(targetX, 0, targetZ)
    camera.position.set(targetX + x, y, targetZ + z)
  }
  return changed
}
