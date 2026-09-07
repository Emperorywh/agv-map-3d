/**
 * 将纯数学厂房约束应用到实际相机，覆盖滚轮、拖拽、跟随和视口变化。
 * 保留用户选择的方位与俯角，不递归调用控制器更新，避免事件循环。
 */
import type { PerspectiveCamera } from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { FactoryLayout } from '@/features/map-visualization'
import { CAMERA_MAX_PITCH_RAD, computeFactoryFrame, getFactoryMinPitch } from '../model/factoryFraming'

export function constrainCameraToFactory(
  camera: PerspectiveCamera,
  controls: OrbitControls,
  layout: FactoryLayout,
  keepTarget: boolean,
): boolean {
  const dx = camera.position.x - controls.target.x
  const dz = camera.position.z - controls.target.z
  const input = {
    layout,
    fovDeg: camera.fov,
    aspect: camera.aspect,
    zoom: camera.zoom,
    pitch: Math.atan2(camera.position.y, Math.hypot(dx, dz)),
    yaw: Math.atan2(dx, dz),
    distance: Math.hypot(dx, camera.position.y, dz),
    targetX: controls.target.x,
    targetZ: controls.target.z,
    keepTarget,
  }
  /**
   * 缩放上限使用当前角度能够容纳的距离，到边界即停止缩远。
   * 总览只由空格或显式命令触发，滚轮不再自动转向、抬头并拉回地图中心。
   */
  const frame = computeFactoryFrame(input)
  controls.minDistance = frame.minDistance
  controls.maxDistance = frame.maxDistance
  controls.minPolarAngle = Math.PI / 2 - CAMERA_MAX_PITCH_RAD
  controls.maxPolarAngle = Math.PI / 2 - getFactoryMinPitch(camera.fov, camera.zoom)
  const changed = Math.abs(frame.position.x - camera.position.x) > 0.000001 ||
    Math.abs(frame.position.y - camera.position.y) > 0.000001 ||
    Math.abs(frame.position.z - camera.position.z) > 0.000001 ||
    Math.abs(frame.target.x - controls.target.x) > 0.000001 ||
    Math.abs(frame.target.z - controls.target.z) > 0.000001 || controls.target.y !== 0
  if (changed) {
    controls.target.set(frame.target.x, 0, frame.target.z)
    camera.position.set(frame.position.x, frame.position.y, frame.position.z)
    camera.lookAt(controls.target)
    camera.updateMatrixWorld()
  }
  return changed
}
