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
import { JUNCTION_PAD_SCALE, JUNCTION_PAD_SEGMENTS, NODE_COLORS, NODE_Y, PATH_CENTERLINE_Y, PATH_SURFACE_WIDTH_M } from '@/features/map-visualization/scene/mapAppearance'
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

  it('中线虚线几何（P1-4 + P0-5.3 端部截除）：全部顶点位于链上、高度一致、单段不超实线长', () => {
    const positions = geometry.pathsCenterline.getAttribute('position')
    const physical = dedupePhysicalPaths(mapModel)

    // 每个虚线段端点必须落在某条物理路径的某段上（共线 + 参数在段内）
    const onPath = (x: number, z: number): boolean => {
      for (const path of physical.physicalPaths) {
        for (let i = 1; i < path.points.length; i += 1) {
          const a = worldTransform.toWorldXZ(path.points[i - 1].x, path.points[i - 1].y)
          const b = worldTransform.toWorldXZ(path.points[i].x, path.points[i].y)
          const dx = b.x - a.x
          const dz = b.z - a.z
          const len2 = dx * dx + dz * dz
          if (len2 === 0) {
            continue
          }
          const t = ((x - a.x) * dx + (z - a.z) * dz) / len2
          if (t < -1e-6 || t > 1 + 1e-6) {
            continue
          }
          const px = a.x + dx * t
          const pz = a.z + dz * t
          if (Math.hypot(px - x, pz - z) < 1e-4) {
            return true
          }
        }
      }
      return false
    }

    const vertexCount = positions.count
    expect(vertexCount).toBeGreaterThan(0)
    expect(vertexCount % 2).toBe(0)
    for (let v = 0; v < vertexCount; v += 1) {
      expect(positions.getY(v)).toBeCloseTo(PATH_CENTERLINE_Y, 6)
      expect(onPath(positions.getX(v), positions.getZ(v))).toBe(true)
    }
    // 每条虚线段（成对顶点）长度 ≤ 实段长（相位跨关节连续，端点截断除外）
    for (let d = 0; d < vertexCount / 2; d += 1) {
      const ax = positions.getX(d * 2)
      const az = positions.getZ(d * 2)
      const bx = positions.getX(d * 2 + 1)
      const bz = positions.getZ(d * 2 + 1)
      expect(Math.hypot(bx - ax, bz - az)).toBeLessThanOrEqual(1.0 + 1e-6)
    }
  })

  it('虚线在链端截除（P0-5.3）：交叉端截除补面半径、断头端截除半路宽', () => {
    const positions = geometry.pathsCenterline.getAttribute('position')
    const halfWidth = PATH_SURFACE_WIDTH_M / 2
    const padRadius = halfWidth * JUNCTION_PAD_SCALE

    // 合成图世界坐标：节点 a(0,0)/b(3,4)/c(0,10)，包围盒中心 (1.5,5)。
    // 链 1（a→c 直线）在世界 x' = -1.5 的竖直线上；其余顶点属链 0。
    const chain0: { x: number; z: number }[][] = []
    const chain1: { x: number; z: number }[][] = []
    for (let d = 0; d < positions.count / 2; d += 1) {
      const pair = [
        { x: positions.getX(d * 2), z: positions.getZ(d * 2) },
        { x: positions.getX(d * 2 + 1), z: positions.getZ(d * 2 + 1) },
      ]
      if (Math.abs(pair[0].x + 1.5) < 1e-6 && Math.abs(pair[1].x + 1.5) < 1e-6) {
        chain1.push(pair)
      } else {
        chain0.push(pair)
      }
    }

    const junctionWorld = worldTransform.toWorldXZ(0, 0)
    const deadEndWorld = worldTransform.toWorldXZ(0, 10)
    const distTo = (p: { x: number; z: number }, q: { x: number; z: number }): number =>
      Math.hypot(p.x - q.x, p.z - q.z)

    // 两条链都起于交叉节点 a：首个虚线顶点距 a ≥ 补面半径
    expect(chain0.length).toBeGreaterThan(0)
    expect(chain1.length).toBeGreaterThan(0)
    expect(distTo(chain0[0][0], junctionWorld)).toBeGreaterThanOrEqual(padRadius - 1e-3)
    expect(distTo(chain1[0][0], junctionWorld)).toBeGreaterThanOrEqual(padRadius - 1e-3)

    // 链 1 终于断头端 c：最后一段虚线的远端距 c ≥ 半路宽（圆帽内无虚线）
    const lastPair = chain1[chain1.length - 1]
    expect(distTo(lastPair[1], deadEndWorld)).toBeGreaterThanOrEqual(halfWidth - 1e-3)
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
    // P0-5.3 端部截除：首段从断头端圆帽边缘（世界半路宽，路面宽度是世界
    // 米制常量、不随地图仿射缩放）开始，全部顶点落在唯一线段上
    const worldHalfWidth = PATH_SURFACE_WIDTH_M / 2
    expect(positions.getX(0)).toBeCloseTo(start.x + worldHalfWidth, 3)
    expect(positions.getZ(0)).toBeCloseTo(start.z, 6)
    expect(positions.count).toBeGreaterThan(2)
    for (let v = 0; v < positions.count; v += 1) {
      expect(positions.getZ(v)).toBeCloseTo(start.z, 6)
      expect(positions.getX(v)).toBeGreaterThanOrEqual(Math.min(start.x, end.x) - 1e-5)
      expect(positions.getX(v)).toBeLessThanOrEqual(Math.max(start.x, end.x) + 1e-5)
    }
    scaled.dispose()
  })

  it('道路拓扑重建（P0-5.3）：断头端补圆帽、交叉节点只补一个路口圆盘', () => {
    const network = geometry.network
    const halfWidth = PATH_SURFACE_WIDTH_M / 2
    const padRadius = halfWidth * JUNCTION_PAD_SCALE

    // 合成图：链 0 = line+bezier 经二度节点 b 合并（端点都是交叉节点 a，
    // 无端帽）；链 1 = a→c（c 是断头端，补一个端帽）。节点 a 度数 3 → 恰
    // 一个路口圆盘补面。
    expect(network.chains).toHaveLength(2)
    expect(network.chains[0].startNodeId).toBe('a')
    expect(network.chains[0].endNodeId).toBe('a')
    expect(network.chains[1].startNodeId).toBe('a')
    expect(network.chains[1].endNodeId).toBe('c')
    expect(network.junctions).toHaveLength(1)
    expect(network.junctions[0].nodeId).toBe('a')

    // 顶点账本：链条带（关节对 + 断头端帽）+ 每交叉节点一个圆盘
    let expectedVertices = 0
    for (const chain of network.chains) {
      const capStart = (network.nodeDegree.get(chain.startNodeId) ?? 0) === 1
      const capEnd = (network.nodeDegree.get(chain.endNodeId) ?? 0) === 1
      expectedVertices += 2 * chain.points.length
      expectedVertices += (capStart ? 1 : 0) * 17 + (capEnd ? 1 : 0) * 17
    }
    expectedVertices += network.junctions.length * (1 + JUNCTION_PAD_SEGMENTS)
    const surface = geometry.pathsSurface.getAttribute('position')
    expect(surface.count).toBe(expectedVertices)

    // 路口补面圆盘：恰 JUNCTION_PAD_SEGMENTS 个顶点与节点 a 距离 = padRadius
    const junctionWorld = worldTransform.toWorldXZ(0, 0)
    let padRingVertices = 0
    for (let v = 0; v < surface.count; v += 1) {
      const d = Math.hypot(
        surface.getX(v) - junctionWorld.x,
        surface.getZ(v) - junctionWorld.z,
      )
      if (Math.abs(d - padRadius) < 1e-4) {
        padRingVertices += 1
      }
    }
    expect(padRingVertices).toBeGreaterThanOrEqual(JUNCTION_PAD_SEGMENTS)
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
