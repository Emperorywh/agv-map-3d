/**
 * OrbitControls target 夹取纯函数（SPEC §9.2 target 夹取行、§10.1 稳态无分配）。
 *
 * 每次 change 后强制执行：target XZ 夹取到厂房内边界外扩
 * ORBIT_TARGET_CLAMP_MARGIN（20m，取自 config 层 §13.3），Y 恒为 0——
 * 无论当前 target.y 为何，输出 Y 一律写 0，故入参只需 XZ。
 *
 * out 由调用方预分配（相机/夹取计算禁止逐帧创建临时数组）；本模块为
 * rendering/core 纯函数：无 React/Three/DOM 依赖。
 */

import type { FactoryBoundsDto } from '../../application/factorySceneModel'
import { ORBIT_TARGET_CLAMP_MARGIN } from '../../config/cameraConfig'

/**
 * 把 OrbitControls target 夹取到合法区域，结果写入预分配的 out。
 *
 * @param bounds 厂房内空边界（§6.1，世界坐标）
 * @param targetX 当前 target.x
 * @param targetZ 当前 target.z（target.y 不读取：输出 Y 恒为 0）
 * @param out 预分配的三元组，写入 [clampedX, 0, clampedZ]
 */
export function clampOrbitTarget(
  bounds: FactoryBoundsDto,
  targetX: number,
  targetZ: number,
  out: [number, number, number],
): void {
  const minX = bounds.innerMinX - ORBIT_TARGET_CLAMP_MARGIN
  const maxX = bounds.innerMaxX + ORBIT_TARGET_CLAMP_MARGIN
  const minZ = bounds.innerMinZ - ORBIT_TARGET_CLAMP_MARGIN
  const maxZ = bounds.innerMaxZ + ORBIT_TARGET_CLAMP_MARGIN
  out[0] = Math.min(Math.max(targetX, minX), maxX)
  out[1] = 0
  out[2] = Math.min(Math.max(targetZ, minZ), maxZ)
}
