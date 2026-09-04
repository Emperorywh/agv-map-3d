/**
 * 将纯数学厂房约束应用到实际相机，覆盖滚轮、拖拽、跟随和视口变化。
 * 不递归调用控制器更新，避免事件循环和二次推进阻尼。
 */
import type { PerspectiveCamera } from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { FactoryLayout } from '@/features/map-visualization'
import { CAMERA_MAX_PITCH_RAD, computeFactoryFrame, getFactoryMinPitch } from '../model/factoryFraming'
import { computeOverviewPose, type OverviewPose } from '../model/overviewFraming'

/**
 * 总览距离只随厂房和投影参数变化，按相机缓存，避免每帧重新枚举取景方向。
 * 缩远上限采用可容纳全图的总览姿态，不再被当前局部斜视角提前截断。
 */
const overviewCache = new WeakMap<PerspectiveCamera, {
  layout: FactoryLayout
  fov: number
  aspect: number
  zoom: number
  pose: OverviewPose
}>()

function getOverviewLimit(camera: PerspectiveCamera, layout: FactoryLayout): OverviewPose {
  const cached = overviewCache.get(camera)
  if (cached !== undefined && cached.layout === layout && cached.fov === camera.fov &&
    cached.aspect === camera.aspect && cached.zoom === camera.zoom) {
    return cached.pose
  }
  const pose = computeOverviewPose(layout.mapBounds, camera.getEffectiveFOV(), camera.aspect, layout)
  overviewCache.set(camera, { layout, fov: camera.fov, aspect: camera.aspect, zoom: camera.zoom, pose })
  return pose
}

export function constrainCameraToFactory(
  camera: PerspectiveCamera,
  controls: OrbitControls,
  layout: FactoryLayout,
  keepTarget: boolean,
  allowOverviewAdjustment: boolean,
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
  let frame = computeFactoryFrame(input)
  const overview = keepTarget ? null : getOverviewLimit(camera, layout)

  /**
   * 仅在继续缩远时，逐步转向能容纳全图的高位总览方向，同时收回观察中心。
   * 左键旋转或视口变化时保留手动俯角，由基础约束收近镜头，避免抬回高位。
   * 二分选择满足当前缩放距离的最小姿态调整，保留滚轮连续性；每个候选仍
   * 检查四角地面覆盖，所以放开缩放不会重新露出厂房外部。
   */
  if (allowOverviewAdjustment && overview !== null && input.distance > frame.maxDistance + 0.000001 &&
    overview.maxDistance > frame.maxDistance) {
    const distance = Math.min(input.distance, overview.maxDistance)
    const overviewX = overview.position.x - overview.target.x
    const overviewZ = overview.position.z - overview.target.z
    const overviewPitch = Math.atan2(overview.position.y, Math.hypot(overviewX, overviewZ))
    const yawDelta = Math.atan2(
      Math.sin(Math.atan2(overviewX, overviewZ) - input.yaw),
      Math.cos(Math.atan2(overviewX, overviewZ) - input.yaw),
    )
    const candidate = (blend: number) => computeFactoryFrame({
      ...input,
      distance,
      pitch: input.pitch + (overviewPitch - input.pitch) * blend,
      yaw: input.yaw + yawDelta * blend,
      targetX: input.targetX + (overview.target.x - input.targetX) * blend,
      targetZ: input.targetZ + (overview.target.z - input.targetZ) * blend,
    })
    let low = 0
    let high = 1
    frame = candidate(high)
    for (let step = 0; step < 12; step += 1) {
      const middle = (low + high) / 2
      const next = candidate(middle)
      if (next.maxDistance >= distance) {
        high = middle
        frame = next
      } else {
        low = middle
      }
    }
  }
  controls.minDistance = frame.minDistance
  controls.maxDistance = Math.max(frame.maxDistance, overview?.maxDistance ?? 0)
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
