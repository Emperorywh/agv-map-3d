/// <reference types="node" />
/*
 * 当前地图集成测试（TASK-003 数据事实 + TASK-004 物理路径几何 + TASK-005 语义图层事实）。
 *
 * 职责：从当前输入 json/map.json 重新计算并锁定 SPEC §2.3 的全部数据不变量，
 *       输入发生合法变化时，直接更新本文件中的期望值（不保留旧值说明）。
 * 关键不变量（当前输入）：
 * 1. 4,291 节点、9,265 逻辑边（5,963 LINE / 3,302 BEZIER）、7 个独占区、
 *    零丢失引用（校验异常为空）；
 * 2. 4 个弱连通分量，节点数 2,001 / 1,187 / 796 / 307，每个分量都含充电站；
 * 3. 存在无出边的工作节点（死路拓扑是合法输入，Mock 不得崩溃）；
 * 4. 节点「1644」存在且坐标与当前车辆夹具对齐（A4 基准点）；
 * 5. 全部逻辑边物理长度为正有限值；
 * 6. 物理路径去重（TASK-004 / A1、A3）：5,068 条物理路径（3,351 LINE /
 *    1,717 BEZIER）、4,197 条反向重复几何、约 44,559 个中心线段，
 *    映射覆盖全部逻辑边；
 * 7. 语义图层（TASK-005 / A1、A2）：59 个充电桩实例、1,185 块仓库地面方垫
 *    + 2 块停车凸起 slab（P2-2）、7 个独占区名称锚点（仓库名称已按 P0-5
 *    移除），分组成员物理路径全部有效且外沿合并为单个几何。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createMapModel } from '@/features/map-visualization/model/createMapModel'
import { validateMap } from '@/features/map-visualization/model/validateMap'
import {
  buildMapGeometry,
  dedupePhysicalPaths,
} from '@/features/map-visualization/scene/buildMapGeometry'
import { buildExclusiveGroupsGeometry } from '@/features/map-visualization/scene/buildExclusiveGroupsGeometry'
import { buildLandmarkData } from '@/features/map-visualization/scene/buildLandmarkData'
import {
  collectMapNameLabels,
  layoutNameAtlas,
} from '@/features/map-visualization/scene/mapNameAtlas'
import {
  CENTERLINE_DASH_OFF_M,
  CENTERLINE_DASH_ON_M,
  JUNCTION_PAD_SCALE,
  JUNCTION_PAD_SEGMENTS,
  MAP_NAME_CANVAS_MAX_HEIGHT,
  MAP_NAME_CANVAS_WIDTH,
  MAP_NAME_FONT_PX,
  MAP_NAME_PADDING_PX,
  NODE_COLORS,
  PARK_SLAB_HEIGHT_M,
  PATH_SURFACE_WIDTH_M,
} from '@/features/map-visualization/scene/mapAppearance'
import * as THREE from 'three'

// vitest 以仓库根为工作目录运行（jsdom 下 import.meta.url 非 file: 协议）
const MAP_JSON_PATH = path.resolve(process.cwd(), 'json/map.json')
const RAW_MAP: unknown = JSON.parse(readFileSync(MAP_JSON_PATH, 'utf8'))

// 全文件共享同一份校验与建模结果（两个 describe 分别锁定数据事实与几何事实）
const VALIDATED = validateMap(RAW_MAP)
const MODEL = createMapModel(VALIDATED)

const EXPECTED = {
  mapId: '9f80a2f295884fac8ae587c955d8d0ab',
  nodeCount: 4291,
  edgeCount: 9265,
  lineCount: 5963,
  bezierCount: 3302,
  groupCount: 7,
  typeCounts: { work: 3045, warehouse: 1185, charge: 59, park: 2, unknown: 0 },
  componentSizes: [2001, 1187, 796, 307],
  node1644: { id: 'gMBuAPSj2df7eHU5211p1PEA3ZcM2qW9', x: 203.23966291396653, y: 4.558880330321202 },
  physicalPathCount: 5068,
  linePhysicalPaths: 3351,
  bezierPhysicalPaths: 1717,
  duplicateEdgeCount: 4197,
  centerSegmentCount: 44559,
} as const

describe('当前地图（json/map.json）数据不变量', () => {
  const { mapModel, worldTransform } = MODEL

  it('节点、逻辑边与独占区数量符合当前输入，且零丢失引用（校验异常为空）', () => {
    expect(VALIDATED.anomalies).toEqual([])
    expect(mapModel.nodeList).toHaveLength(EXPECTED.nodeCount)
    expect(mapModel.edgeList).toHaveLength(EXPECTED.edgeCount)
    expect(mapModel.groupList).toHaveLength(EXPECTED.groupCount)
    expect(mapModel.nodes.size).toBe(EXPECTED.nodeCount)
    expect(mapModel.edges.size).toBe(EXPECTED.edgeCount)
  })

  it('节点类型分布与 LINE/BEZIER 边型分布符合当前输入', () => {
    const typeCounts = { work: 0, warehouse: 0, charge: 0, park: 0, unknown: 0 }
    for (const node of mapModel.nodeList) {
      typeCounts[node.category] += 1
    }
    expect(typeCounts).toEqual(EXPECTED.typeCounts)

    const lineCount = mapModel.edgeList.filter((edge) => edge.edgeType === 'LINE').length
    expect(lineCount).toBe(EXPECTED.lineCount)
    expect(mapModel.edgeList.length - lineCount).toBe(EXPECTED.bezierCount)
  })

  it('弱连通分量为 4 个，节点数 2,001/1,187/796/307，且每个分量都含充电站（§9.1/E2）', () => {
    expect(mapModel.components).toHaveLength(4)
    expect(mapModel.components.map((component) => component.nodeIds.length)).toEqual(
      EXPECTED.componentSizes,
    )
    for (const component of mapModel.components) {
      expect(component.chargeNodeIds.length).toBeGreaterThan(0)
      expect(component.edgeCount).toBeGreaterThan(0)
    }
    // 分量覆盖全部节点，无遗漏
    let covered = 0
    for (const component of mapModel.components) {
      covered += component.nodeIds.length
    }
    expect(covered).toBe(EXPECTED.nodeCount)
  })

  it('存在无出边的工作节点（死路是合法拓扑），Mock 可据此安全停车', () => {
    const deadEnds = mapModel.nodeList.filter(
      (node) => node.category === 'work' && mapModel.outEdgeIds.get(node.id)?.length === 0,
    )
    expect(deadEnds.length).toBeGreaterThan(0)
  })

  it('节点「1644」存在且坐标与当前车辆夹具对齐（A4 基准点，恒等变换下世界坐标正确）', () => {
    const node = mapModel.nodes.get(EXPECTED.node1644.id)
    if (!node) {
      throw new Error(`节点 1644（${EXPECTED.node1644.id}）不存在`)
    }
    expect(node).toMatchObject({
      name: '1644',
      category: 'work',
      x: EXPECTED.node1644.x,
      y: EXPECTED.node1644.y,
      angle: null,
    })
    const world = worldTransform.toWorldXZ(node.x, node.y)
    // 车辆夹具 agvPosition (203.2397, 4.5589) 与该节点相距约 0.000042m，
    // 转换到世界坐标后仍应落在同一位置（恒等仿射 + 包围盒中心原点）
    expect(world.x).toBeCloseTo(node.x - worldTransform.origin.x, 9)
    expect(world.z).toBeCloseTo(node.y - worldTransform.origin.y, 9)
  })

  it('全部逻辑边物理长度为正有限值；出边索引总量等于逻辑边总数', () => {
    let outTotal = 0
    for (const edge of mapModel.edgeList) {
      expect(Number.isFinite(edge.length)).toBe(true)
      expect(edge.length).toBeGreaterThan(0)
      expect(edge.length).toBeLessThan(1e6)
    }
    for (const list of mapModel.outEdgeIds.values()) {
      outTotal += list.length
    }
    expect(outTotal).toBe(EXPECTED.edgeCount)
  })

  it('独占区分组成员全部有效，且成员数处于当前输入的已知区间（25～32 节点 / 70～199 边）', () => {
    expect(mapModel.groupList).toHaveLength(EXPECTED.groupCount)
    for (const group of mapModel.groupList) {
      expect(group.memberNodeIds.length).toBeGreaterThanOrEqual(25)
      expect(group.memberNodeIds.length).toBeLessThanOrEqual(32)
      expect(group.memberEdgeIds.length).toBeGreaterThanOrEqual(70)
      expect(group.memberEdgeIds.length).toBeLessThanOrEqual(199)
      for (const nodeId of group.memberNodeIds) {
        expect(mapModel.nodes.has(nodeId)).toBe(true)
      }
      for (const edgeId of group.memberEdgeIds) {
        expect(mapModel.edges.has(edgeId)).toBe(true)
      }
    }
  })

  it('mapId 与场景包围盒符合当前输入（包围盒来自节点坐标范围）', () => {
    expect(mapModel.mapId).toBe(EXPECTED.mapId)
    // 节点坐标 x∈[2, 241.03…]、y∈[-79.39, 46.5]（SPEC §2.1），恒等变换下
    // 包围盒即该范围减去中心原点
    expect(mapModel.sceneBounds.diagonal).toBeGreaterThan(0)
    expect(mapModel.sceneBounds.maxWorldX - mapModel.sceneBounds.minWorldX).toBeCloseTo(
      241.03425229897965 - 2,
      6,
    )
    expect(mapModel.sceneBounds.maxWorldZ - mapModel.sceneBounds.minWorldZ).toBeCloseTo(
      46.5 - -79.38743879154408,
      6,
    )
  })
})

describe('当前地图（json/map.json）物理路径与静态几何（TASK-004 / A1、A3）', () => {
  const { mapModel, worldTransform } = MODEL
  const physical = dedupePhysicalPaths(mapModel)
  const geometry = buildMapGeometry(mapModel, worldTransform)

  it('归一化几何签名去重得到 5,068 条物理路径（3,351 LINE / 1,717 BEZIER），4,197 条反向重复几何被合并', () => {
    expect(physical.physicalPaths).toHaveLength(EXPECTED.physicalPathCount)
    expect(physical.duplicateEdgeCount).toBe(EXPECTED.duplicateEdgeCount)
    const linePaths = physical.physicalPaths.filter((path) => path.edgeType === 'LINE')
    expect(linePaths).toHaveLength(EXPECTED.linePhysicalPaths)
    expect(physical.physicalPaths.length - linePaths.length).toBe(EXPECTED.bezierPhysicalPaths)
  })

  // 全量并行运行下重采样负载可能超过默认 5s 超时（单独运行约 0.8s），
  // 显式放宽本用例超时（TASK-014 期间全量套件扩容后实测暴露）
  it('中心线段总数为 44,559；LINE 路径 2 个采样点、BEZIER 路径 25 个采样点', () => {
    expect(physical.centerSegmentCount).toBe(EXPECTED.centerSegmentCount)
    for (const path of physical.physicalPaths) {
      if (path.edgeType === 'LINE') {
        expect(path.points).toHaveLength(2)
      } else {
        expect(path.points).toHaveLength(24 + 1)
      }
      for (const point of path.points) {
        expect(Number.isFinite(point.x)).toBe(true)
        expect(Number.isFinite(point.y)).toBe(true)
      }
    }
  }, 30_000)

  it('逻辑边 → 物理路径映射覆盖全部 9,265 条逻辑边，无遗漏无重复', () => {
    expect(physical.physicalPathIndexOfEdge.size).toBe(EXPECTED.edgeCount)
    const covered = new Set<string>()
    for (const path of physical.physicalPaths) {
      for (const edgeId of path.logicalEdgeIds) {
        expect(covered.has(edgeId)).toBe(false)
        covered.add(edgeId)
      }
    }
    expect(covered.size).toBe(EXPECTED.edgeCount)
    for (const edgeId of mapModel.edges.keys()) {
      expect(covered.has(edgeId)).toBe(true)
    }
  })

  it('静态几何规模与节点实例数据正确（一个 InstancedMesh 渲染全部节点）', () => {
    // P1-4 中线虚线化 + P0-5.3 端部截除：顶点数 = 按弧长相位切分的可见实段
    // 数 × 2（与实现同一周期/截除常量独立走一遍相位模拟作为合同锁定；模拟
    // 以链为单位，交叉端截除补面半径、断头端截除半路宽）
    const DASH_ON = CENTERLINE_DASH_ON_M
    const PERIOD = CENTERLINE_DASH_ON_M + CENTERLINE_DASH_OFF_M
    const halfWidth = PATH_SURFACE_WIDTH_M / 2
    const padRadius = halfWidth * JUNCTION_PAD_SCALE
    const trimOf = (nodeId: string): number =>
      (geometry.network.nodeDegree.get(nodeId) ?? 0) >= 3 ? padRadius : halfWidth

    let expectedDashPairs = 0
    for (const chain of geometry.network.chains) {
      const lengths: number[] = []
      let total = 0
      for (let i = 1; i < chain.points.length; i += 1) {
        const len = Math.hypot(
          chain.points[i].x - chain.points[i - 1].x,
          chain.points[i].y - chain.points[i - 1].y,
        )
        lengths.push(len)
        total += len
      }
      const keepFrom = Math.min(trimOf(chain.startNodeId), total)
      const keepTo = Math.max(total - trimOf(chain.endNodeId), keepFrom)
      let phase = 0
      let arc = 0
      for (const len of lengths) {
        let t = 0
        while (t < len) {
          const inDash = phase < DASH_ON
          const step = Math.min(inDash ? DASH_ON - phase : PERIOD - phase, len - t)
          if (inDash) {
            const from = Math.max(arc + t, keepFrom)
            const to = Math.min(arc + t + step, keepTo)
            if (to > from) {
              expectedDashPairs += 1
            }
          }
          t += step
          phase = (phase + step) % PERIOD
        }
        arc += len
      }
    }
    const centerline = geometry.pathsCenterline.getAttribute('position')
    expect(centerline.count).toBe(expectedDashPairs * 2)

    // P0-4 共享顶点条带 + P0-5.3 拓扑重建：每条链 = 2(S) 个关节顶点 + 断头
    // 端（度数 1）各 17 顶点圆帽；每个交叉节点（度数 ≥3）恰一个圆盘补面
    let expectedSurfaceVertices = 0
    let expectedSurfaceIndices = 0
    for (const chain of geometry.network.chains) {
      const capStart = (geometry.network.nodeDegree.get(chain.startNodeId) ?? 0) === 1
      const capEnd = (geometry.network.nodeDegree.get(chain.endNodeId) ?? 0) === 1
      expectedSurfaceVertices += 2 * chain.points.length
      expectedSurfaceVertices += (capStart ? 17 : 0) + (capEnd ? 17 : 0)
      expectedSurfaceIndices += (chain.points.length - 1) * 6
      expectedSurfaceIndices += (capStart ? 16 * 3 : 0) + (capEnd ? 16 * 3 : 0)
    }
    expectedSurfaceVertices += geometry.network.junctions.length * (1 + JUNCTION_PAD_SEGMENTS)
    expectedSurfaceIndices += geometry.network.junctions.length * JUNCTION_PAD_SEGMENTS * 3
    const surface = geometry.pathsSurface.getAttribute('position')
    expect(surface.count).toBe(expectedSurfaceVertices)
    expect(geometry.pathsSurface.getIndex()?.count).toBe(expectedSurfaceIndices)

    expect(geometry.nodeInstances.count).toBe(EXPECTED.nodeCount)
    expect(geometry.nodeInstances.matrices).toHaveLength(EXPECTED.nodeCount * 16)
    expect(geometry.nodeInstances.colors).toHaveLength(EXPECTED.nodeCount * 3)
    expect(geometry.nodeInstances.minLevels).toHaveLength(EXPECTED.nodeCount)
  }, 30_000)

  it('节点「1644」实例矩阵与世界坐标一致（A4 基准点的渲染侧对齐）', () => {
    const node = mapModel.nodes.get(EXPECTED.node1644.id)!
    const index = mapModel.nodeList.indexOf(node)
    const world = worldTransform.toWorldXZ(node.x, node.y)
    const m = index * 16
    // 实例矩阵为 Float32 存储，比较精度放宽到 float32 量级
    expect(geometry.nodeInstances.matrices[m + 12]).toBeCloseTo(world.x, 4)
    expect(geometry.nodeInstances.matrices[m + 14]).toBeCloseTo(world.z, 4)
    // work 节点颜色为蓝绿色（颜色表与实例颜色一致）
    const expected = new THREE.Color(NODE_COLORS.work)
    expect(geometry.nodeInstances.colors[index * 3]).toBeCloseTo(expected.r, 5)
    expect(geometry.nodeInstances.colors[index * 3 + 1]).toBeCloseTo(expected.g, 5)
    expect(geometry.nodeInstances.colors[index * 3 + 2]).toBeCloseTo(expected.b, 5)
  })

  it('静态几何可幂等释放', () => {
    const surfaceSpy = vi.spyOn(geometry.pathsSurface, 'dispose')
    const centerlineSpy = vi.spyOn(geometry.pathsCenterline, 'dispose')
    geometry.dispose()
    expect(surfaceSpy).toHaveBeenCalledTimes(1)
    expect(centerlineSpy).toHaveBeenCalledTimes(1)
    expect(() => geometry.dispose()).not.toThrow()
    surfaceSpy.mockRestore()
    centerlineSpy.mockRestore()
  })
})

describe('当前地图（json/map.json）语义图层事实（TASK-005 / A1、A2）', () => {
  const { mapModel, worldTransform } = MODEL
  const geometry = buildMapGeometry(mapModel, worldTransform)
  const landmarks = buildLandmarkData(mapModel, worldTransform)
  const exclusive = buildExclusiveGroupsGeometry(mapModel, worldTransform, geometry.physical)

  it('充电语义数量正确：59 个充电桩实例，位置与 charge 节点世界坐标一致', () => {
    expect(landmarks.chargeCount).toBe(59)
    expect(landmarks.chargeMatrices).toHaveLength(59 * 16)
    const chargeNodes = mapModel.nodeList.filter((node) => node.category === 'charge')
    expect(chargeNodes).toHaveLength(59)
    // 抽验首个充电节点：矩阵平移列与统一世界坐标一致
    const world = worldTransform.toWorldXZ(chargeNodes[0].x, chargeNodes[0].y)
    expect(landmarks.chargeMatrices[12]).toBeCloseTo(world.x, 4)
    expect(landmarks.chargeMatrices[14]).toBeCloseTo(world.z, 4)
  })

  it('地面标识数量正确（P2-2）：1,185 块仓库方垫 + 2 块停车凸起 slab，颜色按节点序逐块核对', () => {
    expect(landmarks.warehousePadCount).toBe(1185)
    expect(landmarks.warehousePadMatrices).toHaveLength(1185 * 16)
    expect(landmarks.warehousePadColors).toHaveLength(1185 * 3)
    expect(landmarks.parkSlabCount).toBe(2)
    expect(landmarks.parkSlabMatrices).toHaveLength(2 * 16)
    expect(landmarks.parkHaloMatrices).toHaveLength(2 * 16)
    // P0-5：仓库名称锚点已整体移除，停车锚点保留
    expect('warehouseNameAnchors' in landmarks).toBe(false)
    expect(landmarks.parkAnchors).toHaveLength(2)

    // 仓库方垫按节点遍历序逐块核对：颜色与仓库色表一致（节点序与方垫序同源）
    let padIndex = 0
    for (const node of mapModel.nodeList) {
      if (node.category !== 'warehouse') {
        continue
      }
      const expected = new THREE.Color(NODE_COLORS.warehouse)
      expect(landmarks.warehousePadColors[padIndex * 3]).toBeCloseTo(expected.r, 5)
      expect(landmarks.warehousePadColors[padIndex * 3 + 1]).toBeCloseTo(expected.g, 5)
      expect(landmarks.warehousePadColors[padIndex * 3 + 2]).toBeCloseTo(expected.b, 5)
      // 矩阵平移列与节点世界坐标一致
      const world = worldTransform.toWorldXZ(node.x, node.y)
      expect(landmarks.warehousePadMatrices[padIndex * 16 + 12]).toBeCloseTo(world.x, 4)
      expect(landmarks.warehousePadMatrices[padIndex * 16 + 14]).toBeCloseTo(world.z, 4)
      padIndex += 1
    }
    expect(padIndex).toBe(1185)

    // 停车 slab：平移列与停车节点世界坐标一致，y 缩放 = 板厚（P2-2）
    const parkNodes = mapModel.nodeList.filter((node) => node.category === 'park')
    for (let i = 0; i < parkNodes.length; i += 1) {
      const world = worldTransform.toWorldXZ(parkNodes[i].x, parkNodes[i].y)
      expect(landmarks.parkSlabMatrices[i * 16 + 12]).toBeCloseTo(world.x, 4)
      expect(landmarks.parkSlabMatrices[i * 16 + 14]).toBeCloseTo(world.z, 4)
      expect(landmarks.parkSlabMatrices[i * 16 + 5]).toBeCloseTo(PARK_SLAB_HEIGHT_M, 5)
    }
  })

  it('名称条目收集（P0-5）：仓库节点名称不再收集，仅 7 分组 + 1 停车字形，key 全部唯一', () => {
    const labels = collectMapNameLabels(mapModel)
    expect(labels).toHaveLength(7 + 1)
    const keys = new Set(labels.map((label) => label.key))
    expect(keys.size).toBe(labels.length)
    // 分组名称为「独占区1~7」，随后是停车字形；无任何 node: 前缀条目
    expect(labels[0]).toMatchObject({ text: '独占区1' })
    expect(labels[6]).toMatchObject({ text: '独占区7' })
    expect(labels[7]).toMatchObject({ key: '__park_glyph__', text: 'P' })
    expect(labels.some((label) => label.key.startsWith('node:'))).toBe(false)
  })

  it('名称图集布局可容纳当前全部名称：无丢弃、画布尺寸不超过上限', () => {
    const labels = collectMapNameLabels(mapModel)
    // 近似真实字体度量：ASCII 每字符 11px、CJK 每字符 20px（确定性可复现）
    const layout = layoutNameAtlas(labels, {
      fontPx: MAP_NAME_FONT_PX,
      paddingPx: MAP_NAME_PADDING_PX,
      canvasWidth: MAP_NAME_CANVAS_WIDTH,
      maxHeight: MAP_NAME_CANVAS_MAX_HEIGHT,
      measure: (text) => {
        let total = 0
        for (const char of text) {
          total += char.charCodeAt(0) > 0x2e80 ? 20 : 11
        }
        return total
      },
    })
    expect(layout.droppedKeys).toEqual([])
    expect(layout.cells.size).toBe(labels.length)
    expect(layout.height).toBeLessThanOrEqual(MAP_NAME_CANVAS_MAX_HEIGHT)
  })

  it('7 个独占区：名称锚点齐全，成员物理路径全部有效并合并为单个外沿几何', () => {
    expect(exclusive.nameAnchors).toHaveLength(7)
    // 全部分组成员边 → 物理路径映射必然存在（校验后地图无悬空引用），
    // 去重后的物理路径数 = 直接从索引重算的集合大小
    const direct = new Set<number>()
    for (const group of mapModel.groupList) {
      for (const edgeId of group.memberEdgeIds) {
        direct.add(geometry.physical.physicalPathIndexOfEdge.get(edgeId)!)
      }
    }
    expect(exclusive.usedPhysicalPathCount).toBe(direct.size)
    expect(exclusive.usedPhysicalPathCount).toBeGreaterThan(0)

    // 单个合并几何（P0-4 条带合同）：每条路径 = 2(S+1) 关节顶点 + 双端圆帽 34
    let expectedVertices = 0
    let expectedIndices = 0
    for (const pathIndex of direct) {
      const segments = geometry.physical.physicalPaths[pathIndex].points.length - 1
      expectedVertices += 2 * (segments + 1) + 2 * 17
      expectedIndices += segments * 6 + 2 * 16 * 3
    }
    const position = exclusive.outline.getAttribute('position')
    expect(position.count).toBe(expectedVertices)
    expect(exclusive.outline.getIndex()?.count).toBe(expectedIndices)

    // 锚点为成员节点包围盒中心：抽验首分组（单调世界坐标范围）
    const first = mapModel.groupList[0]
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const nodeId of first.memberNodeIds) {
      const node = mapModel.nodes.get(nodeId)!
      const world = worldTransform.toWorldXZ(node.x, node.y)
      minX = Math.min(minX, world.x)
      maxX = Math.max(maxX, world.x)
      minZ = Math.min(minZ, world.z)
      maxZ = Math.max(maxZ, world.z)
    }
    const anchor = exclusive.nameAnchors.find((item) => item.groupId === first.id)!
    expect(anchor.x).toBeCloseTo((minX + maxX) / 2, 6)
    expect(anchor.z).toBeCloseTo((minZ + maxZ) / 2, 6)
  })

  it('语义层构建产物可幂等释放', () => {
    const outlineSpy = vi.spyOn(exclusive.outline, 'dispose')
    exclusive.dispose()
    expect(outlineSpy).toHaveBeenCalledTimes(1)
    expect(() => exclusive.dispose()).not.toThrow()
    outlineSpy.mockRestore()
  })
})
