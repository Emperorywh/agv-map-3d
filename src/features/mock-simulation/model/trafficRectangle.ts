/**
 * Mock 交通矩形生成（SPEC §9.3「交通矩形根据占用路径生成，输出前使用 §5.3
 * 的规范化点序」；TASK-009）。
 *
 * 职责：把车辆在占用路径上的切线朝向（theta）与车体尺寸换算为 8 数值凸
 *       四边形负载（[x1,y1,x2,y2,x3,y3,x4,y4]，与真实夹具
 *       trafficShapeResources 的扁平数组形态同构），并按「locked 最紧、
 *       applying 逐级外扩」生成交通等待车辆的上报矩形组。
 * 边界：纯几何函数——不访问仿真内核、不参与交通调度；本模块只保证「输出
 *       点序恒为无自交凸四边形、数值恒有限」，消费端的统一规范化校验（去
 *       重、极角排序、凸性与面积裁决）归 TASK-012 的交通资源入口。
 * 关键不变量：
 * 1. 四角按同一绕向生成（车头左侧 → 车尾左侧 → 车尾右侧 → 车头右侧），
 *    对任意有限输入都是简单凸四边形，绝不产生自交或重复点序；
 * 2. 输入坐标与角度有限时输出 8 个有限数值；朝向取占用路径切线角（即车辆
 *    theta），矩形随车辆沿路径运动，语义为「当前占用路段的动态包络」。
 */

/** 车辆几何中心与朝向（地图坐标；theta 为占用路径切线角，弧度） */
export interface TrafficQuadAnchor {
  readonly x: number
  readonly y: number
  readonly theta: number
}

/** locked 矩形在车体半尺寸外追加的裕量（米）：略大于车体 footprint */
export const TRAFFIC_LOCKED_MARGIN_M = 0.05

/** applying 矩形相对 locked 的第一级外扩（米） */
export const TRAFFIC_APPLYING_STEP_ONE_M = 0.6

/** applying 矩形相对 locked 的第二级外扩（米） */
export const TRAFFIC_APPLYING_STEP_TWO_M = 1.4

/** 四角生成序：along 为车头方向分量符号，side 为左法线方向分量符号 */
const CORNER_SIGNS: ReadonlyArray<readonly [along: number, side: number]> = [
  [1, 1],
  [-1, 1],
  [-1, -1],
  [1, -1],
]

/**
 * 生成一个按朝向对齐的凸四边形（8 个有限数值，顺序恒定）。
 * 车头方向单位向量为 (cosθ, sinθ)，左法线为 (-sinθ, cosθ)；每个角由
 * 「沿车头 ±halfLength、沿法线 ±halfWidth」线性组合而成。
 */
export function buildPathAlignedQuad(
  anchor: TrafficQuadAnchor,
  halfLength: number,
  halfWidth: number,
): number[] {
  const cos = Math.cos(anchor.theta)
  const sin = Math.sin(anchor.theta)
  const corners: number[] = []
  for (const [along, side] of CORNER_SIGNS) {
    corners.push(
      anchor.x + cos * halfLength * along - sin * halfWidth * side,
      anchor.y + sin * halfLength * along + cos * halfWidth * side,
    )
  }
  return corners
}

export interface TrafficRectanglesOptions {
  /** 车体半长（米）；调用方传 dimension.length / 2 */
  halfLength: number
  /** 车体半宽（米）；调用方传 dimension.width / 2 */
  halfWidth: number
}

export interface TrafficRectangles {
  /** locked 矩形数组（当前 1 个：车体 footprint 加最小裕量） */
  readonly locked: number[][]
  /** applying 矩形数组（当前 2 个：逐级外扩的候选占用区） */
  readonly applying: number[][]
}

/**
 * 生成交通等待车辆的完整矩形组：locked 1 个（最紧）、applying 2 个（逐级
 * 外扩），形态与真实夹具「applying 大于 locked」一致。
 */
export function buildTrafficRectangles(
  anchor: TrafficQuadAnchor,
  options: TrafficRectanglesOptions,
): TrafficRectangles {
  const lockedHalfLength = options.halfLength + TRAFFIC_LOCKED_MARGIN_M
  const lockedHalfWidth = options.halfWidth + TRAFFIC_LOCKED_MARGIN_M
  return {
    locked: [buildPathAlignedQuad(anchor, lockedHalfLength, lockedHalfWidth)],
    applying: [
      buildPathAlignedQuad(
        anchor,
        lockedHalfLength + TRAFFIC_APPLYING_STEP_ONE_M,
        lockedHalfWidth + TRAFFIC_APPLYING_STEP_ONE_M,
      ),
      buildPathAlignedQuad(
        anchor,
        lockedHalfLength + TRAFFIC_APPLYING_STEP_TWO_M,
        lockedHalfWidth + TRAFFIC_APPLYING_STEP_TWO_M,
      ),
    ],
  }
}
