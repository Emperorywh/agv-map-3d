/**
 * 相机地面约束：在轨道控制完成位移后，直接约束最终世界坐标与观察方向。
 * 极角和到目标的距离都不能代表离地高度；这里同时保护相机与近裁剪面，
 * 并保留轨道距离上限。函数不调用 controls.update，避免 change 事件递归。
 */
import type { PerspectiveCamera } from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { MAP_GROUND_TOP_Y } from '@/features/map-visualization'

/**
 * 相机相对最高地面图层至少保留 0.25 米净空，仍允许近距离观察节点。
 * 另留毫米级余量，避免俯视到极限时球坐标浮点误差反复触发边界修正。
 */
const GROUND_CLEARANCE_M = 0.25
const BOUNDARY_MARGIN_M = 0.001

/**
 * 将相机收敛到地面上方；返回是否修正，供调用方同步车辆跟随偏移。
 * 近景优先收紧俯角，只有距离不足以容纳离地高度时才增大最小观察距离；
 * 这使连续缩放最终停在安全范围内，不会从路面或节点的下方观察地图。
 */
export function constrainCameraToGround(
  camera: PerspectiveCamera,
  controls: OrbitControls,
): boolean {
  /**
   * 用近裁剪面角点到相机的距离作为包络球半径，覆盖任意俯角和视口宽高比。
   * 即使调整了视场角、缩放或近裁剪距离，整个近裁剪面也不能切入地面图层。
   */
  const halfHeightRatio = Math.tan(camera.fov * Math.PI / 360) / camera.zoom
  const nearRadius = camera.near * Math.hypot(1, halfHeightRatio, halfHeightRatio * camera.aspect)
  const minHeight = MAP_GROUND_TOP_Y + Math.max(GROUND_CLEARANCE_M, nearRadius + BOUNDARY_MARGIN_M)
  const minDistance = Math.max(controls.minDistance, minHeight + BOUNDARY_MARGIN_M)
  const maxDistance = Math.max(controls.maxDistance, minDistance)
  const target = controls.target
  const dx = camera.position.x - target.x
  const dz = camera.position.z - target.z
  const currentHeight = camera.position.y
  const currentDistance = Math.hypot(dx, currentHeight, dz)
  const minPolarCos = Math.cos(controls.maxPolarAngle)

  /**
   * 正常帧不写相机矩阵，也不分配临时向量；目标高度以地图的 y=0 统一计算。
   * 除了离地高度，还检查光标定点位移后可能越过的距离和极角边界。
   */
  if (
    target.y === 0 &&
    currentHeight >= minHeight &&
    currentDistance >= minDistance &&
    currentDistance <= maxDistance &&
    currentHeight >= currentDistance * minPolarCos
  ) {
    return false
  }

  const distance = Math.max(minDistance, Math.min(maxDistance, currentDistance))
  const heightAtDistance = currentDistance > 0 ? currentHeight / currentDistance * distance : distance
  const horizontalDistance = Math.hypot(dx, dz)
  /**
   * 相机恰好位于目标正上方或正下方时，没有可保留的水平方位。
   * 直接回到安全的正上方，避免零水平偏移导致实际轨道距离小于修正值。
   */
  const nextHeight = horizontalDistance > 0
    ? Math.min(distance, Math.max(minHeight, distance * minPolarCos, heightAtDistance))
    : distance
  const nextHorizontalDistance = Math.sqrt(Math.max(0, distance * distance - nextHeight * nextHeight))
  const horizontalScale = horizontalDistance > 0 ? nextHorizontalDistance / horizontalDistance : 0

  /**
   * 抬高相机时同步收缩水平偏移，保持修正后的轨道距离不超过上限。
   * 同步朝向与世界矩阵，避免画面已抬高但拾取或下一次光标射线仍使用旧姿态。
   */
  target.y = 0
  camera.position.set(target.x + dx * horizontalScale, nextHeight, target.z + dz * horizontalScale)
  camera.lookAt(target)
  camera.updateMatrixWorld()
  return true
}
