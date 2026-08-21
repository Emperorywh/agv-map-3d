import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  AGV_DEFAULT_COUNT,
  DEGRADE_SCALE_MAX_AGVS,
  DEGRADE_SCALE_MAX_EDGES,
  DEGRADE_SCALE_MAX_NODES,
} from '../../config/constants'
import { normalizeMapFromJson } from '../../domain/normalize'
import {
  DEGRADE_LEVEL_MEASURE_NAMES,
  DEGRADE_LEVEL_NONE,
  DEGRADE_LEVEL_SHADOWS_OFF,
  DEGRADE_MAX_LEVEL,
  createFpsDegradeController,
  resolveScaleDegradeLevel,
} from './degradation'
import type { DegradeScaleLimits, FpsDegradeConfig } from './degradation'

/** 生产规模上限（与 DegradationController 注入同源的 config 常量） */
const LIMITS: DegradeScaleLimits = {
  maxNodes: DEGRADE_SCALE_MAX_NODES,
  maxEdges: DEGRADE_SCALE_MAX_EDGES,
  maxAgvs: DEGRADE_SCALE_MAX_AGVS,
}

const FPS_CONFIG: FpsDegradeConfig = {
  fpsThreshold: 55,
  warmupWindows: 2,
  sustainedWindows: 3,
  maxLevel: DEGRADE_MAX_LEVEL,
}

describe('degradation：规模触发（SPEC §9：~1800 节点 / ~3000 边 / 100 AGV 内不触发）', () => {
  it('各维度均在限内 → 0 级；恰好等于上限（> 才超）→ 0 级', () => {
    expect(
      resolveScaleDegradeLevel({ nodes: 1767, edges: 3043, agvs: 20 }, LIMITS),
    ).toBe(DEGRADE_LEVEL_NONE)
    expect(
      resolveScaleDegradeLevel(
        { nodes: LIMITS.maxNodes, edges: LIMITS.maxEdges, agvs: LIMITS.maxAgvs },
        LIMITS,
      ),
    ).toBe(DEGRADE_LEVEL_NONE)
  })

  it('节点 / 有向边 / AGV 任一维度超限 → 1 级（关阴影）', () => {
    expect(
      resolveScaleDegradeLevel({ nodes: LIMITS.maxNodes + 1, edges: 0, agvs: 0 }, LIMITS),
    ).toBe(DEGRADE_LEVEL_SHADOWS_OFF)
    expect(
      resolveScaleDegradeLevel({ nodes: 0, edges: LIMITS.maxEdges + 1, agvs: 0 }, LIMITS),
    ).toBe(DEGRADE_LEVEL_SHADOWS_OFF)
    expect(
      resolveScaleDegradeLevel({ nodes: 0, edges: 0, agvs: LIMITS.maxAgvs + 1 }, LIMITS),
    ).toBe(DEGRADE_LEVEL_SHADOWS_OFF)
  })

  it('真实 map.json 规模（1767 / 3043 / 20 台）按生产阈值不触发降级', () => {
    const mapJsonPath = fileURLToPath(new URL('../../../public/map.json', import.meta.url))
    const { map } = normalizeMapFromJson(readFileSync(mapJsonPath, 'utf8'))
    const level = resolveScaleDegradeLevel(
      { nodes: map.nodes.length, edges: map.edges.length, agvs: AGV_DEFAULT_COUNT },
      LIMITS,
    )
    expect(level).toBe(DEGRADE_LEVEL_NONE)
  })
})

describe('degradation：帧率触发（按序升档、只升不降）', () => {
  it('热身窗口内的低帧率不参与判定', () => {
    const controller = createFpsDegradeController(FPS_CONFIG, 0)
    expect(controller.pushWindowFps(10)).toBe(0)
    expect(controller.pushWindowFps(10)).toBe(0)
    // 热身结束后需重新累计持续窗口
    expect(controller.pushWindowFps(10)).toBe(0)
    expect(controller.pushWindowFps(10)).toBe(0)
    expect(controller.pushWindowFps(10)).toBe(1)
  })

  it('帧率持续不足才升一级；达标窗口清零持续计数（短暂抖动不误触）', () => {
    const controller = createFpsDegradeController(FPS_CONFIG, 0)
    // 热身 2 窗
    controller.pushWindowFps(60)
    controller.pushWindowFps(60)
    // 不足 → 不足 → 达标（计数清零）→ 不足 → 不足：仍未升档
    expect(controller.pushWindowFps(50)).toBe(0)
    expect(controller.pushWindowFps(50)).toBe(0)
    expect(controller.pushWindowFps(60)).toBe(0)
    expect(controller.pushWindowFps(50)).toBe(0)
    expect(controller.pushWindowFps(50)).toBe(0)
    // 连续第 3 个不足窗口 → 升 1 级
    expect(controller.pushWindowFps(50)).toBe(1)
    expect(controller.getLevel()).toBe(1)
  })

  it('边界：窗口均值等于阈值不算不足（< 才不足）', () => {
    const controller = createFpsDegradeController(FPS_CONFIG, 0)
    controller.pushWindowFps(60)
    controller.pushWindowFps(60)
    expect(controller.pushWindowFps(55)).toBe(0)
    expect(controller.pushWindowFps(55)).toBe(0)
    expect(controller.pushWindowFps(55)).toBe(0)
    expect(controller.pushWindowFps(55)).toBe(0)
    expect(controller.getLevel()).toBe(0)
  })

  it('逐级按序升档并封顶 maxLevel；升档后须重新累计持续窗口', () => {
    const controller = createFpsDegradeController(FPS_CONFIG, 0)
    const feed = (fps: number, windows: number) => {
      let level = 0
      for (let i = 0; i < windows; i++) {
        level = controller.pushWindowFps(fps)
      }
      return level
    }
    feed(60, FPS_CONFIG.warmupWindows)
    // 每 3 个持续不足窗口升一级：1 → 2 → 3，之后封顶
    expect(feed(30, FPS_CONFIG.sustainedWindows)).toBe(1)
    expect(feed(30, FPS_CONFIG.sustainedWindows - 1)).toBe(1)
    expect(feed(30, 1)).toBe(2)
    expect(feed(30, FPS_CONFIG.sustainedWindows)).toBe(3)
    expect(feed(30, FPS_CONFIG.sustainedWindows * 2)).toBe(DEGRADE_MAX_LEVEL)
    expect(controller.getLevel()).toBe(DEGRADE_MAX_LEVEL)
  })

  it('只升不降：升档后帧率恢复也不自动降回（防阈值附近来回抖动）', () => {
    const controller = createFpsDegradeController(FPS_CONFIG, 0)
    controller.pushWindowFps(60)
    controller.pushWindowFps(60)
    controller.pushWindowFps(30)
    controller.pushWindowFps(30)
    expect(controller.pushWindowFps(30)).toBe(1)
    // 帧率长期恢复，等级保持 1 级
    for (let i = 0; i < 10; i++) {
      expect(controller.pushWindowFps(60)).toBe(1)
    }
  })

  it('规模基数作为下限：baseLevel 直接生效，帧率升级在其上继续；baseLevel 超上限被钳制', () => {
    const fromBase = createFpsDegradeController(FPS_CONFIG, 1)
    expect(fromBase.getLevel()).toBe(1)
    fromBase.pushWindowFps(60)
    fromBase.pushWindowFps(60)
    fromBase.pushWindowFps(30)
    fromBase.pushWindowFps(30)
    expect(fromBase.pushWindowFps(30)).toBe(2)

    const clamped = createFpsDegradeController(FPS_CONFIG, 99)
    expect(clamped.getLevel()).toBe(DEGRADE_MAX_LEVEL)
  })
})

describe('degradation：等级语义常量', () => {
  it('措施名与等级一一对应（索引 = 等级 - 1，覆盖 1..maxLevel）', () => {
    expect(DEGRADE_LEVEL_MEASURE_NAMES).toHaveLength(DEGRADE_MAX_LEVEL)
    expect(DEGRADE_LEVEL_MEASURE_NAMES).toEqual([
      '关阴影',
      '标签阈值收紧',
      '隐藏普通导航点',
    ])
  })
})
