/*
 * 独占区几何构建测试（与实现共置；TASK-005）。
 *
 * 职责：锁定 buildExclusiveGroupsGeometry 的合同（§2.3 / §11.12）：
 * 1. 合并：全部分组的成员物理路径进入同一个静态 BufferGeometry（一个 Draw Call）；
 * 2. 去重：正反向成员边映射到同一物理路径时只构建一次条带；
 * 3. 锚点：分组名称锚点 = 成员节点世界包围盒中心；无有效成员的分组无锚点；
 * 4. 隔离：引用不存在的节点/边只跳过该引用，不阻断分组与构建（纵深防御）；
 * 5. 释放：dispose 幂等。
 */
import { describe, expect, it, vi } from 'vitest'
import { createMapModel } from '../model/createMapModel'
import { validateMap } from '../model/validateMap'
import type { MapModel } from '../model/types'
import { dedupePhysicalPaths } from '../scene/buildMapGeometry'
import { buildExclusiveGroupsGeometry } from '../scene/buildExclusiveGroupsGeometry'
import { EXCLUSIVE_OUTLINE_Y } from '../scene/mapAppearance'
import { makeGroup, makeLineEdge, makeNode } from './fixtures'

/**
 * 单段 LINE 物理路径条带的新顶点/索引合同（P0-4 共享顶点 strip + 双端圆帽）：
 * 顶点 = 2 关节 × 2 + 2 端帽 ×（1 圆心 + 16 圆环）；索引 = 1 段 × 6 + 2 帽 × 16 × 3
 */
const LINE_PATH_VERTICES = 4 + 2 * 17
const LINE_PATH_INDICES = 6 + 2 * 16 * 3

/** 三节点夹具：a-b 与 b-a 为同一物理路径（反向重合），b-c 独立 */
function buildModel() {
  return createMapModel(
    validateMap({
      nodes: [
        makeNode({ id: 'a', name: 'A', type: 'work', x: 0, y: 0 }),
        makeNode({ id: 'b', name: 'B', type: 'work', x: 4, y: 0 }),
        makeNode({ id: 'c', name: 'C', type: 'work', x: 8, y: 6 }),
      ],
      edges: [
        makeLineEdge({ id: 'e1', snodeId: 'a', enodeId: 'b', sx: 0, sy: 0, ex: 4, ey: 0 }),
        makeLineEdge({ id: 'e1r', snodeId: 'b', enodeId: 'a', sx: 4, sy: 0, ex: 0, ey: 0 }),
        makeLineEdge({ id: 'e2', snodeId: 'b', enodeId: 'c', sx: 4, sy: 0, ex: 8, ey: 6 }),
      ],
      zones: [],
      nodeEdgeGroups: [
        makeGroup({ id: 'g1', name: '独占区1', nodeIds: ['a', 'b'], edgeIds: ['e1', 'e1r'] }),
        makeGroup({ id: 'g2', name: '独占区2', nodeIds: ['c'], edgeIds: ['e2'] }),
      ],
    }),
  )
}

describe('buildExclusiveGroupsGeometry 独占区几何', () => {
  const { mapModel, worldTransform } = buildModel()
  const physical = dedupePhysicalPaths(mapModel)
  const build = buildExclusiveGroupsGeometry(mapModel, worldTransform, physical)

  it('反向重合边只构建一次条带；全部分组合并为单个 BufferGeometry', () => {
    // e1 与 e1r 同几何 → g1 贡献 1 段；g2 贡献 1 段 → 合计 2 段
    expect(physical.physicalPaths).toHaveLength(2)
    expect(build.usedPhysicalPathCount).toBe(2)
    const position = build.outline.getAttribute('position')
    expect(position.count).toBe(2 * LINE_PATH_VERTICES)
    expect(build.outline.getIndex()?.count).toBe(2 * LINE_PATH_INDICES)
    // 条带高度烘焙在独占区阶梯
    expect(position.getY(0)).toBeCloseTo(EXCLUSIVE_OUTLINE_Y, 6)
  })

  it('名称锚点 = 成员节点世界包围盒中心，每个分组一个', () => {
    expect(build.nameAnchors).toHaveLength(2)
    const a = worldTransform.toWorldXZ(0, 0)
    const b = worldTransform.toWorldXZ(4, 0)
    const c = worldTransform.toWorldXZ(8, 6)
    expect(build.nameAnchors[0]).toMatchObject({
      groupId: 'g1',
      name: '独占区1',
      x: (a.x + b.x) / 2,
      z: (a.z + b.z) / 2,
    })
    expect(build.nameAnchors[1]).toMatchObject({
      groupId: 'g2',
      name: '独占区2',
      x: c.x,
      z: c.z,
    })
  })

  it('无效成员逐项隔离：幽灵节点/边被跳过，有效成员照常构建', () => {
    // 手工构造含悬空引用的模型（正常路径经 validateMap 已过滤，此处纵深防御）
    const fragileModel: MapModel = {
      ...mapModel,
      groupList: Object.freeze([
        Object.freeze({
          id: 'gx',
          name: '幽灵分组',
          memberNodeIds: Object.freeze(['a', 'ghost-node']),
          memberEdgeIds: Object.freeze(['e1', 'ghost-edge']),
        }),
      ]),
    }
    const fragile = buildExclusiveGroupsGeometry(fragileModel, worldTransform, physical)
    // 锚点只用有效节点 a；几何只用有效边 e1 映射的物理路径（1 段）
    expect(fragile.nameAnchors).toHaveLength(1)
    const a = worldTransform.toWorldXZ(0, 0)
    expect(fragile.nameAnchors[0]).toMatchObject({ groupId: 'gx', x: a.x, z: a.z })
    expect(fragile.usedPhysicalPathCount).toBe(1)
    expect(fragile.outline.getAttribute('position').count).toBe(LINE_PATH_VERTICES)
    fragile.dispose()
  })

  it('全部成员无效的分组不产生锚点、不崩溃', () => {
    const emptyModel: MapModel = {
      ...mapModel,
      groupList: Object.freeze([
        Object.freeze({
          id: 'ge',
          name: '空分组',
          memberNodeIds: Object.freeze([]),
          memberEdgeIds: Object.freeze([]),
        }),
      ]),
    }
    const empty = buildExclusiveGroupsGeometry(emptyModel, worldTransform, physical)
    expect(empty.nameAnchors).toHaveLength(0)
    expect(empty.usedPhysicalPathCount).toBe(0)
    expect(empty.outline.getAttribute('position').count).toBe(0)
    empty.dispose()
  })

  it('跨分组共享的物理路径全图只构建一次', () => {
    const sharedModel: MapModel = {
      ...mapModel,
      groupList: Object.freeze([
        Object.freeze({
          id: 's1',
          name: 'S1',
          memberNodeIds: Object.freeze(['a']),
          memberEdgeIds: Object.freeze(['e1']),
        }),
        Object.freeze({
          id: 's2',
          name: 'S2',
          memberNodeIds: Object.freeze(['b']),
          memberEdgeIds: Object.freeze(['e1r']),
        }),
      ]),
    }
    const shared = buildExclusiveGroupsGeometry(sharedModel, worldTransform, physical)
    expect(shared.usedPhysicalPathCount).toBe(1)
    expect(shared.outline.getAttribute('position').count).toBe(LINE_PATH_VERTICES)
    shared.dispose()
  })

  it('dispose 幂等释放外沿几何', () => {
    const spy = vi.spyOn(build.outline, 'dispose')
    build.dispose()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(() => build.dispose()).not.toThrow()
    spy.mockRestore()
  })
})
