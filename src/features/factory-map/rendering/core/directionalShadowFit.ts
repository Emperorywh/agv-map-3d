/**
 * 平行光正交 shadow camera 推导纯函数（SPEC §6.6 阴影行）。
 *
 * - 太阳方向固定为 normalize(0.5, 1, 0.35)（与 §6.5 Sky sunPosition 同源，
 *   复用 scene/exterior/exteriorGeometry 的 sunDirection，单一出处）；
 * - light target = 厂房中心（Y=0），light position = target + direction × 300m；
 * - 把厂房三维结构 bounds（min y=0、max y=STRUCTURE_MAX_Y=9.0，含主梁/檩条顶部）
 *   的 8 个角转换到 light-view 空间，按投影 min/max 加 20m padding 设置正交
 *   shadow camera 的 left/right/top/bottom；near/far 由 8 角的 light-view
 *   深度范围推导（结构是唯一的阴影投射集合，深度区间不额外外扩，保持深度精度）。
 *
 * light-view 基与 three 相机 lookAt(eye=lightPosition, target, up=(0,1,0)) 同约定：
 * zAxis = normalize(eye - target)（即太阳方向）、xAxis = normalize(cross(up, zAxis))、
 * yAxis = cross(zAxis, xAxis)。three DirectionalLightShadow 正是以该约定摆放
 * shadow camera，因此本函数给出的视锥可直接写入 light.shadow.camera。
 *
 * 本模块为 rendering/core 纯函数：无 React/DOM 依赖、无逐次分配。
 */

import type { FactoryBoundsDto } from '../../application/factorySceneModel'
import { STRUCTURE_MAX_Y } from '../../config/sceneMetrics'
import { sunDirection } from '../scene/exterior/exteriorGeometry'

/** 平行光与厂房中心的距离（§6.6：position = target + direction × 300m） */
export const SUN_LIGHT_DISTANCE = 300

/** shadow camera 投影 min/max 外扩量（§6.6：20m padding） */
export const SHADOW_CAMERA_PADDING = 20

/** 正交 shadow camera 视锥（写入 light.shadow.camera 后须 updateProjectionMatrix） */
export interface ShadowCameraFrustum {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
  readonly near: number
  readonly far: number
}

/** 平行光阴影布置：灯光位置/目标与正交 shadow camera 视锥 */
export interface DirectionalShadowSetup {
  /** 平行光位置：厂房中心 + 太阳方向 × 300m */
  readonly lightPosition: readonly [number, number, number]
  /** 平行光 target：厂房中心，Y=0 */
  readonly lightTarget: readonly [number, number, number]
  readonly camera: ShadowCameraFrustum
}

/**
 * 按厂房三维 bounds 推导平行光位置与正交 shadow camera 视锥（§6.6）。
 *
 * @param bounds 厂房内空边界（§6.1，世界坐标）
 */
export function fitDirectionalShadowCamera(bounds: FactoryBoundsDto): DirectionalShadowSetup {
  const [dirX, dirY, dirZ] = sunDirection()
  const targetX = bounds.centerX
  const targetZ = bounds.centerZ
  const eyeX = targetX + dirX * SUN_LIGHT_DISTANCE
  const eyeY = dirY * SUN_LIGHT_DISTANCE
  const eyeZ = targetZ + dirZ * SUN_LIGHT_DISTANCE

  // light-view 正交基（three lookAt(up=(0,1,0)) 同约定）
  // zAxis = 太阳方向（单位向量）；xAxis = normalize(cross((0,1,0), zAxis)) = (dirZ, 0, -dirX)/|xz|
  const xAxisLen = Math.hypot(dirZ, dirX)
  const xAxisX = dirZ / xAxisLen
  const xAxisZ = -dirX / xAxisLen
  // yAxis = cross(zAxis, xAxis)（xAxis.y=0）
  const yAxisX = dirY * xAxisZ
  const yAxisY = dirZ * xAxisX - dirX * xAxisZ
  const yAxisZ = -dirY * xAxisX

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let minDepth = Infinity
  let maxDepth = -Infinity
  for (const cornerX of [bounds.innerMinX, bounds.innerMaxX]) {
    for (const cornerY of [0, STRUCTURE_MAX_Y]) {
      for (const cornerZ of [bounds.innerMinZ, bounds.innerMaxZ]) {
        const relX = cornerX - eyeX
        const relY = cornerY - eyeY
        const relZ = cornerZ - eyeZ
        const viewX = relX * xAxisX + relZ * xAxisZ
        const viewY = relX * yAxisX + relY * yAxisY + relZ * yAxisZ
        // 相机前方深度 = -dot(rel, zAxis)（8 角恒在光前方，depth > 0）
        const depth = -(relX * dirX + relY * dirY + relZ * dirZ)
        if (viewX < minX) minX = viewX
        if (viewX > maxX) maxX = viewX
        if (viewY < minY) minY = viewY
        if (viewY > maxY) maxY = viewY
        if (depth < minDepth) minDepth = depth
        if (depth > maxDepth) maxDepth = depth
      }
    }
  }

  return {
    lightPosition: [eyeX, eyeY, eyeZ],
    lightTarget: [targetX, 0, targetZ],
    camera: {
      left: minX - SHADOW_CAMERA_PADDING,
      right: maxX + SHADOW_CAMERA_PADDING,
      bottom: minY - SHADOW_CAMERA_PADDING,
      top: maxY + SHADOW_CAMERA_PADDING,
      near: minDepth,
      far: maxDepth,
    },
  }
}
