/*
 * 连通分量包围盒与默认聚焦选择测试（视觉对齐 P0-5.2；与实现共置）。
 *
 * 职责：锁定合同：
 * 1. computeComponentBounds：分量 → 世界坐标 AABB（中心/对角线派生正确）；
 * 2. pickFocusBounds：位置按扩展边距计入分量，返回最多位置的分量；
 * 3. 并列与空输入的回退语义（无位置命中返回 null）。
 */
import { describe, expect, it } from 'vitest'
import { createMapModel } from '@/features/map-visualization/model/createMapModel'
import { validateMap } from '@/features/map-visualization/model/validateMap'
import {
  computeComponentBounds,
  pickFocusBounds,
} from '@/features/map-visualization/model/componentBounds'
import { makeLineEdge, makeNode } from './fixtures'

/**
 * 两个分离区域：A 区（a1—a2 横线，x 0..10）与 B 区（b1—b2 竖线，y 0..10，
 * x=50 偏移），无任何边相连（分离连通分量）。
 */
function buildTwoComponentModel() {
  const { mapModel, worldTransform } = createMapModel(
    validateMap({
      nodes: [
        makeNode({ id: 'a1', x: 0, y: 0 }),
        makeNode({ id: 'a2', x: 10, y: 0 }),
        makeNode({ id: 'b1', x: 50, y: 0 }),
        makeNode({ id: 'b2', x: 50, y: 10 }),
      ],
      edges: [
        makeLineEdge({ id: 'ea', snodeId: 'a1', enodeId: 'a2', sx: 0, sy: 0, ex: 10, ey: 0 }),
        makeLineEdge({ id: 'eb', snodeId: 'b1', enodeId: 'b2', sx: 50, sy: 0, ex: 50, ey: 10 }),
      ],
      zones: [],
      nodeEdgeGroups: [],
    }),
  )
  expect(mapModel.components).toHaveLength(2)
  return { mapModel, worldTransform }
}

describe('computeComponentBounds', () => {
  it('每个分量一个世界坐标包围盒，中心与对角线派生正确', () => {
    const { mapModel, worldTransform } = buildTwoComponentModel()
    const bounds = computeComponentBounds(mapModel, worldTransform)

    expect(bounds.size).toBe(2)
    // 世界原点 = 全部节点平面包围盒中心 (25, 5)：world = map - (25, 5)
    const boxes = [...bounds.values()].sort((p, q) => p.centerWorldX - q.centerWorldX)
    // A 区：地图 x 0..10、y 0 → 世界 x [-25,-15]、z=-5
    expect(boxes[0].centerWorldX).toBeCloseTo(-20, 6)
    expect(boxes[0].centerWorldZ).toBeCloseTo(-5, 6)
    expect(boxes[0].diagonal).toBeCloseTo(10, 6)
    // B 区：x=50、y 0..10 → 世界 x=25、z [-5,5]
    expect(boxes[1].centerWorldX).toBeCloseTo(25, 6)
    expect(boxes[1].centerWorldZ).toBeCloseTo(0, 6)
    expect(boxes[1].diagonal).toBeCloseTo(10, 6)
  })
})

describe('pickFocusBounds', () => {
  it('返回车辆最多的分量包围盒', () => {
    const { mapModel, worldTransform } = buildTwoComponentModel()
    // 世界坐标：世界原点 (25,5)。A 区世界 x∈[-25,-15]、z=-5；B 区 x=25
    const focus = pickFocusBounds(
      mapModel,
      worldTransform,
      [
        { x: -20, z: -5 }, // A 区
        { x: -17, z: -5 }, // A 区
        { x: 25, z: 0 }, // B 区
      ],
    )
    expect(focus).not.toBeNull()
    expect(focus!.centerWorldX).toBeCloseTo(-20, 6)
    expect(focus!.centerWorldZ).toBeCloseTo(-5, 6)
    expect(focus!.diagonal).toBeCloseTo(10, 6)
  })

  it('扩展边距内的贴边位置仍计入所属分量', () => {
    const { mapModel, worldTransform } = buildTwoComponentModel()
    // A 区包围盒 x [-25,-15]、z=-5；边距 2m 内的贴边点（x=-14, z=-4）计入
    const focus = pickFocusBounds(mapModel, worldTransform, [{ x: -14, z: -4 }], 2)
    expect(focus).not.toBeNull()
    expect(focus!.centerWorldX).toBeCloseTo(-20, 6)
  })

  it('无任何位置命中任何分量时返回 null（保持全厂总览）', () => {
    const { mapModel, worldTransform } = buildTwoComponentModel()
    expect(pickFocusBounds(mapModel, worldTransform, [])).toBeNull()
    expect(pickFocusBounds(mapModel, worldTransform, [{ x: 500, z: 500 }])).toBeNull()
  })
})
