/**
 * 外景几何与太阳方向（SPEC §6.5）。
 *
 * 纯函数、无 DOM：
 * - 室外地坪：以厂房中心为中心的 2000m×2000m 大平面，y=-0.02（§4.3 室外地坪层；
 *   0.3m 厚厂房地坪板压住它，不共面，无需 polygonOffset）；
 * - 太阳方向：normalize(0.5, 1, 0.35)——drei Sky 的 sunPosition，与 §6.6 平行光
 *   的 target→sun 方向向量同源（TASK-009 灯光复用本函数）。
 * 雾（THREE.Fog #D8E0E8 near 250 / far 1200）不是几何，由 ExteriorLayer 挂到 scene。
 */

import { BufferAttribute, BufferGeometry } from 'three'

import type { FactoryBoundsDto } from '../../../application/factorySceneModel'

/** 室外地坪边长（§6.5：2000m×2000m，未列入 §13 配置表，唯一定义于此） */
export const OUTDOOR_GROUND_SIZE = 2000

/** 室外地坪 y 偏移（§4.3：-0.02m） */
export const OUTDOOR_GROUND_Y = -0.02

/** §6.5/§6.6 固定太阳方向基准向量（未归一化） */
const SUN_DIRECTION_BASE_X = 0.5
const SUN_DIRECTION_BASE_Y = 1
const SUN_DIRECTION_BASE_Z = 0.35

/** normalize(0.5, 1, 0.35)：Sky sunPosition 与 §6.6 平行光方向 */
export function sunDirection(): readonly [number, number, number] {
  const length = Math.hypot(SUN_DIRECTION_BASE_X, SUN_DIRECTION_BASE_Y, SUN_DIRECTION_BASE_Z)
  return [
    SUN_DIRECTION_BASE_X / length,
    SUN_DIRECTION_BASE_Y / length,
    SUN_DIRECTION_BASE_Z / length,
  ]
}

/** 室外地坪：以厂房中心为中心的 2000×2000 平面（2 三角形，法线 +Y，y=-0.02） */
export function buildOutdoorGroundGeometry(bounds: FactoryBoundsDto): BufferGeometry {
  const half = OUTDOOR_GROUND_SIZE / 2
  const x0 = bounds.centerX - half
  const x1 = bounds.centerX + half
  const z0 = bounds.centerZ - half
  const z1 = bounds.centerZ + half

  // 与地坪顶面同一 +Y 绕序约定（从上方看逆时针）
  const positions = new Float32Array([
    x0, OUTDOOR_GROUND_Y, z0,
    x0, OUTDOOR_GROUND_Y, z1,
    x1, OUTDOOR_GROUND_Y, z1,
    x1, OUTDOOR_GROUND_Y, z0,
  ])
  const normals = new Float32Array([
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
  ])
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3])

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setIndex(new BufferAttribute(indices, 1))
  return geometry
}
