/*
 * 仓储聚合视觉模型测试（视觉对齐 P0-5.5；与实现共置）。
 *
 * 职责：锁定聚类的拓扑合同：
 * 1. 间距聚类：相邻节点（≤ 阈值）归同一仓储区域，远离的分离；
 * 2. 每个仓库节点恰好归属一个区域与一行，无遗漏无重复；
 * 3. 行矩形：行方向角与成员主轴一致、长宽覆盖成员投影包络；
 * 4. 单节点区域退化为最小可读行；
 * 5. 非仓库节点不参与聚合。
 */
import { describe, expect, it } from 'vitest'
import { createMapModel } from '@/features/map-visualization/model/createMapModel'
import { validateMap } from '@/features/map-visualization/model/validateMap'
import { buildWarehouseVisualModel } from '@/features/map-visualization/scene/warehouseVisualModel'
import {
  WAREHOUSE_CLUSTER_SPACING_M,
  WAREHOUSE_ROW_MIN_WIDTH_M,
} from '@/features/map-visualization/scene/mapAppearance'
import { makeNode } from './fixtures'

function buildModel(nodes: Record<string, unknown>[]) {
  const { mapModel, worldTransform } = createMapModel(
    validateMap({ nodes, edges: [], zones: [], nodeEdgeGroups: [] }),
  )
  return buildWarehouseVisualModel(mapModel, worldTransform)
}

/** 生成一排沿 x 方向等距的仓库节点 */
function warehouseRow(
  prefix: string,
  startX: number,
  y: number,
  count: number,
  spacing = 1.5,
): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) =>
    makeNode({ id: `${prefix}-${i}`, type: 'warehouse', x: startX + i * spacing, y }),
  )
}

describe('buildWarehouseVisualModel：间距聚类', () => {
  it('相邻两排归同一区域；远离的独立成区', () => {
    const model = buildModel([
      ...warehouseRow('r1', 0, 0, 4),
      ...warehouseRow('r2', 0, 2, 4), // 与 r1 间距 2m ≤ 阈值 → 同区
      ...warehouseRow('far', 0, 60, 4), // 距离 58m → 独立区
    ])

    expect(model.zones).toHaveLength(2)
    const memberCounts = model.zones.map((zone) => zone.nodeIds.length).sort((a, b) => b - a)
    expect(memberCounts).toEqual([8, 4])
    // 每个节点恰好归属一个区域
    const allIds = model.zones.flatMap((zone) => zone.nodeIds)
    expect(new Set(allIds).size).toBe(allIds.length)
    expect(allIds).toHaveLength(12)
  })

  it('区域内行聚类：两条平行货架行被拆分，行方向沿排列方向', () => {
    const model = buildModel([
      ...warehouseRow('a', 0, 0, 5),
      ...warehouseRow('b', 0, 3, 5), // 副轴间距 3m > 行间距阈值 → 独立行
    ])

    expect(model.zones).toHaveLength(1)
    const zone = model.zones[0]
    expect(zone.rows).toHaveLength(2)
    expect(model.rowCount).toBe(2)
    for (const row of zone.rows) {
      // 主轴接近 x 方向（角度接近 0 或 π）
      const normalized = Math.abs(Math.atan2(Math.sin(row.angle), Math.cos(row.angle)))
      expect(normalized).toBeLessThan(Math.PI / 4)
      expect(row.nodeIds).toHaveLength(5)
      expect(row.widthM).toBeGreaterThan(0)
      expect(row.lengthM).toBeGreaterThan(4 * 1.5)
    }
    // 两行的行成员不重叠
    const rowIds = zone.rows.flatMap((row) => row.nodeIds)
    expect(new Set(rowIds).size).toBe(10)
  })

  it('单节点区域退化为最小可读行', () => {
    const model = buildModel([
      makeNode({ id: 'solo', type: 'warehouse', x: 10, y: 10 }),
    ])

    expect(model.zones).toHaveLength(1)
    expect(model.zones[0].rows).toHaveLength(1)
    expect(model.zones[0].rows[0].widthM).toBeCloseTo(WAREHOUSE_ROW_MIN_WIDTH_M, 6)
    expect(model.zones[0].rows[0].nodeIds).toEqual(['solo'])
    // 单点凸包退化为点：色块由几何层降级处理
    expect(model.zones[0].hull.length).toBe(1)
  })

  it('非仓库节点不参与聚合', () => {
    const model = buildModel([
      makeNode({ id: 'w1', type: 'warehouse', x: 0, y: 0 }),
      makeNode({ id: 'wk', type: 'work', x: 0.5, y: 0 }),
      makeNode({ id: 'chg', type: 'charge', x: 1, y: 0 }),
    ])

    expect(model.zones).toHaveLength(1)
    expect(model.zones[0].nodeIds).toEqual(['w1'])
    expect(model.rowCount).toBe(1)
  })

  it('空仓库地图返回空聚合', () => {
    const model = buildModel([makeNode({ id: 'only-work', type: 'work', x: 0, y: 0 })])
    expect(model.zones).toHaveLength(0)
    expect(model.rowCount).toBe(0)
  })

  it('聚类间距使用 mapAppearance 阈值（同排相邻节点间距 ≤ 阈值必同区）', () => {
    expect(WAREHOUSE_CLUSTER_SPACING_M).toBeGreaterThan(1.5)
    const model = buildModel(warehouseRow('tight', 0, 0, 3, 1.5))
    expect(model.zones).toHaveLength(1)
    expect(model.zones[0].rows).toHaveLength(1)
  })
})
