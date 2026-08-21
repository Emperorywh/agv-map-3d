/**
 * 坐标系与校准（SPEC §4.3）——全仓唯一的 z 轴翻转 / 校准 / 朝向换算收口模块。
 *
 * 约定：地图坐标单位视为米，世界坐标系为 three.js 默认右手系（Y 向上）；
 * 地图 2D 的 y 向上对应世界 -z。除本模块外，任何代码不得自行对 z 取反或换算朝向角。
 *
 * 地图 → 世界通用变换（先在地图平面内缩放旋转，再 y → -z，最后平移）：
 *   wx = s·(x·cosθ - y·sinθ) - ox
 *   wz = -[s·(x·sinθ + y·cosθ) - oy]
 * 当前 normalize 输出 θ=0、s=1，退化为 (x - ox, 0, -(y - oy))。
 */

import type { Calibration, MapPoint } from './types'

/** 世界坐标点（three.js 右手系，Y 向上） */
export interface WorldPoint {
  x: number
  y: number
  z: number
}

/** 地图平面点 → 世界坐标（y 恒为 0，地面平面） */
export function mapToWorld(point: MapPoint, calibration: Calibration): WorldPoint {
  const { scale, rotationRad, offsetX, offsetY } = calibration
  const cos = Math.cos(rotationRad)
  const sin = Math.sin(rotationRad)
  const mx = scale * (point.x * cos - point.y * sin) - offsetX
  const my = scale * (point.x * sin + point.y * cos) - offsetY
  return { x: mx, y: 0, z: -my }
}

/** 世界地面点（取 x / z）→ 地图平面点，mapToWorld 的逆变换 */
export function worldToMap(world: { x: number; z: number }, calibration: Calibration): MapPoint {
  const { scale, rotationRad, offsetX, offsetY } = calibration
  const cos = Math.cos(rotationRad)
  const sin = Math.sin(rotationRad)
  // a = s·(x·cosθ - y·sinθ)，b = s·(x·sinθ + y·cosθ)，再左乘旋转逆矩阵并除以 s
  const a = world.x + offsetX
  const b = offsetY - world.z
  return {
    x: (a * cos + b * sin) / scale,
    y: (-a * sin + b * cos) / scale,
  }
}

/**
 * 地图朝向角 → three.js `rotation.y`（世界 yaw）。
 *
 * 地图朝向角为弧度（0 = 地图 +x，逆时针为正，SPEC §4.1）；资产约定 +Z 为正面（SPEC §5.4）。
 * 朝向向量 (cosα, sinα) 经 y → -z 翻转后为世界 (cosα, 0, -sinα)；
 * three 中 rotation.y = β 时 +Z 前向为 (sinβ, 0, cosβ)，
 * 令两者相等得 β = α + θ + π/2（θ 为校准旋转角）。
 */
export function headingToWorldYaw(headingRad: number, calibration: Calibration): number {
  return headingRad + calibration.rotationRad + Math.PI / 2
}
