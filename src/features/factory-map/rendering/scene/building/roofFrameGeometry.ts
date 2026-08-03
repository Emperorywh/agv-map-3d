/**
 * 屋顶桁架几何：主梁 + 檩条（SPEC §6.4，不封顶）。
 *
 * 纯函数、无 DOM。简化钢梁网格，不表达真实结构受力，不做腹杆细节：
 * - 短跨 = min(innerWidth, innerDepth)（等宽平局取 Z 为短跨，确定性规则）：
 *   主梁沿短跨方向通长布置（梁长 = 短跨），沿长跨方向以 TRUSS_SPACING=8m 间距
 *   排布，截面 TRUSS_BEAM_WIDTH=0.35m(宽) × TRUSS_BEAM_HEIGHT=0.7m(高)，
 *   梁底标高 = WALL_HEIGHT(8m) → 梁中心 y = 8.35m；
 * - 檩条沿长跨方向通长布置（梁长 = 长跨），沿短跨方向以 PURLIN_SPACING=4m 间距
 *   排布，截面 PURLIN_WIDTH=0.15m × PURLIN_HEIGHT=0.3m，置于主梁顶
 *  （底标高 8.7m → 中心 y = 8.85m，顶标高 9.0m = STRUCTURE_MAX_Y）；
 * - 间距排布居中对称：n = max(1, floor(span / spacing))，两端等距留白
 *  （margin = (span - (n-1)·spacing) / 2 ≥ spacing/2，间距严格等于 8m / 4m）；
 * - 主梁与檩条各一个 InstancedMesh（实例矩阵为纯平移）；无屋面板、无室内立柱。
 */

import type { FactoryBoundsDto } from '../../../application/factorySceneModel'
import { PURLIN_SPACING, TRUSS_SPACING, WALL_HEIGHT } from '../../../config/sceneMetrics'
import type { InstanceGeometryBatch } from './buildingGeometry'
import { createBoxGeometry, writeTranslationMatrix } from './buildingGeometry'

/** 主梁截面宽（§6.4：0.35m，未列入 §13 配置表，唯一定义于此） */
export const TRUSS_BEAM_WIDTH = 0.35

/** 主梁截面高（§6.4：0.7m） */
export const TRUSS_BEAM_HEIGHT = 0.7

/** 檩条截面宽（§6.4：0.15m） */
export const PURLIN_WIDTH = 0.15

/** 檩条截面高（§6.4：0.3m） */
export const PURLIN_HEIGHT = 0.3

/**
 * 居中对称排布：n = max(1, floor(span / spacing)) 个位置，
 * 首位置 min + margin，之后严格按 spacing 递增，两端等距留白。
 */
function centeredSpacedPositions(min: number, max: number, spacing: number): number[] {
  const span = max - min
  const n = Math.max(1, Math.floor(span / spacing))
  const margin = (span - (n - 1) * spacing) / 2
  const positions: number[] = []
  for (let i = 0; i < n; i += 1) {
    positions.push(min + margin + i * spacing)
  }
  return positions
}

function toInstanceBatch(
  sizeX: number,
  sizeY: number,
  sizeZ: number,
  translations: readonly (readonly [number, number, number])[],
): InstanceGeometryBatch {
  const matrices = new Float32Array(translations.length * 16)
  for (let i = 0; i < translations.length; i += 1) {
    writeTranslationMatrix(matrices, i * 16, translations[i][0], translations[i][1], translations[i][2])
  }
  return {
    geometry: createBoxGeometry(sizeX, sizeY, sizeZ),
    matrices,
    count: translations.length,
  }
}

/** 主梁实例：沿短跨通长，沿长跨 8m 间距居中排布，梁底标高 8m */
export function buildRoofBeamInstances(bounds: FactoryBoundsDto): InstanceGeometryBatch {
  const { innerMinX: minX, innerMaxX: maxX, innerMinZ: minZ, innerMaxZ: maxZ } = bounds
  const innerWidth = maxX - minX
  const innerDepth = maxZ - minZ
  const centerY = WALL_HEIGHT + TRUSS_BEAM_HEIGHT / 2

  if (innerWidth >= innerDepth) {
    // 短跨为 Z：主梁沿 Z 通长，沿 X（长跨）8m 间距排布
    const translations = centeredSpacedPositions(minX, maxX, TRUSS_SPACING).map(
      (x): readonly [number, number, number] => [x, centerY, bounds.centerZ],
    )
    return toInstanceBatch(TRUSS_BEAM_WIDTH, TRUSS_BEAM_HEIGHT, innerDepth, translations)
  }
  // 短跨为 X：主梁沿 X 通长，沿 Z（长跨）8m 间距排布
  const translations = centeredSpacedPositions(minZ, maxZ, TRUSS_SPACING).map(
    (z): readonly [number, number, number] => [bounds.centerX, centerY, z],
  )
  return toInstanceBatch(innerWidth, TRUSS_BEAM_HEIGHT, TRUSS_BEAM_WIDTH, translations)
}

/** 檩条实例：沿长跨通长，沿短跨 4m 间距居中排布，置于主梁顶（底标高 8.7m） */
export function buildRoofPurlinInstances(bounds: FactoryBoundsDto): InstanceGeometryBatch {
  const { innerMinX: minX, innerMaxX: maxX, innerMinZ: minZ, innerMaxZ: maxZ } = bounds
  const innerWidth = maxX - minX
  const innerDepth = maxZ - minZ
  const centerY = WALL_HEIGHT + TRUSS_BEAM_HEIGHT + PURLIN_HEIGHT / 2

  if (innerWidth >= innerDepth) {
    // 长跨为 X：檩条沿 X 通长，沿 Z（短跨）4m 间距排布
    const translations = centeredSpacedPositions(minZ, maxZ, PURLIN_SPACING).map(
      (z): readonly [number, number, number] => [bounds.centerX, centerY, z],
    )
    return toInstanceBatch(innerWidth, PURLIN_HEIGHT, PURLIN_WIDTH, translations)
  }
  // 长跨为 Z：檩条沿 Z 通长，沿 X（短跨）4m 间距排布
  const translations = centeredSpacedPositions(minX, maxX, PURLIN_SPACING).map(
    (x): readonly [number, number, number] => [x, centerY, bounds.centerZ],
  )
  return toInstanceBatch(PURLIN_WIDTH, PURLIN_HEIGHT, innerDepth, translations)
}
