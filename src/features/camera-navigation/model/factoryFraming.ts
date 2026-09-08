/**
 * 室内视锥约束：画面下沿落在地坪，上沿允许由远侧墙体收口。
 * 使用墙顶以下的安全截面计算包络，保留围合关系，同时避免镜头穿出厂房。
 */
import type { FactoryLayout } from '@/features/map-visualization'

/**
 * 最近观察距离放宽到三米，便于放大查看车辆与设备细节。
 * 自由浏览与车辆跟随共用此下限，离地净空仍由地面约束保护。
 * 极小地图或狭长视口若无法容纳该距离，优先保证完整画面仍落在厂房内。
 */
export const CAMERA_MIN_DISTANCE_M = 1
/**
 * 左键旋转最低俯角放宽到二十五度，允许观察设备侧面和厂房纵深。
 * 默认监控采用三十八度，让远墙与地坪共同提供纵深，仍可手动切换高位总览。
 */
export const CAMERA_MIN_PITCH_RAD = 25 * Math.PI / 180
export const CAMERA_MAX_PITCH_RAD = 85 * Math.PI / 180
export const CAMERA_MONITOR_PITCH_RAD = 38 * Math.PI / 180
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
   * 高位总览逐渐允许画布显示厂房外轮廓，超宽屏也能完整容纳真实地图。
   * 常规监控仍由墙地封闭取景；过渡连续，不在某个角度突然跳动镜头。
   */
  const overviewProgress = Math.max(0, Math.min(1, (pitch - Math.PI / 3) / (Math.PI / 12)))
  const coverage = 1 - overviewProgress * overviewProgress * (3 - 2 * overviewProgress)

  /**
   * 上沿射线可以先击中墙面，不再强迫它们在墙前落到地面。
   * 预留半米墙顶余量；镜头低于墙顶时从镜头高度截断，避免向后外推射线。
   */
  const rays: { x: number; y: number; z: number; upper: boolean }[] = []
  for (const screenX of [-1, 1]) {
    for (const screenY of [-1, 1]) {
      const rayX = -offsetX + screenX * tanH * cosYaw - screenY * tanV * sinPitch * sinYaw
      const rayY = -sinPitch + screenY * tanV * cosPitch
      const rayZ = -offsetZ - screenX * tanH * sinYaw - screenY * tanV * sinPitch * cosYaw
      rays.push({ x: rayX, y: Math.min(rayY, -0.000001), z: rayZ, upper: screenY > 0 })
    }
  }
  const bounds = layout.bounds
  const inset = layout.config.cameraEdgeInsetM
  const left = bounds.minWorldX + inset
  const right = bounds.maxWorldX - inset
  const top = bounds.minWorldZ + inset
  const bottom = bounds.maxWorldZ - inset
  let targetX = Math.max(left, Math.min(right, input.targetX))
  let targetZ = Math.max(top, Math.min(bottom, input.targetZ))
  /**
   * 截面包络随距离单调扩张，用有界二分求允许的最远观察距离。
   * 跟随模式额外固定目标点，极端宽高比和小地图仍得到有限、可行的相机位置。
   */
  const envelope = (distance: number) => {
    const cx = offsetX * distance
    const cz = offsetZ * distance
    const cy = sinPitch * distance
    let minX = Math.min(0, cx)
    let maxX = Math.max(0, cx)
    let minZ = Math.min(0, cz)
    let maxZ = Math.max(0, cz)
    for (const ray of rays) {
      const height = ray.upper ? Math.min(cy, layout.config.wallHeightM - 0.5) : 0
      const reach = (height - cy) / ray.y
      const x = cx + ray.x * reach * coverage
      const z = cz + ray.z * reach * coverage
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)
    }
    return { minX, maxX, minZ, maxZ }
  }
  let lower = 0
  let upper = layout.bounds.diagonal / Math.max(Math.min(tanV, tanH), 0.001) + layout.config.wallHeightM
  for (let step = 0; step < 24; step += 1) {
    const middle = (lower + upper) / 2
    const e = envelope(middle)
    const fits = e.maxX - e.minX <= right - left && e.maxZ - e.minZ <= bottom - top
    if (fits) lower = middle
    else upper = middle
  }
  const freeMaxDistance = Math.max(0.001, lower * 0.995)
  const minDistance = Math.min(CAMERA_MIN_DISTANCE_M, freeMaxDistance)
  /**
   * 贴边跟随先缩近；若固定目标无法保持离地净空，允许轻微移动观察中心。
   * 最小距离沿用自由取景的可行范围，避免厂房约束把相机重新压到地面以下。
   */
  if (input.keepTarget) {
    lower = 0
    upper = freeMaxDistance
    for (let step = 0; step < 24; step += 1) {
      const middle = (lower + upper) / 2
      const e = envelope(middle)
      const fits = targetX + e.minX >= left && targetX + e.maxX <= right && targetZ + e.minZ >= top && targetZ + e.maxZ <= bottom
      if (fits) lower = middle
      else upper = middle
    }
  }
  const maxDistance = input.keepTarget ? Math.max(minDistance, lower * 0.995) : freeMaxDistance
  const distance = Math.max(minDistance, Math.min(maxDistance, input.distance))
  const e = envelope(distance)
  targetX = Math.max(left - e.minX, Math.min(right - e.maxX, targetX))
  targetZ = Math.max(top - e.minZ, Math.min(bottom - e.maxZ, targetZ))
  return {
    target: { x: targetX, z: targetZ },
    position: { x: targetX + offsetX * distance, y: sinPitch * distance, z: targetZ + offsetZ * distance },
    minDistance,
    maxDistance,
    pitch,
  }
}
