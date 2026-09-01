/**
 * Mock 仿真内核单元测试（TASK-008：固定种子复现、比例分配、限速推进、
 * 大时间差不累积、死路/无充电路径安全停车与完整充电循环）。
 */
import { describe, expect, it } from 'vitest'
import {
  allocateByEdgeProportion,
  createMockSimulationKernel,
} from '@/features/mock-simulation/model/simulationKernel'
import { buildModel, makeLineEdge, makeNode } from './fixtures'

/** 有向充电环 W→C→W2→W：任意位置出发都可在首次到站后寻得 charge */
function buildChargeCycle() {
  return buildModel({
    nodes: [
      makeNode({ id: 'w', name: 'W', x: 0, y: 0 }),
      makeNode({ id: 'c', name: 'C', type: 'charge', x: 10, y: 0 }),
      makeNode({ id: 'w2', name: 'W2', x: 10, y: 10 }),
    ],
    edges: [
      makeLineEdge({ id: 'e-w-c', sx: 0, sy: 0, ex: 10, ey: 0, snodeId: 'w', enodeId: 'c' }),
      makeLineEdge({ id: 'e-c-w2', sx: 10, sy: 0, ex: 10, ey: 10, snodeId: 'c', enodeId: 'w2' }),
      makeLineEdge({ id: 'e-w2-w', sx: 10, sy: 10, ex: 0, ey: 0, snodeId: 'w2', enodeId: 'w' }),
    ],
  })
}

/** 单条长直边 A→B：可控的恒速推进（无到站、无分岔） */
function buildStraightLine(length: number, speedOverrides: Record<string, unknown> = {}) {
  return buildModel({
    nodes: [
      makeNode({ id: 'a', x: 0, y: 0 }),
      makeNode({ id: 'b', x: length, y: 0 }),
    ],
    edges: [
      makeLineEdge({
        id: 'e-ab', sx: 0, sy: 0, ex: length, ey: 0,
        snodeId: 'a', enodeId: 'b', ...speedOverrides,
      }),
    ],
  })
}

describe('allocateByEdgeProportion（最大余额法）', () => {
  it('整除时严格按逻辑边数量比例分配', () => {
    expect(allocateByEdgeProportion([6, 3, 1], 10)).toEqual([6, 3, 1])
  })

  it('非整除时余数按份额小数降序、分量序号升序补齐', () => {
    // 份额均为 0.5：并列时低序号分量优先
    expect(allocateByEdgeProportion([1, 1, 1, 1], 2)).toEqual([1, 1, 0, 0])
  })

  it('零边分量为 0，总和恰等于车辆数', () => {
    const counts = allocateByEdgeProportion([0, 10], 5)
    expect(counts).toEqual([0, 5])
  })

  it('车辆数为 0 或总边数为 0 时全部为 0', () => {
    expect(allocateByEdgeProportion([4, 6], 0)).toEqual([0, 0])
    expect(allocateByEdgeProportion([0, 0], 7)).toEqual([0, 0])
  })
})

describe('createMockSimulationKernel', () => {
  it('固定种子下创建状态与推进轨迹逐步全等复现', () => {
    const map = buildChargeCycle()
    const options = {
      vehicleCount: 8,
      seed: 20260901,
      initialBatteryMinPercent: 40,
      initialBatteryMaxPercent: 90,
    } as const
    const a = createMockSimulationKernel(map, options)
    const b = createMockSimulationKernel(map, options)
    expect(JSON.stringify(a.getVehicleStates())).toBe(JSON.stringify(b.getVehicleStates()))
    const dts = [0.7, 0.13, 1, 0.31, 0.9, 0.42, 1, 0.05, 0.66, 0.28]
    for (let round = 0; round < 20; round += 1) {
      for (const dt of dts) {
        a.step(dt)
        b.step(dt)
      }
      expect(JSON.stringify(a.getVehicleStates())).toBe(JSON.stringify(b.getVehicleStates()))
    }
  })

  it('不同种子产生不同的创建状态与推进轨迹', () => {
    const map = buildChargeCycle()
    const a = createMockSimulationKernel(map, { vehicleCount: 8, seed: 1 })
    const b = createMockSimulationKernel(map, { vehicleCount: 8, seed: 2 })
    const beforeA = JSON.stringify(a.getVehicleStates())
    const beforeB = JSON.stringify(b.getVehicleStates())
    expect(beforeA).not.toBe(beforeB)
    for (let i = 0; i < 50; i += 1) {
      a.step(0.5)
      b.step(0.5)
    }
    expect(JSON.stringify(a.getVehicleStates())).not.toBe(JSON.stringify(b.getVehicleStates()))
  })

  it('限速钳制：空载按 maxFreeSpeed、载荷按 maxLoadSpeed 精确推进', () => {
    const map = buildStraightLine(10, { maxFreeSpeed: 0.5, maxLoadSpeed: 0.3 })
    // 目标速度采样下限 0.5：空载恰为限速 0.5；载荷被钳到 0.3（位移从初始位置起算）
    const free = createMockSimulationKernel(map, {
      vehicleCount: 1, seed: 7, loadedProbability: 0,
    })
    const loaded = createMockSimulationKernel(map, {
      vehicleCount: 1, seed: 7, loadedProbability: 1,
    })
    const freeStart = free.getVehicleStates()[0].position.x
    const loadedStart = loaded.getVehicleStates()[0].position.x
    free.step(1)
    loaded.step(1)
    expect(free.getVehicleStates()[0].position.x - freeStart).toBeCloseTo(0.5, 9)
    expect(loaded.getVehicleStates()[0].position.x - loadedStart).toBeCloseTo(0.3, 9)
    free.step(1)
    loaded.step(1)
    expect(free.getVehicleStates()[0].position.x - freeStart).toBeCloseTo(1, 9)
    expect(loaded.getVehicleStates()[0].position.x - loadedStart).toBeCloseTo(0.6, 9)
  })

  it('等时长不同步长的推进在不发生模式切换时落点一致（弧长步长不变性）', () => {
    const map = buildStraightLine(100)
    const coarse = createMockSimulationKernel(map, {
      vehicleCount: 1, seed: 11, loadedProbability: 0,
    })
    const fine = createMockSimulationKernel(map, {
      vehicleCount: 1, seed: 11, loadedProbability: 0,
    })
    for (let i = 0; i < 10; i += 1) {
      coarse.step(1)
    }
    for (let i = 0; i < 20; i += 1) {
      fine.step(0.5)
    }
    const a = coarse.getVehicleStates()[0].position
    const b = fine.getVehicleStates()[0].position
    expect(a.x).toBeCloseTo(b.x, 9)
    expect(a.y).toBeCloseTo(b.y, 9)
  })

  it('大时间差不累积位移：单步只推进钳制时长对应的里程', () => {
    const map = buildStraightLine(10000, { maxFreeSpeed: 2, maxLoadSpeed: 2 })
    const kernel = createMockSimulationKernel(map, {
      vehicleCount: 1, seed: 3, loadedProbability: 0, maxStepSeconds: 1,
    })
    const startX = kernel.getVehicleStates()[0].position.x
    kernel.step(600)
    // 后台 600s 只按 1s 钳制推进：位移 = 目标速度 × 1s（≤1.5m），
    // 而不是目标速度 × 600s
    const afterGap = kernel.getVehicleStates()[0].position.x - startX
    expect(afterGap).toBeGreaterThan(0)
    expect(afterGap).toBeLessThanOrEqual(1.5 + 1e-9)
    // 之后正常推进：同速再走 1s，位移与钳制步一致（速度未受大时间差影响）
    kernel.step(1)
    const afterStep = kernel.getVehicleStates()[0].position.x - startX
    expect(afterStep - afterGap).toBeCloseTo(afterGap, 9)
    // 非有限与负值 dt 为无操作
    kernel.step(Number.NaN)
    kernel.step(-1)
    expect(kernel.getVehicleStates()[0].position.x - startX).toBeCloseTo(afterStep, 9)
  })

  it('极短边长链上单步换边有界，推进持续且状态有限', () => {
    // 1000 条 0.01m 的链：1.5m/s 的一步理论跨越 150 条边，被单步 64 条上限
    // 截断为 ≈0.64m。50 台车分散放置，接近链尾的个别车可能安全停驶（合法），
    // 未受阻车辆的单步位移必须落在上限区间内。
    const nodeCount = 1001
    const nodes = Array.from({ length: nodeCount }, (_, i) =>
      makeNode({ id: `n${i}`, x: i * 0.01, y: 0 }))
    const edges = Array.from({ length: nodeCount - 1 }, (_, i) =>
      makeLineEdge({
        id: `e${i}`, sx: i * 0.01, sy: 0, ex: (i + 1) * 0.01, ey: 0,
        snodeId: `n${i}`, enodeId: `n${i + 1}`,
      }))
    const map = buildModel({ nodes, edges })
    const kernel = createMockSimulationKernel(map, {
      vehicleCount: 50, seed: 5, loadedProbability: 0,
    })
    const startPositions = kernel.getVehicleStates().map((s) => s.position.x)
    kernel.step(1)
    let unblockedCount = 0
    let capProven = false
    const states = kernel.getVehicleStates()
    for (let i = 0; i < states.length; i += 1) {
      const state = states[i]
      expect(Number.isFinite(state.position.x)).toBe(true)
      expect(Number.isFinite(state.position.theta)).toBe(true)
      if (state.mode === 'IDLE_BLOCKED') {
        // 抵达链尾安全停车：位置不越过链尾
        expect(state.blockedReason).toBe('DEAD_END')
        expect(state.position.x).toBeLessThanOrEqual(10.0001)
        continue
      }
      unblockedCount += 1
      const moved = state.position.x - startPositions[i]
      // 位移受「时间预算」与「单步 64 次换边（≈0.64m）」双重上界约束
      expect(moved).toBeGreaterThan(0)
      expect(moved).toBeLessThanOrEqual(Math.max(state.targetSpeed, 0.66))
      if (state.targetSpeed >= 0.7) {
        // 时间预算 0.7m 充足：位移被换边上限截断在 0.65m（含初始段）
        expect(moved).toBeLessThanOrEqual(0.66)
        capProven = true
      }
    }
    // 50 台车目标速度全部低于 0.7 的概率为零：上限必然被至少一台证实
    expect(unblockedCount).toBeGreaterThan(0)
    expect(capProven).toBe(true)
    // 第二步继续有界推进（累计不越过两次上限）
    kernel.step(1)
    for (let i = 0; i < states.length; i += 1) {
      const state = states[i]
      if (state.mode === 'IDLE_BLOCKED') {
        continue
      }
      const moved = state.position.x - startPositions[i]
      expect(moved).toBeLessThanOrEqual(1.32)
    }
  })

  it('死路安全停车：停在节点进入 IDLE 并产生 Mock 死路告警', () => {
    // A→B→D，D 无出边（SPEC §9.1 合法死路拓扑）
    const map = buildModel({
      nodes: [
        makeNode({ id: 'a', x: 0, y: 0 }),
        makeNode({ id: 'b', x: 5, y: 0 }),
        makeNode({ id: 'd', x: 9, y: 0 }),
      ],
      edges: [
        makeLineEdge({ id: 'e-ab', sx: 0, sy: 0, ex: 5, ey: 0, snodeId: 'a', enodeId: 'b' }),
        makeLineEdge({ id: 'e-bd', sx: 5, sy: 0, ex: 9, ey: 0, snodeId: 'b', enodeId: 'd' }),
      ],
    })
    const kernel = createMockSimulationKernel(map, {
      vehicleCount: 1, seed: 21, initialBatteryMinPercent: 90, initialBatteryMaxPercent: 90,
    })
    for (let i = 0; i < 100 && kernel.getVehicleStates()[0].mode !== 'IDLE_BLOCKED'; i += 1) {
      kernel.step(1)
    }
    const vehicle = kernel.getVehicleStates()[0]
    expect(vehicle.mode).toBe('IDLE_BLOCKED')
    expect(vehicle.blockedReason).toBe('DEAD_END')
    expect(vehicle.mockAlerts).toContain('MOCK_DEAD_END')
    expect(vehicle.anchorNodeId).toBe('d')
    const frozen = { ...vehicle.position }
    kernel.step(1)
    kernel.step(10)
    expect(vehicle.position.x).toBe(frozen.x)
    expect(vehicle.position.y).toBe(frozen.y)
  })

  it('无充电路径安全停车：停在当前位置并产生 Mock 数据告警，不跨分量传送', () => {
    // 分量内没有任何 charge：低电量车寻充失败后必须原地停驶
    const map = buildModel({
      nodes: [
        makeNode({ id: 'a', x: 0, y: 0 }),
        makeNode({ id: 'b', x: 4, y: 0 }),
      ],
      edges: [
        makeLineEdge({ id: 'e-ab', sx: 0, sy: 0, ex: 4, ey: 0, snodeId: 'a', enodeId: 'b' }),
      ],
    })
    const kernel = createMockSimulationKernel(map, {
      vehicleCount: 1, seed: 13,
      initialBatteryMinPercent: 20, initialBatteryMaxPercent: 20,
    })
    for (let i = 0; i < 50 && kernel.getVehicleStates()[0].mode !== 'IDLE_BLOCKED'; i += 1) {
      kernel.step(1)
    }
    const vehicle = kernel.getVehicleStates()[0]
    expect(vehicle.mode).toBe('IDLE_BLOCKED')
    expect(vehicle.blockedReason).toBe('NO_CHARGE_PATH')
    expect(vehicle.mockAlerts).toContain('MOCK_NO_CHARGE_PATH')
    // 停在分量边上：坐标仍是有限的边内位置，之后保持冻结
    expect(Number.isFinite(vehicle.position.x)).toBe(true)
    const frozen = { ...vehicle.position }
    kernel.step(1)
    expect(vehicle.position.x).toBe(frozen.x)
  })

  it('完整充电循环：低电量寻充 → 到站充电 → 充至 90% 恢复任务', () => {
    const map = buildChargeCycle()
    const kernel = createMockSimulationKernel(map, {
      vehicleCount: 1, seed: 99,
      initialBatteryMinPercent: 20, initialBatteryMaxPercent: 20,
      chargeRatePercentPerSecond: 1000,
    })
    let sawCharging = false
    let resumeSteps = 0
    for (let i = 0; i < 200; i += 1) {
      kernel.step(1)
      const vehicle = kernel.getVehicleStates()[0]
      if (vehicle.mode === 'CHARGING') {
        sawCharging = true
        // 充电中停靠在充电节点 (10,0)，charging 标志为真
        expect(vehicle.position.x).toBeCloseTo(10, 6)
        expect(vehicle.position.y).toBeCloseTo(0, 6)
        expect(vehicle.charging).toBe(true)
        continue
      }
      if (sawCharging && vehicle.mode === 'CRUISE') {
        // 充至 90% 后恢复任务：charging 复位、电量保持目标附近（恢复后行驶
        // 会按里程正常耗电，允许少量下降）、重新起步
        expect(vehicle.charging).toBe(false)
        expect(vehicle.batteryPercent).toBeGreaterThanOrEqual(89.5)
        resumeSteps += 1
        if (resumeSteps >= 2) {
          break
        }
      }
    }
    expect(sawCharging).toBe(true)
    expect(resumeSteps).toBeGreaterThanOrEqual(2)
    expect(kernel.getVehicleStates()[0].mode).toBe('CRUISE')
  })

  it('充电完成后从充电节点沿出边继续行驶（不原地卡死）', () => {
    const map = buildChargeCycle()
    const kernel = createMockSimulationKernel(map, {
      vehicleCount: 1, seed: 99,
      initialBatteryMinPercent: 20, initialBatteryMaxPercent: 20,
      chargeRatePercentPerSecond: 1000,
    })
    // 推进到「充完电恢复 CRUISE」的状态出现为止（充电前电量 20 < 90 不可能误判）
    for (let i = 0; i < 100; i += 1) {
      kernel.step(1)
      const state = kernel.getVehicleStates()[0]
      if (state.mode === 'CRUISE' && !state.charging && state.batteryPercent >= 90) {
        break
      }
    }
    expect(kernel.getVehicleStates()[0].batteryPercent).toBeGreaterThanOrEqual(90)
    // 恢复后再推进：位置离开充电节点
    const before = { ...kernel.getVehicleStates()[0].position }
    for (let i = 0; i < 10; i += 1) {
      kernel.step(1)
    }
    const after = kernel.getVehicleStates()[0].position
    const moved = Math.hypot(after.x - before.x, after.y - before.y)
    expect(moved).toBeGreaterThan(0.1)
    expect(kernel.getVehicleStates()[0].mode).toBe('CRUISE')
  })

  it('dt ≤ 0 为无操作，车辆状态保持不变', () => {
    const map = buildStraightLine(100)
    const kernel = createMockSimulationKernel(map, { vehicleCount: 2, seed: 1 })
    const before = JSON.stringify(kernel.getVehicleStates())
    kernel.step(0)
    kernel.step(-3)
    expect(JSON.stringify(kernel.getVehicleStates())).toBe(before)
  })

  it('车辆数为 0 时内核为空车队且推进无操作', () => {
    const map = buildStraightLine(100)
    const kernel = createMockSimulationKernel(map, { vehicleCount: 0, seed: 1 })
    expect(kernel.getVehicleStates()).toHaveLength(0)
    expect(() => kernel.step(1)).not.toThrow()
  })
})
