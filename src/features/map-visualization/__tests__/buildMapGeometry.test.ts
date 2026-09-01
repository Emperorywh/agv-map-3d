/*
 * 物理路径去重与静态几何构建测试（与实现共置；TASK-004）。
 *
 * 职责：用合成地图锁定 TASK-004 的几何合同：
 * 1. 正/反向几何归一签名去重：反向重合逻辑边只生成一份物理路径；
 * 2. 同一节点对之间几何不同的平行路径不被按节点对合并；
 * 3. BEZIER 固定 24 段采样，中心线段数 = LINE×1 + BEZIER×24；
 * 4. 逻辑边 → 物理路径映射覆盖全部逻辑边、无遗漏；
 * 5. 节点实例矩阵/颜色与世界坐标、统一坐标转换一致；
 * 6. GPU 资源由 MapGeometry.dispose 幂等释放。
 */
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { createMapModel } from '@/features/map-visualization/model/createMapModel'
import { validateMap } from '@/features/map-visualization/model/validateMap'
import { BEZIER_SAMPLE_SEGMENTS } from '@/features/map-visualization/model/edgeGeometry'
import {
  buildMapGeometry,
  dedupePhysicalPaths,
} from '@/features/map-visualization/scene/buildMapGeometry'
import { NODE_COLORS, NODE_Y, PATH_CENTERLINE_Y } from '@/features/map-visualization/scene/mapAppearance'
import { makeBezierEdge, makeLineEdge, makeNode } from './fixtures'

/**
 * 合成地图（覆盖去重规则的四种形态）：
 * - e1: a→b LINE (0,0)→(3,4)；e2: b→a LINE 反向重合 → 合并为 1 条物理路径
 * - e3: a→c LINE (0,0)→(0,10) → 独立物理路径
 * - e4: a→b BEZIER；e5: b→a BEZIER 反向重合（同 a-b 节点对、曲线几何）
 *   → 合并为 1 条物理路径，且与 e1 的直线物理路径不合并（平行不同几何）
 */
function buildSyntheticMap() {
  const raw = {
    nodes: [
      makeNode({ id: 'a', name: 'A', type: 'work', x: 0, y: 0 }),
      makeNode({ id: 'b', name: 'B', type: 'charge', x: 3, y: 4 }),
      makeNode({ id: 'c', name: 'C', type: 'park', x: 0, y: 10 }),
    ],
    edges: [
      makeLineEdge({ id: 'e1', snodeId: 'a', enodeId: 'b' }),
      makeLineEdge({ id: 'e2', snodeId: 'b', enodeId: 'a', isBackEdge: true }),
      makeLineEdge({ id: 'e3', snodeId: 'a', enodeId: 'c', sx: 0, sy: 0, ex: 0, ey: 10, cost: 10 }),
      makeBezierEdge({ id: 'e4', snodeId: 'a', enodeId: 'b', sx: 0, sy: 0, cx: 1, cy: 1, dx: 2, dy: 3, ex: 3, ey: 4 }),
      makeBezierEdge({ id: 'e5', snodeId: 'b', enodeId: 'a', sx: 3, sy: 4, cx: 2, cy: 3, dx: 1, dy: 1, ex: 0, ey: 0, isBackEdge: true }),
    ],
    zones: [],
    nodeEdgeGroups: [],
  }
  const { mapModel, worldTransform } = createMapModel(validateMap(raw))
  return { mapModel, worldTransform }
}

describe('dedupePhysicalPaths：归一化几何签名去重', () => {
  const { mapModel } = buildSyntheticMap()
  const physical = dedupePhysicalPaths(mapModel)

  it('反向重合逻辑边只生成一份物理路径，重复计数正确', () => {
    // 5 条逻辑边 → 3 条物理路径（e1+e2 合并、e3 独立、e4+e5 合并）
    expect(mapModel.edgeList).toHaveLength(5)
    expect(physical.physicalPaths).toHaveLength(3)
    expect(physical.duplicateEdgeCount).toBe(2)
  })

  it('同一节点对之间几何不同的平行路径不被按节点对合并', () => {
    // a-b 节点对上同时存在 LINE 物理路径与 BEZIER 物理路径
    const linePath = physical.physicalPaths.find((path) => path.representativeEdgeId === 'e1')
    const bezierPath = physical.physicalPaths.find((path) => path.representativeEdgeId === 'e4')
    expect(linePath).toBeDefined()
    expect(bezierPath).toBeDefined()
    expect(linePath!.index).not.toBe(bezierPath!.index)
    expect(linePath!.edgeType).toBe('LINE')
    expect(bezierPath!.edgeType).toBe('BEZIER')
  })

  it('每条物理路径聚合其全部逻辑边；映射覆盖所有逻辑边且无悬空', () => {
    const byId = new Map(physical.physicalPaths.map((path) => [path.representativeEdgeId, path]))
    expect(byId.get('e1')!.logicalEdgeIds).toEqual(['e1', 'e2'])
    expect(byId.get('e4')!.logicalEdgeIds).toEqual(['e4', 'e5'])
    expect(byId.get('e3')!.logicalEdgeIds).toEqual(['e3'])

    expect(physical.physicalPathIndexOfEdge.size).toBe(mapModel.edgeList.length)
    for (const edge of mapModel.edgeList) {
      const index = physical.physicalPathIndexOfEdge.get(edge.id)
      expect(index).toBeDefined()
      expect(physical.physicalPaths[index!].logicalEdgeIds).toContain(edge.id)
    }
  })

  it('BEZIER 固定 24 段采样；中心线段总数 = LINE×1 + BEZIER×24', () => {
    const byId = new Map(physical.physicalPaths.map((path) => [path.representativeEdgeId, path]))
    expect(byId.get('e4')!.points).toHaveLength(BEZIER_SAMPLE_SEGMENTS + 1)
    expect(byId.get('e1')!.points).toHaveLength(2)

    // 2 条 LINE 物理路径 + 1 条 BEZIER 物理路径
    expect(physical.centerSegmentCount).toBe(2 * 1 + 1 * BEZIER_SAMPLE_SEGMENTS)
  })

  it('归一化方向稳定：合并路径的采样点与其首次出现方向的签名一致', () => {
    // e4（正向）先出现：合并路径保持 e4 方向 (0,0)→(3,4)；e2 因 e1 先出现被并入
    const bezier = physical.physicalPaths.find((path) => path.representativeEdgeId === 'e4')!
    expect(bezier.points[0]).toEqual({ x: 0, y: 0 })
    const last = bezier.points[bezier.points.length - 1]
    expect(last).toEqual({ x: 3, y: 4 })
    const line = physical.physicalPaths.find((path) => path.representativeEdgeId === 'e1')!
    expect(line.points[0]).toEqual({ x: 0, y: 0 })
    expect(line.points[1]).toEqual({ x: 3, y: 4 })
  })
})

describe('buildMapGeometry：世界坐标静态几何', () => {
  const { mapModel, worldTransform } = buildSyntheticMap()
  const geometry = buildMapGeometry(mapModel, worldTransform)

  it('中线几何与统一坐标转换一致：逐段等于采样点的世界坐标', () => {
    const positions = geometry.pathsCenterline.getAttribute('position')
    const physical = dedupePhysicalPaths(mapModel)
    let cursor = 0
    for (const path of physical.physicalPaths) {
      for (let i = 1; i < path.points.length; i += 1) {
        const a = worldTransform.toWorldXZ(path.points[i - 1].x, path.points[i - 1].y)
        const b = worldTransform.toWorldXZ(path.points[i].x, path.points[i].y)
        expect(positions.getX(cursor)).toBeCloseTo(a.x, 6)
        expect(positions.getY(cursor)).toBeCloseTo(PATH_CENTERLINE_Y, 6)
        expect(positions.getZ(cursor)).toBeCloseTo(a.z, 6)
        cursor += 1
        expect(positions.getX(cursor)).toBeCloseTo(b.x, 6)
        expect(positions.getZ(cursor)).toBeCloseTo(b.z, 6)
        cursor += 1
      }
    }
    // 每段两个端点顶点
    expect(cursor).toBe(physical.centerSegmentCount * 2)
    expect(cursor * 3).toBe(positions.array.length)
  })

  it('节点实例矩阵与颜色：平移到世界坐标、类别颜色正确、count 一致', () => {
    const { nodeInstances } = geometry
    expect(nodeInstances.count).toBe(mapModel.nodeList.length)

    const nodeA = mapModel.nodes.get('a')!
    const indexA = mapModel.nodeList.indexOf(nodeA)
    const worldA = worldTransform.toWorldXZ(nodeA.x, nodeA.y)
    const m = indexA * 16
    expect(nodeInstances.matrices[m]).toBe(1)
    expect(nodeInstances.matrices[m + 12]).toBeCloseTo(worldA.x, 9)
    expect(nodeInstances.matrices[m + 13]).toBeCloseTo(NODE_Y, 6)
    expect(nodeInstances.matrices[m + 14]).toBeCloseTo(worldA.z, 9)

    // charge 节点 b 使用 charge 颜色（线性空间 RGB 分量逐一比对）
    const nodeB = mapModel.nodes.get('b')!
    const indexB = mapModel.nodeList.indexOf(nodeB)
    const expected = new THREE.Color(NODE_COLORS.charge)
    expect(nodeInstances.colors[indexB * 3]).toBeCloseTo(expected.r, 5)
    expect(nodeInstances.colors[indexB * 3 + 1]).toBeCloseTo(expected.g, 5)
    expect(nodeInstances.colors[indexB * 3 + 2]).toBeCloseTo(expected.b, 5)
  })

  it('非恒等仿射下几何与世界变换保持一致（scale=2）', () => {
    const raw = {
      nodes: [
        makeNode({ id: 'a', x: 0, y: 0 }),
        makeNode({ id: 'b', x: 4, y: 0 }),
      ],
      edges: [makeLineEdge({ id: 'e1', snodeId: 'a', enodeId: 'b', sx: 0, sy: 0, ex: 4, ey: 0 })],
      zones: [],
      nodeEdgeGroups: [],
    }
    const { mapModel: scaledModel, worldTransform: scaledTransform } = createMapModel(
      validateMap(raw),
      { coordinateTransform: { scale: 2, rotation: 0, mirrorY: false, translateX: 0, translateY: 0 } },
    )
    const scaled = buildMapGeometry(scaledModel, scaledTransform)
    const positions = scaled.pathsCenterline.getAttribute('position')
    const start = scaledTransform.toWorldXZ(0, 0)
    const end = scaledTransform.toWorldXZ(4, 0)
    expect(positions.getX(0)).toBeCloseTo(start.x, 6)
    expect(positions.getZ(0)).toBeCloseTo(start.z, 6)
    expect(positions.getX(1)).toBeCloseTo(end.x, 6)
    expect(positions.getZ(1)).toBeCloseTo(end.z, 6)
    scaled.dispose()
  })

  it('dispose 幂等释放两张静态几何，重复调用不抛错', () => {
    const surfaceSpy = vi.spyOn(geometry.pathsSurface, 'dispose')
    const centerlineSpy = vi.spyOn(geometry.pathsCenterline, 'dispose')
    geometry.dispose()
    expect(surfaceSpy).toHaveBeenCalledTimes(1)
    expect(centerlineSpy).toHaveBeenCalledTimes(1)
    expect(() => geometry.dispose()).not.toThrow()
    expect(surfaceSpy).toHaveBeenCalledTimes(1)
    surfaceSpy.mockRestore()
    centerlineSpy.mockRestore()
  })
})
