/**
 * Mock 内核 × 当前真实地图集成测试（TASK-008；SPEC §9.1～§9.2）。
 *
 * 职责：从当前 json/map.json 重新计算并锁定 Mock 内核的拓扑事实：按逻辑边
 *       比例覆盖四个弱连通分量、车辆只在本分量的有向边上行驶、死路节点
 *       「44」安全隔离、真实曲线上寻充与推进可用。输入变化时直接更新本
 *       文件的期望值。
 * 关键不变量（当前输入）：
 * 1. 4 个弱连通分量全部获得车辆，数量符合最大余额法比例分配且每分量 ≥1；
 * 2. 推进后车辆恒在其所属分量的有向边上，位置恒为有限值且落在场景包围盒内；
 * 3. 低电量（20%）车队在真实地图上可完成「寻充 → 到站充电 → 充至 90%」；
 * 4. 死路节点「44」无出边：寻路与寻充都安全返回 null，不产生路径。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMapModel, validateMap } from '@/features/map-visualization'
import {
  createMockSimulationKernel,
  findDirectedPath,
  findNearestChargePath,
} from '@/features/mock-simulation'

// vitest 以仓库根为工作目录运行（与其他集成测试同口径）
const MAP_JSON_PATH = path.resolve(process.cwd(), 'json/map.json')
const RAW_MAP: unknown = JSON.parse(readFileSync(MAP_JSON_PATH, 'utf8'))
const MODEL = createMapModel(validateMap(RAW_MAP)).mapModel

/** 分量 → 本分量有向边 ID 集合（与内核建池同一规则：按起点归属） */
function componentEdgeIdSets(): Set<string>[] {
  const sets = MODEL.components.map(() => new Set<string>())
  for (const edge of MODEL.edgeList) {
    const index = MODEL.componentIndexOfNode.get(edge.snodeId)
    if (index !== undefined) {
      sets[index].add(edge.id)
    }
  }
  return sets
}

/** 节点地图坐标 AABB（内核位置是地图坐标；世界变换由渲染层负责） */
const MAP_BOUNDS = (() => {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const node of MODEL.nodeList) {
    minX = Math.min(minX, node.x)
    minY = Math.min(minY, node.y)
    maxX = Math.max(maxX, node.x)
    maxY = Math.max(maxY, node.y)
  }
  return { minX, minY, maxX, maxY }
})()

describe('真实地图上的车队分配', () => {
  it('四个分量全部获得车辆，数量符合按逻辑边比例的最大余额分配', () => {
    const kernel = createMockSimulationKernel(MODEL, { vehicleCount: 60, seed: 20260901 })
    const states = kernel.getVehicleStates()
    expect(states).toHaveLength(60)

    const edgeCounts = MODEL.components.map((c) => c.edgeCount)
    const totalEdges = edgeCounts.reduce((a, b) => a + b, 0)
    const perComponent = new Array<number>(MODEL.components.length).fill(0)
    for (const state of states) {
      perComponent[state.componentIndex] += 1
    }
    for (let i = 0; i < edgeCounts.length; i += 1) {
      const share = (60 * edgeCounts[i]) / totalEdges
      // 最大余额法性质：floor(share) ≤ count ≤ floor(share)+1
      expect(perComponent[i]).toBeGreaterThanOrEqual(Math.floor(share))
      expect(perComponent[i]).toBeLessThanOrEqual(Math.floor(share) + 1)
      // 每个含边分量至少 1 台（当前 4 个分量边数均远大于阈值）
      expect(perComponent[i]).toBeGreaterThanOrEqual(1)
    }
    expect(perComponent.reduce((a, b) => a + b, 0)).toBe(60)
  })

  it('每台车的初始位置都在其所属分量的有向边上且坐标有限', () => {
    const kernel = createMockSimulationKernel(MODEL, { vehicleCount: 60, seed: 20260901 })
    const sets = componentEdgeIdSets()
    for (const state of kernel.getVehicleStates()) {
      expect(state.currentEdgeId).not.toBeNull()
      expect(sets[state.componentIndex].has(state.currentEdgeId!)).toBe(true)
      expect(Number.isFinite(state.position.x)).toBe(true)
      expect(Number.isFinite(state.position.y)).toBe(true)
      expect(Number.isFinite(state.position.theta)).toBe(true)
      expect(state.position.x).toBeGreaterThanOrEqual(MAP_BOUNDS.minX - 1e-6)
      expect(state.position.x).toBeLessThanOrEqual(MAP_BOUNDS.maxX + 1e-6)
      expect(state.position.y).toBeGreaterThanOrEqual(MAP_BOUNDS.minY - 1e-6)
      expect(state.position.y).toBeLessThanOrEqual(MAP_BOUNDS.maxY + 1e-6)
    }
  })

  it('推进 150s 后拓扑守恒：车辆仍在本分量的有向边上，无 NaN、无越界', () => {
    const kernel = createMockSimulationKernel(MODEL, { vehicleCount: 60, seed: 20260901 })
    const sets = componentEdgeIdSets()
    for (let i = 0; i < 300; i += 1) {
      kernel.step(0.5)
    }
    for (const state of kernel.getVehicleStates()) {
      expect(Number.isFinite(state.position.x)).toBe(true)
      expect(Number.isFinite(state.position.y)).toBe(true)
      expect(Number.isFinite(state.position.theta)).toBe(true)
      if (state.currentEdgeId !== null) {
        expect(sets[state.componentIndex].has(state.currentEdgeId)).toBe(true)
      }
      expect(state.position.x).toBeGreaterThanOrEqual(MAP_BOUNDS.minX - 1e-6)
      expect(state.position.x).toBeLessThanOrEqual(MAP_BOUNDS.maxX + 1e-6)
      expect(state.position.y).toBeGreaterThanOrEqual(MAP_BOUNDS.minY - 1e-6)
      expect(state.position.y).toBeLessThanOrEqual(MAP_BOUNDS.maxY + 1e-6)
    }
  })

  it('同一地图同一配置的内核逐步全等（真实地图可复现性）', () => {
    const a = createMockSimulationKernel(MODEL, { vehicleCount: 60, seed: 20260901 })
    const b = createMockSimulationKernel(MODEL, { vehicleCount: 60, seed: 20260901 })
    for (let i = 0; i < 120; i += 1) {
      a.step(0.37)
      b.step(0.37)
    }
    expect(JSON.stringify(a.getVehicleStates())).toBe(JSON.stringify(b.getVehicleStates()))
  })
})

describe('真实地图上的寻充与充电循环', () => {
  it('低电量车队在固定窗口内完成「寻充 → 充电 → 充至 90% 恢复」', () => {
    const kernel = createMockSimulationKernel(MODEL, {
      vehicleCount: 60,
      seed: 20260901,
      initialBatteryMinPercent: 20,
      initialBatteryMaxPercent: 20,
      chargeRatePercentPerSecond: 1000,
    })
    let sawCharging = false
    let sawResumed = false
    for (let i = 0; i < 20000 && !sawResumed; i += 1) {
      kernel.step(1)
      for (const state of kernel.getVehicleStates()) {
        if (state.mode === 'CHARGING') {
          sawCharging = true
        } else if (sawCharging && state.mode === 'CRUISE' && !state.charging
          && state.batteryPercent >= 90) {
          sawResumed = true
        }
      }
    }
    expect(sawCharging).toBe(true)
    expect(sawResumed).toBe(true)
  })

  it('寻充只在本分量的有向拓扑上：路径链连续且终点是 charge 节点', () => {
    // 从节点「1644」（当前车辆夹具基准点）寻本分量最近充电点
    const start = MODEL.nodeList.find((node) => node.name === '1644')
    expect(start).toBeDefined()
    const componentIndex = MODEL.componentIndexOfNode.get(start!.id)!
    const path = findNearestChargePath(MODEL, start!.id, componentIndex)
    expect(path).not.toBeNull()
    expect(path!.edgeIds.length).toBeGreaterThan(0)
    const goal = MODEL.nodes.get(path!.goalNodeId)!
    expect(goal.category).toBe('charge')
    expect(MODEL.componentIndexOfNode.get(goal.id)).toBe(componentIndex)
    // 路径链连续：上一条边的终点是下一条边的起点（严格有向）
    for (let i = 0; i < path!.edgeIds.length - 1; i += 1) {
      const edge = MODEL.edges.get(path!.edgeIds[i])!
      const next = MODEL.edges.get(path!.edgeIds[i + 1])!
      expect(edge.enodeId).toBe(next.snodeId)
    }
    const firstEdge = MODEL.edges.get(path!.edgeIds[0])!
    expect(firstEdge.snodeId).toBe(start!.id)
  })
})

describe('真实地图死路拓扑', () => {
  it('无出边工作节点「44」：寻路与寻充安全返回 null', () => {
    const deadEnd = MODEL.nodeList.find((node) => node.name === '44')
    expect(deadEnd).toBeDefined()
    expect(deadEnd!.category).toBe('work')
    const outEdgeIds = MODEL.outEdgeIds.get(deadEnd!.id) ?? []
    expect(outEdgeIds).toHaveLength(0)
    const someOtherNode = MODEL.nodeList.find((node) => node.id !== deadEnd!.id)!
    expect(findDirectedPath(MODEL, deadEnd!.id, someOtherNode.id)).toBeNull()
    const componentIndex = MODEL.componentIndexOfNode.get(deadEnd!.id)!
    expect(findNearestChargePath(MODEL, deadEnd!.id, componentIndex)).toBeNull()
  })

  it('指向死路节点的行程可正常规划（死路是合法终点，不阻断寻路）', () => {
    // 找一条以「44」为终点的入边，反向不可达但正向（朝死路行驶）合法
    const deadEnd = MODEL.nodeList.find((node) => node.name === '44')!
    const inEdgeIds = MODEL.edgeList
      .filter((edge) => edge.enodeId === deadEnd.id)
      .map((edge) => edge.id)
    expect(inEdgeIds.length).toBeGreaterThan(0)
    const source = MODEL.edges.get(inEdgeIds[0])!.snodeId
    const path = findDirectedPath(MODEL, source, deadEnd.id)
    expect(path).not.toBeNull()
    expect(path!.goalNodeId).toBe(deadEnd.id)
  })
})
