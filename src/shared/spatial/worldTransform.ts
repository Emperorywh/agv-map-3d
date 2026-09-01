/**
 * 平面坐标 → Three.js 世界坐标映射（SPEC §2.5；TASK-003）。
 *
 * 职责：在仿射后的平面坐标上减去固定原点得到世界 (x, z)（世界 y 恒 0），
 *       并提供「平面数学角 → 世界 rotation.y」的唯一符号换算点。
 * 边界：原点由调用方（地图建模层）以「地图包围盒中心」计算后只传入一次；
 *       本模块不感知地图数据、车辆、交通资源或运行时配置。
 * 关键不变量：
 * 1. worldX = 平面x - originX、worldZ = 平面y - originY；世界 y 恒为 0，
 *    不在返回值中冗余表达；
 * 2. 地图与车辆使用数学平面角（0 指向 +x，逆时针为正），而 Three.js 绕 +y
 *    的正旋转让 +x 转向 -z，因此 rotation.y = -平面角；该符号只在此处翻转，
 *    任何业务模块不得自行再加负号；
 * 3. 原点在地图加载期间只确定一次，车辆到达顺序不得改变原点——该不变量由
 *    createMapModel 保证（原点只来自节点包围盒中心），本模块负责不再变化。
 */
import type { PlanePoint, PlaneTransform } from './affine'

/** 世界坐标中的地面点（世界 y 恒为 0） */
export interface WorldPoint {
  x: number
  z: number
}

export interface WorldTransform {
  /** 世界原点在仿射后平面坐标系中的位置（地图 bounds 中心） */
  readonly origin: PlanePoint
  /** 原始地图平面坐标 → 世界地面坐标（内部先做仿射，再减原点） */
  toWorldXZ(x: number, y: number): WorldPoint
  /** 地图平面数学角 → Three.js rotation.y（恒为平面角的相反数） */
  angleToWorldYRotation(theta: number): number
}

export function createWorldTransform(plane: PlaneTransform, origin: PlanePoint): WorldTransform {
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) {
    throw new RangeError('世界原点必须为有限平面坐标')
  }
  const frozenOrigin: PlanePoint = { x: origin.x, y: origin.y }
  return {
    origin: frozenOrigin,
    toWorldXZ(x, y) {
      const p = plane.transformPoint(x, y)
      return { x: p.x - frozenOrigin.x, z: p.y - frozenOrigin.y }
    },
    angleToWorldYRotation(theta) {
      return -plane.transformAngle(theta)
    },
  }
}
