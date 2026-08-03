/**
 * 坐标系与朝向映射（SPEC §4.1、§4.2）。
 *
 * 1 世界单位 = 1 米；地面为 XZ 平面，+Y 向上。
 * 数据坐标系为数学系：x 向东，y 向北（y 增大 = 北）。
 *
 * world.x = map.x
 * world.y = 0（地面高度，各层偏移见 §4.3）
 * world.z = -map.y   ← 取反保证俯视时北在上；该取反全项目唯一出处为本文件，
 *                      其他模块不得散写取反逻辑。
 */

/** 世界坐标点（y 恒为地面高度 0，由调用方叠加 §4.3 层偏移） */
export interface WorldPoint {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** 数据坐标 (x, y) → 世界坐标 (x, 0, -y)；贝塞尔控制点同样适用 */
export function mapToWorld(mapX: number, mapY: number): WorldPoint {
  return { x: mapX, y: 0, z: mapY === 0 ? 0 : -mapY }
}

/** 世界坐标 XZ → 数据坐标 (x, y)：mapToWorld 的逆映射（往返不变量） */
export function worldToMap(worldX: number, worldZ: number): { readonly x: number; readonly y: number } {
  return { x: worldX, y: worldZ === 0 ? 0 : -worldZ }
}

const TWO_PI = Math.PI * 2

/**
 * 弧度规范化到 [-π, π)（§3.3 angle 规则）。
 * 返回值消除 -0，保证 [-π, π) 内的规范正零。
 */
export function normalizeMapAngle(angle: number): number {
  let normalized = angle % TWO_PI
  if (normalized < -Math.PI) {
    normalized += TWO_PI
  } else if (normalized >= Math.PI) {
    normalized -= TWO_PI
  }
  return normalized + 0
}

/**
 * 数据朝向角 → 世界 yaw。
 * 数据朝向单位向量 (cosθ, sinθ) → 世界方向 (cosθ, 0, -sinθ)，
 * 与 +X 前向几何体经 rotation.y = θ 旋转后的朝向完全一致（§4.2 结论），
 * 因此 yaw 直接取数据角 θ。领域模型中的 angle 已规范化到 [-π, π)。
 */
export function yawFromMapAngle(angle: number): number {
  return angle
}
