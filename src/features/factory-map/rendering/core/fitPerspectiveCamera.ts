/**
 * 初始机位三维视锥 fit 纯函数（SPEC §9.1）。
 *
 * - fit 对象是厂房三维包围盒 min=(innerMinX, 0, innerMinZ)、max=(innerMaxX, STRUCTURE_MAX_Y,
 *   innerMaxZ)（9.0m 含主梁与檩条顶部），不是二维宽深；
 * - target=(centerX, 0, centerZ)，相机位于南侧、目标观察方向固定为 45° 俯角；
 * - 对 8 个角分别计算 requiredH/requiredV 取最大值，再乘 CAMERA_FIT_MARGIN（1.15）余量；
 *   近侧深度对水平视锥的影响计入距离，禁止退回
 *   max(halfW/tan(hHalf), halfD/tan(vHalf)) 的二维公式（基准数据会横向越界约 20%）。
 *
 * 本模块为 rendering/core 纯函数：无 React 依赖；fov/near/far/余量与结构高度取自
 * config 层固定值（§13.1、§13.3）。
 */

import type { FactoryBoundsDto } from '../../application/factorySceneModel'
import {
  CAMERA_FAR,
  CAMERA_FIT_MARGIN,
  CAMERA_FOV,
  CAMERA_NEAR,
} from '../../config/cameraConfig'
import { STRUCTURE_MAX_Y } from '../../config/sceneMetrics'

/** 初始机位 fit 结果；CameraRig 据此配置 PerspectiveCamera（先设 up 再 lookAt(target)） */
export interface PerspectiveCameraFit {
  /** 相机位置：target - forward × distance（南侧高位 45° 俯视） */
  readonly position: readonly [number, number, number]
  /** 观察目标：厂房内空中心，Y 恒为 0 */
  readonly target: readonly [number, number, number]
  /** 相机 up 向量 cross(right, forward)；lookAt 前必须设置，否则画面带滚转、fit 失效 */
  readonly up: readonly [number, number, number]
  /** target 到相机的距离（含 CAMERA_FIT_MARGIN 余量） */
  readonly distance: number
  /** PerspectiveCamera 视场角（§13.3：46°） */
  readonly fov: number
  /** 近裁剪面（§13.3：0.1m） */
  readonly near: number
  /** 远裁剪面（§13.3：2000m） */
  readonly far: number
  /** 本次 fit 使用的视口宽高比 */
  readonly aspect: number
}

const DEG_TO_RAD = Math.PI / 180

// §9.1 固定观察基：forward = normalize(0, -sin45°, -cos45°)；sin45°=cos45°=√2/2，
// (0, -√2/2, -√2/2) 已是单位向量
const FORWARD_Y = -Math.SQRT1_2
const FORWARD_Z = -Math.SQRT1_2
// right = (1, 0, 0)；up = cross(right, forward) = (0, √2/2, -√2/2)
const UP_Y = Math.SQRT1_2
const UP_Z = -Math.SQRT1_2

/**
 * §9.1 三维视锥 fit：厂房三维包围盒 8 角全部入画的最短距离 × 1.15 余量。
 *
 * @param bounds 厂房内空边界（§6.1，世界坐标）
 * @param aspect 视口宽高比（width / height），必须是正的有限数值
 * @throws RangeError aspect 非正或非有限（视口高度为 0 等调用方错误）
 */
export function fitPerspectiveCamera(
  bounds: FactoryBoundsDto,
  aspect: number,
): PerspectiveCameraFit {
  if (!Number.isFinite(aspect) || aspect <= 0) {
    throw new RangeError(`视口宽高比必须是正的有限数值，实际为 ${aspect}`)
  }

  const vHalf = (CAMERA_FOV / 2) * DEG_TO_RAD
  const tanV = Math.tan(vHalf)
  const tanH = tanV * aspect // hHalf = atan(tan(vHalf) × aspect) 的正切值

  let required = 0
  for (const x of [bounds.innerMinX, bounds.innerMaxX]) {
    for (const y of [0, STRUCTURE_MAX_Y]) {
      for (const z of [bounds.innerMinZ, bounds.innerMaxZ]) {
        // q = corner - target，target = (centerX, 0, centerZ)
        const qx = x - bounds.centerX
        const qy = y
        const qz = z - bounds.centerZ
        const dotF = qy * FORWARD_Y + qz * FORWARD_Z // dot(q, forward)，forward.x = 0
        const dotR = qx // dot(q, right)，right = (1, 0, 0)
        const dotU = qy * UP_Y + qz * UP_Z // dot(q, up)，up.x = 0
        const requiredH = Math.abs(dotR) / tanH - dotF
        const requiredV = Math.abs(dotU) / tanV - dotF
        if (requiredH > required) required = requiredH
        if (requiredV > required) required = requiredV
      }
    }
  }

  const distance = required * CAMERA_FIT_MARGIN
  return {
    // camera.position = target - forward × dist
    position: [bounds.centerX, -FORWARD_Y * distance, bounds.centerZ - FORWARD_Z * distance],
    target: [bounds.centerX, 0, bounds.centerZ],
    up: [0, UP_Y, UP_Z],
    distance,
    fov: CAMERA_FOV,
    near: CAMERA_NEAR,
    far: CAMERA_FAR,
    aspect,
  }
}
