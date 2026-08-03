/**
 * 地图包围盒与厂房内空边界（SPEC §6.1）。
 *
 * bbox 取节点坐标、路径端点与贝塞尔控制点的联合 min/max（数据坐标）；
 * 厂房内空 = bbox 四周各外扩 margin（v1 固定 FACTORY_MARGIN=10m，定义在
 * config/sceneMetrics.ts，由调用方传入——domain 不依赖 config 层）。
 *
 * innerMinX/innerMinZ 是厂房内边界的世界坐标，不是地图平移量；
 * 地图世界坐标不再二次平移。
 */

import { mapToWorld } from './coordinates'
import type { FactoryMap } from './factoryMap'

/** 数据坐标系下的地图包围盒（不可变值对象） */
export interface MapBounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

/** 厂房内空边界（世界坐标，不可变值对象） */
export interface FactoryBounds {
  readonly innerMinX: number
  readonly innerMaxX: number
  readonly innerMinZ: number
  readonly innerMaxZ: number
  readonly centerX: number
  readonly centerZ: number
  readonly innerWidth: number
  readonly innerDepth: number
}

/** 空态厂房尺寸（§6.1：nodes 与 edges 同时为空时使用，只服务空态展示） */
export const EMPTY_FACTORY_WIDTH = 60
export const EMPTY_FACTORY_DEPTH = 40

/**
 * 计算地图 bbox：节点坐标 + 路径端点 + 贝塞尔控制点的联合 min/max（数据坐标）。
 * 地图无任何几何时返回 null（空态）。
 */
export function computeMapBounds(map: FactoryMap): MapBounds | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  const include = (x: number, y: number): void => {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  for (const node of map.nodes) {
    include(node.x, node.y)
  }
  for (const edge of map.edges) {
    include(edge.sx, edge.sy)
    include(edge.ex, edge.ey)
    // LINE 控制点由领域不变量保证全为 null，不参与 bbox；BEZIER 全为有限数值
    if (edge.edgeType === 'BEZIER') {
      include(edge.cx, edge.cy)
      include(edge.dx, edge.dy)
    }
  }

  if (minX > maxX) return null
  return Object.freeze({ minX, minY, maxX, maxY })
}

/**
 * 由地图 bbox 推导厂房内空边界（§6.1）：
 *   innerMinX = minX - margin
 *   innerMaxX = maxX + margin
 *   innerMinZ = -maxY - margin
 *   innerMaxZ = -minY + margin
 * mapBounds 为 null（空态）时使用 60m × 40m 空场景尺寸，居中于原点。
 */
export function deriveFactoryBounds(mapBounds: MapBounds | null, margin: number): FactoryBounds {
  if (mapBounds === null) {
    const halfWidth = EMPTY_FACTORY_WIDTH / 2
    const halfDepth = EMPTY_FACTORY_DEPTH / 2
    return Object.freeze({
      innerMinX: -halfWidth,
      innerMaxX: halfWidth,
      innerMinZ: -halfDepth,
      innerMaxZ: halfDepth,
      centerX: 0,
      centerZ: 0,
      innerWidth: EMPTY_FACTORY_WIDTH,
      innerDepth: EMPTY_FACTORY_DEPTH,
    })
  }

  const innerMinX = mapBounds.minX - margin
  const innerMaxX = mapBounds.maxX + margin
  // 数据 y 范围经 mapToWorld 映射为世界 z 范围（y 取反唯一定义在 coordinates.ts）：
  // y ∈ [minY, maxY] → z ∈ [-maxY, -minY]，再四周外扩 margin
  const innerMinZ = mapToWorld(0, mapBounds.maxY).z - margin
  const innerMaxZ = mapToWorld(0, mapBounds.minY).z + margin
  return Object.freeze({
    innerMinX,
    innerMaxX,
    innerMinZ,
    innerMaxZ,
    centerX: (innerMinX + innerMaxX) / 2,
    centerZ: (innerMinZ + innerMaxZ) / 2,
    innerWidth: innerMaxX - innerMinX,
    innerDepth: innerMaxZ - innerMinZ,
  })
}
