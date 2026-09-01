/// <reference types="node" />
/*
 * 当前地图集成测试（TASK-003 验收核心：A1/A3/E2 的数据事实锁定）。
 *
 * 职责：从当前输入 json/map.json 重新计算并锁定 SPEC §2.3 的全部数据不变量，
 *       输入发生合法变化时，直接更新本文件中的期望值（不保留旧值说明）。
 * 关键不变量（当前输入）：
 * 1. 4,291 节点、9,265 逻辑边（5,963 LINE / 3,302 BEZIER）、7 个独占区、
 *    零丢失引用（校验异常为空）；
 * 2. 4 个弱连通分量，节点数 2,001 / 1,187 / 796 / 307，每个分量都含充电站；
 * 3. 存在无出边的工作节点（死路拓扑是合法输入，Mock 不得崩溃）；
 * 4. 节点「1644」存在且坐标与当前车辆夹具对齐（A4 基准点）；
 * 5. 全部逻辑边物理长度为正有限值。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMapModel } from '@/features/map-visualization/model/createMapModel'
import { validateMap } from '@/features/map-visualization/model/validateMap'

// vitest 以仓库根为工作目录运行（jsdom 下 import.meta.url 非 file: 协议）
const MAP_JSON_PATH = path.resolve(process.cwd(), 'json/map.json')
const RAW_MAP: unknown = JSON.parse(readFileSync(MAP_JSON_PATH, 'utf8'))

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
} as const

describe('当前地图（json/map.json）数据不变量', () => {
  const validated = validateMap(RAW_MAP)
  const { mapModel, worldTransform } = createMapModel(validated)

  it('节点、逻辑边与独占区数量符合当前输入，且零丢失引用（校验异常为空）', () => {
    expect(validated.anomalies).toEqual([])
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
