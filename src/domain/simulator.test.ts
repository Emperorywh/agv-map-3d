import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { worldToMap } from './coordinates'
import { buildCorridors } from './corridors'
import { normalizeMapFromJson } from './normalize'
import { distanceToPolyline, buildPolyline } from './polyline'
import {
  createSimulator,
  snapshotSimulator,
  stepSimulator,
  toExternalStatus,
} from './simulator'
import type { AgvSimState, SimulatorState } from './simulator'
import type {
  MapPoint,
  NodeKind,
  NormalizedEdge,
  NormalizedMap,
  NormalizedNode,
} from './types'

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

const DT = 0.1

function makeNode(id: string, kind: NodeKind, x: number, y: number, angle: number | null = null): NormalizedNode {
  return { id, name: id, kind, x, y, angle }
}

interface EdgeOverrides {
  points?: MapPoint[]
  sFacing?: number
  eFacing?: number
  isBackEdge?: boolean
  cost?: number
  maxSpeedFree?: number | null
  maxSpeedLoad?: number | null
  maxRotationSpeedFree?: number | null
  maxRotationSpeedLoad?: number | null
}

function makeEdge(id: string, from: string, to: string, overrides: EdgeOverrides = {}): NormalizedEdge {
  return {
    id,
    name: id,
    from,
    to,
    geometry: buildPolyline(overrides.points ?? [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]),
    sFacing: overrides.sFacing ?? 0,
    eFacing: overrides.eFacing ?? 0,
    isBackEdge: overrides.isBackEdge ?? false,
    cost: overrides.cost ?? 1,
    maxSpeedLoad: overrides.maxSpeedLoad ?? null,
    maxSpeedFree: overrides.maxSpeedFree ?? null,
    maxRotationSpeedLoad: overrides.maxRotationSpeedLoad ?? null,
    maxRotationSpeedFree: overrides.maxRotationSpeedFree ?? null,
    maxAccelerationLoad: null,
    maxAccelerationFree: null,
    maxDecelerationLoad: null,
    maxDecelerationFree: null,
  }
}

/** 构造一对反向边（几何严格互反，配对偏差为 0），返回两条有向边 */
function makeEdgePair(
  idForward: string,
  idBackward: string,
  a: string,
  b: string,
  pointsAB: MapPoint[],
  overrides: EdgeOverrides = {},
): NormalizedEdge[] {
  return [
    makeEdge(idForward, a, b, { ...overrides, points: pointsAB }),
    makeEdge(idBackward, b, a, { ...overrides, points: pointsAB.slice().reverse() }),
  ]
}

function makeMap(nodes: NormalizedNode[], edges: NormalizedEdge[]): NormalizedMap {
  return {
    calibration: { scale: 1, rotationRad: 0, offsetX: 0, offsetY: 0 },
    bounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 },
    floor: 1,
    nodes,
    edges,
    corridors: buildCorridors(edges).corridors,
  }
}

function runSteps(state: SimulatorState, steps: number, dt = DT): void {
  for (let i = 0; i < steps; i++) {
    stepSimulator(state, dt)
  }
}

/** 快照世界坐标 → 地图平面点（测试校准为恒等：world=(x,0,-y)） */
function snapshotMapPoint(state: SimulatorState, agvId: number): MapPoint {
  const snapshot = snapshotSimulator(state)[agvId]
  return worldToMap(snapshot.position, state.calibration)
}

/** 白盒：强制 AGV 0 进入指定路径（运动学用例专用，绕过任务决策与 PRNG） */
function forceDrive(
  state: SimulatorState,
  edgeIds: string[],
  fromNodeId: string,
  heading: number,
): AgvSimState {
  const agv = state.agvs[0]
  agv.state = 'TO_PICK'
  agv.routeEdgeIds = edgeIds
  agv.routeIndex = 0
  agv.legDistance = 0
  agv.speed = 0
  agv.legAligned = false
  agv.heading = heading
  agv.nodeId = fromNodeId
  agv.pickNodeId = 'w_drop_target'
  return agv
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 初始摆放（SPEC §7.1）
// ---------------------------------------------------------------------------

describe('simulator：初始摆放（SPEC §7.1）', () => {
  it('种子随机打乱占用 park（每节点至多一台），不足顺延 work（同样互斥）；初始 IDLE 满电', () => {
    const map = makeMap(
      [
        makeNode('p1', 'park', 0, 0, 1.1),
        makeNode('p2', 'park', 5, 0, -0.5),
        makeNode('w1', 'work', 0, 10),
        makeNode('w2', 'work', 5, 10),
        makeNode('w3', 'work', 10, 10),
        makeNode('c1', 'charge', 15, 0),
      ],
      [],
    )
    const state = createSimulator(map, { seed: 42, agvCount: 4 })

    expect(state.agvs).toHaveLength(4)
    const occupied = state.agvs.map((agv) => agv.nodeId!)
    // 每节点至多一台
    expect(new Set(occupied).size).toBe(4)
    // 先占满 park，再顺延 work
    expect(occupied.filter((id) => id === 'p1' || id === 'p2')).toHaveLength(2)
    expect(occupied.filter((id) => id.startsWith('w'))).toHaveLength(2)
    // 初始均 IDLE、满电；停靠期间车头对齐节点 angle（无 angle 取 0）
    for (const agv of state.agvs) {
      expect(agv.state).toBe('IDLE')
      expect(agv.battery).toBe(100)
      const node = map.nodes.find((item) => item.id === agv.nodeId)!
      expect(agv.heading).toBe(node.angle ?? 0)
    }
  })

  it('同一种子初始摆放完全一致', () => {
    const nodes = [
      ...Array.from({ length: 6 }, (_, i) => makeNode(`p${i}`, 'park', i * 5, 0)),
      makeNode('w1', 'work', 0, 10),
    ]
    const a = createSimulator(makeMap(nodes, []), { seed: 7, agvCount: 6 })
    const b = createSimulator(makeMap(nodes, []), { seed: 7, agvCount: 6 })
    expect(a.agvs.map((agv) => agv.nodeId)).toEqual(b.agvs.map((agv) => agv.nodeId))
  })

  it('park + work 全部占满仍不足：跳过无法摆放的 AGV 并告警计数（SPEC §10）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const map = makeMap([makeNode('p1', 'park', 0, 0)], [])
    const state = createSimulator(map, { seed: 1, agvCount: 3 })
    expect(state.agvs).toHaveLength(1)
    expect(state.agvs[0].nodeId).toBe('p1')
    expect(state.alertCount).toBe(2)
    expect(warn).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 任务流状态机（SPEC §7.1）
// ---------------------------------------------------------------------------

/** 全连通小图：park p1、work w1/w2、charge c1，全部双向走廊、朝向均 0 */
function makeTaskFlowMap(): NormalizedMap {
  return makeMap(
    [
      makeNode('p1', 'park', 0, 0),
      makeNode('w1', 'work', 10, 0),
      makeNode('w2', 'work', 10, 10),
      makeNode('c1', 'charge', 20, 0),
    ],
    [
      ...makeEdgePair('e_p1_w1', 'e_w1_p1', 'p1', 'w1', [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
      ...makeEdgePair('e_p1_w2', 'e_w2_p1', 'p1', 'w2', [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: 10, y: 10 },
      ]),
      ...makeEdgePair('e_w1_w2', 'e_w2_w1', 'w1', 'w2', [
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ]),
      ...makeEdgePair('e_p1_c1', 'e_c1_p1', 'p1', 'c1', [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ]),
    ],
  )
}

describe('simulator：任务流状态机（SPEC §7.1）', () => {
  it('完整任务循环：IDLE→TO_PICK→LOADING→TO_DROP→UNLOADING→IDLE，取货点 ≠ 卸货点', () => {
    const state = createSimulator(makeTaskFlowMap(), { seed: 42, agvCount: 1 })
    const agv = state.agvs[0]
    const sequence: string[] = [agv.state]
    let pickNodeId: string | null = null
    let dropNodeId: string | null = null
    let sawDrivingSnapshot = false
    let sawDockedSnapshot = false

    for (let i = 0; i < 600; i++) {
      stepSimulator(state, DT)
      if (sequence[sequence.length - 1] !== agv.state) {
        sequence.push(agv.state)
      }
      if (agv.state === 'TO_PICK') pickNodeId = agv.pickNodeId
      if (agv.state === 'TO_DROP') dropNodeId = agv.dropNodeId
      const snapshot = snapshotSimulator(state)[0]
      if (snapshot.edgeId !== null) {
        sawDrivingSnapshot = true
        expect(snapshot.nodeId).toBeNull()
        expect(Number.isFinite(snapshot.position.x)).toBe(true)
        expect(Number.isFinite(snapshot.yaw)).toBe(true)
      }
      if (snapshot.edgeId === null && snapshot.nodeId !== null) {
        sawDockedSnapshot = true
      }
    }

    // 状态机完整迁移序列（含任务完成回流 IDLE 后开始下一循环）
    const expected = ['IDLE', 'TO_PICK', 'LOADING', 'TO_DROP', 'UNLOADING', 'IDLE']
    let cursor = 0
    for (const item of sequence) {
      if (item === expected[cursor]) cursor++
      if (cursor === expected.length) break
    }
    expect(cursor).toBe(expected.length)
    expect(pickNodeId).not.toBeNull()
    expect(dropNodeId).not.toBeNull()
    expect(['w1', 'w2']).toContain(pickNodeId)
    expect(['w1', 'w2']).toContain(dropNodeId)
    expect(dropNodeId).not.toBe(pickNodeId)
    expect(sawDrivingSnapshot).toBe(true)
    expect(sawDockedSnapshot).toBe(true)
    // 行驶耗电：完成循环后电量低于满电
    expect(agv.battery).toBeLessThan(100)
    expect(state.alertCount).toBe(0)
  })

  it('任务完成回流 IDLE 后继续接新任务（至少两轮循环）', () => {
    const state = createSimulator(makeTaskFlowMap(), { seed: 42, agvCount: 1 })
    let completions = 0
    let previous = state.agvs[0].state
    for (let i = 0; i < 1200; i++) {
      stepSimulator(state, DT)
      const current = state.agvs[0].state
      if (previous === 'UNLOADING' && current === 'IDLE') {
        completions++
      }
      previous = current
    }
    expect(completions).toBeGreaterThanOrEqual(2)
  })

  it('对外状态集合：7 内部态 → 6 对外态，LOADING/UNLOADING 统称装卸中', () => {
    expect(toExternalStatus('IDLE')).toBe('idle')
    expect(toExternalStatus('TO_PICK')).toBe('toPick')
    expect(toExternalStatus('TO_DROP')).toBe('hauling')
    expect(toExternalStatus('TO_CHARGE')).toBe('toCharge')
    expect(toExternalStatus('CHARGING')).toBe('charging')
    expect(toExternalStatus('LOADING')).toBe('loading')
    expect(toExternalStatus('UNLOADING')).toBe('loading')
    // 与 SPEC §7.1 状态集合完全一致（对应 theme.agvStatusColors 六键）
    const external = new Set(
      (['IDLE', 'TO_PICK', 'LOADING', 'TO_DROP', 'UNLOADING', 'TO_CHARGE', 'CHARGING'] as const).map(
        toExternalStatus,
      ),
    )
    expect([...external].sort()).toEqual(
      ['charging', 'hauling', 'idle', 'loading', 'toCharge', 'toPick'].sort(),
    )
  })

  it('任务描述快照：行驶中取货 / 卸货 / 充电任务文案，空闲为 null', () => {
    const state = createSimulator(makeTaskFlowMap(), { seed: 42, agvCount: 1 })
    const seenTasks = new Set<string>()
    for (let i = 0; i < 600; i++) {
      stepSimulator(state, DT)
      const snapshot = snapshotSimulator(state)[0]
      if (snapshot.status === 'idle') {
        expect(snapshot.task).toBeNull()
      } else if (snapshot.task !== null) {
        seenTasks.add(snapshot.task.split(' ')[0])
      }
    }
    expect(seenTasks.has('取货')).toBe(true)
    expect(seenTasks.has('卸货')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 低电量与充电互斥（SPEC §7.1 / §10）
// ---------------------------------------------------------------------------

/** 两座 park 一座 charge 一座 work 的连通图 */
function makeChargeMap(): NormalizedMap {
  return makeMap(
    [
      makeNode('p1', 'park', 0, 0),
      makeNode('p2', 'park', 0, 5),
      makeNode('c1', 'charge', 10, 0),
      makeNode('w1', 'work', 10, 10),
    ],
    [
      ...makeEdgePair('e_p1_c1', 'e_c1_p1', 'p1', 'c1', [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
      ...makeEdgePair('e_p2_c1', 'e_c1_p2', 'p2', 'c1', [
        { x: 0, y: 5 },
        { x: 10, y: 0 },
      ]),
      ...makeEdgePair('e_c1_w1', 'e_w1_c1', 'c1', 'w1', [
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ]),
    ],
  )
}

describe('simulator：低电量与充电互斥（SPEC §7.1 / §10）', () => {
  it('电量低于阈值触发 TO_CHARGE（最近空闲充电位），充满回 IDLE 并释放充电位', () => {
    const state = createSimulator(makeChargeMap(), { seed: 3, agvCount: 1 })
    const agv = state.agvs[0]
    agv.battery = 5 // 低于阈值 20

    stepSimulator(state, DT)
    expect(agv.state).toBe('TO_CHARGE')
    expect(agv.chargeNodeId).toBe('c1')
    // 决策即预定：充电位互斥表已占用
    expect(state.chargeOccupancy.get('c1')).toBe(agv.id)

    // 行驶到充电位 → CHARGING → 充满的当步回 IDLE 并释放充电位
    let sawCharging = false
    let fullStep = -1
    for (let i = 0; i < 1200 && fullStep < 0; i++) {
      stepSimulator(state, DT)
      if (agv.state === 'CHARGING') sawCharging = true
      if (agv.battery === 100) {
        fullStep = i
        expect(agv.state).toBe('IDLE')
        expect(agv.chargeNodeId).toBeNull()
        expect(state.chargeOccupancy.size).toBe(0)
      }
    }
    expect(sawCharging).toBe(true)
    expect(fullStep).toBeGreaterThan(0)
    expect(state.alertCount).toBe(0)
  })

  it('充电位占用互斥：两台低电量 AGV 抢一座充电位，无空闲位者留 IDLE 重试且不告警', () => {
    const state = createSimulator(makeChargeMap(), { seed: 3, agvCount: 2 })
    for (const agv of state.agvs) {
      agv.battery = 5
    }

    let sawContention = false
    const reachedFull = new Set<number>()
    const sawCharging = new Set<number>()
    let secondChargedAfterFirst = false
    for (let i = 0; i < 3000; i++) {
      stepSimulator(state, DT)
      // 任意时刻同一充电位至多一台占用
      const claimed = state.agvs.filter((agv) => agv.chargeNodeId !== null)
      expect(new Set(claimed.map((agv) => agv.chargeNodeId)).size).toBe(claimed.length)
      expect(state.chargeOccupancy.size).toBe(claimed.length)
      for (const [nodeId, agvId] of state.chargeOccupancy) {
        expect(state.agvs[agvId].chargeNodeId).toBe(nodeId)
      }
      const charging = state.agvs.filter((agv) => agv.state === 'CHARGING')
      expect(charging.length).toBeLessThanOrEqual(1)
      // 一台充电时另一台留 IDLE（无空闲位重试）
      if (charging.length === 1 && state.agvs.some((agv) => agv.state === 'IDLE' && agv.battery < 20)) {
        sawContention = true
      }
      for (const agv of charging) {
        sawCharging.add(agv.id)
      }
      for (const agv of state.agvs) {
        if (agv.battery === 100) {
          if (reachedFull.size > 0 && !reachedFull.has(agv.id)) {
            secondChargedAfterFirst = true
          }
          reachedFull.add(agv.id)
        }
      }
    }
    expect(sawContention).toBe(true)
    // 两台都经历了充电并充满（第二台在第一台释放后充上）
    expect(sawCharging.size).toBe(2)
    expect(reachedFull.size).toBe(2)
    expect(secondChargedAfterFirst).toBe(true)
    // 无空闲位属正常竞争：全程无告警
    expect(state.alertCount).toBe(0)
    // 充满后充电位均已释放
    expect(state.chargeOccupancy.size).toBe(0)
  })

  it('找不到可达充电位：回 IDLE 并告警计数，不影响全局（SPEC §10）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // p1 与 w1 一个连通域；c1 与 w2 另一个连通域 —— 从 p1 不可达 c1
    const map = makeMap(
      [
        makeNode('p1', 'park', 0, 0),
        makeNode('w1', 'work', 10, 0),
        makeNode('c1', 'charge', 100, 0),
        makeNode('w2', 'work', 100, 10),
      ],
      [
        ...makeEdgePair('e_p1_w1', 'e_w1_p1', 'p1', 'w1', [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ]),
        ...makeEdgePair('e_c1_w2', 'e_w2_c1', 'c1', 'w2', [
          { x: 100, y: 0 },
          { x: 100, y: 10 },
        ]),
      ],
    )
    const state = createSimulator(map, { seed: 3, agvCount: 1 })
    const agv = state.agvs[0]
    agv.battery = 5

    stepSimulator(state, DT)
    expect(agv.state).toBe('IDLE')
    expect(state.alertCount).toBe(1)
    expect(agv.retryRemaining).toBeGreaterThan(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[simulator]'))
    // 冷却后继续重试、持续告警计数，但不抛异常不卡死
    runSteps(state, 50)
    expect(state.alertCount).toBeGreaterThan(1)
    expect(agv.state).toBe('IDLE')
  })

  it('任务目标不可达：回 IDLE 并告警计数', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // p1 孤立（无任何边），唯一 work 在另一连通域
    const map = makeMap(
      [makeNode('p1', 'park', 0, 0), makeNode('w1', 'work', 100, 0), makeNode('c1', 'charge', 100, 10)],
      makeEdgePair('e_c1_w1', 'e_w1_c1', 'c1', 'w1', [
        { x: 100, y: 10 },
        { x: 100, y: 0 },
      ]),
    )
    const state = createSimulator(map, { seed: 3, agvCount: 1 })
    const agv = state.agvs[0]
    expect(agv.nodeId).toBe('p1')

    stepSimulator(state, DT)
    expect(agv.state).toBe('IDLE')
    expect(state.alertCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 运动学（SPEC §7.2）
// ---------------------------------------------------------------------------

describe('simulator：运动学——走廊统一几何弧长推进（SPEC §7.2）', () => {
  // a(0,0) —拐角(10,0)— b(10,10)，双向一致几何（走廊参照为 a→b 方向边）
  const bentPoints = (): MapPoint[] => [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ]
  function makeBentMap(): NormalizedMap {
    return makeMap(
      [makeNode('a', 'park', 0, 0), makeNode('b', 'work', 10, 10), makeNode('w_drop_target', 'work', 20, 20)],
      makeEdgePair('e_ab', 'e_ba', 'a', 'b', bentPoints()),
    )
  }

  it('正向行驶：采样点全部落在走廊统一几何上（与渲染零偏差）', () => {
    const map = makeBentMap()
    const state = createSimulator(map, { seed: 1, agvCount: 1 })
    const corridor = map.corridors[0]
    const agv = forceDrive(state, ['e_ab'], 'a', 0)

    const track: MapPoint[] = []
    for (let i = 0; i < 200 && agv.routeEdgeIds !== null; i++) {
      stepSimulator(state, DT)
      track.push(snapshotMapPoint(state, 0))
    }
    expect(agv.state).toBe('LOADING') // 20m 走廊已走完全程
    expect(track.length).toBeGreaterThan(50)
    for (const point of track) {
      expect(distanceToPolyline(point, corridor.geometry)).toBeLessThan(1e-9)
    }
    // 起点 a(0,0) → 终点 b(10,10)
    expect(track[0].x).toBeCloseTo(0, 3)
    expect(track[0].y).toBeCloseTo(0, 3)
    expect(track[track.length - 1].x).toBeCloseTo(10, 3)
    expect(track[track.length - 1].y).toBeCloseTo(10, 3)
  })

  it('反向行驶：折线反转复用同一走廊几何，轨迹反向且零偏差', () => {
    const map = makeBentMap()
    const state = createSimulator(map, { seed: 1, agvCount: 1 })
    const corridor = map.corridors[0]
    // 走廊参照几何为 a→b；b→a 方向 alongGeometry=false（反向行驶）
    expect(corridor.directions.find((direction) => direction.edgeId === 'e_ba')!.alongGeometry).toBe(false)
    const agv = forceDrive(state, ['e_ba'], 'b', 0)

    const track: MapPoint[] = []
    for (let i = 0; i < 200 && agv.routeEdgeIds !== null; i++) {
      stepSimulator(state, DT)
      track.push(snapshotMapPoint(state, 0))
    }
    expect(agv.state).toBe('LOADING')
    for (const point of track) {
      expect(distanceToPolyline(point, corridor.geometry)).toBeLessThan(1e-9)
    }
    // 起点 b(10,10) → 终点 a(0,0)，与正向互逆
    expect(track[0].x).toBeCloseTo(10, 3)
    expect(track[0].y).toBeCloseTo(10, 3)
    expect(track[track.length - 1].x).toBeCloseTo(0, 3)
    expect(track[track.length - 1].y).toBeCloseTo(0, 3)
  })

  it('限速 / 加速度字段为 null 时用缺省常量兜底（巡航速度 = 缺省限速）', () => {
    const map = makeBentMap()
    const state = createSimulator(map, { seed: 1, agvCount: 1 })
    const agv = forceDrive(state, ['e_ab'], 'a', 0)
    let maxSpeed = 0
    for (let i = 0; i < 200 && agv.routeEdgeIds !== null; i++) {
      stepSimulator(state, DT)
      maxSpeed = Math.max(maxSpeed, agv.speed)
    }
    // 默认缺省限速 2 m/s（DEFAULT_MAX_SPEED）
    expect(maxSpeed).toBeCloseTo(2, 6)
  })
})

describe('simulator：运动学——朝向约束与倒车（SPEC §7.2）', () => {
  it('back 边：车头与运动方向相反（sfacing 语义自然得出，无二次翻转），速度低于正向', () => {
    const map = makeMap(
      [makeNode('a', 'park', 0, 0), makeNode('b', 'work', 20, 0), makeNode('w_drop_target', 'work', 30, 0)],
      // a→b 倒车边：弦方向 +x（运动方向 0），车头朝向 sfacing = π（= 弦方向 + π）
      [
        makeEdge('e_back', 'a', 'b', {
          points: [
            { x: 0, y: 0 },
            { x: 20, y: 0 },
          ],
          sFacing: Math.PI,
          eFacing: Math.PI,
          isBackEdge: true,
          maxSpeedFree: 4,
        }),
      ],
    )
    const state = createSimulator(map, { seed: 1, agvCount: 1, backSpeedFactor: 0.5 })
    const agv = forceDrive(state, ['e_back'], 'a', Math.PI)

    let maxSpeed = 0
    let previousX = 0
    let observedCruiseHeading = false
    for (let i = 0; i < 300 && agv.routeEdgeIds !== null; i++) {
      stepSimulator(state, DT)
      maxSpeed = Math.max(maxSpeed, agv.speed)
      const point = snapshotMapPoint(state, 0)
      if (agv.speed > 1.9) {
        // 巡航段：向 +x 行驶（运动方向 0）而车头朝向 π —— 恰好相反，无叠加翻转
        expect(point.x).toBeGreaterThan(previousX)
        expect(Math.abs(agv.heading - Math.PI)).toBeLessThan(1e-9)
        observedCruiseHeading = true
      }
      previousX = point.x
    }
    expect(observedCruiseHeading).toBe(true)
    // 倒车限速 = 4 × 0.5 = 2 m/s
    expect(maxSpeed).toBeCloseTo(2, 6)
    // 世界 yaw 经 coordinates.ts 统一换算：π + π/2
    const snapshot = snapshotSimulator(state)[0]
    expect(snapshot.yaw).toBeCloseTo(Math.PI + Math.PI / 2, 9)
  })

  it('sFacing ≠ eFacing 的边沿弧长插值旋转，到达时车头 = eFacing', () => {
    const map = makeMap(
      [makeNode('a', 'park', 0, 0), makeNode('b', 'work', 10, 0), makeNode('w_drop_target', 'work', 20, 0)],
      [
        makeEdge('e_turn', 'a', 'b', {
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
          sFacing: 0,
          eFacing: Math.PI / 2,
        }),
      ],
    )
    const state = createSimulator(map, { seed: 1, agvCount: 1 })
    const agv = forceDrive(state, ['e_turn'], 'a', 0)

    const headings: Array<{ distance: number; heading: number }> = []
    for (let i = 0; i < 200 && agv.routeEdgeIds !== null; i++) {
      stepSimulator(state, DT)
      headings.push({ distance: agv.legDistance, heading: agv.heading })
    }
    expect(agv.heading).toBeCloseTo(Math.PI / 2, 9)
    // 单调递增插值；弧长过半时朝向 ≥ π/4（线性插值下界）
    for (let i = 1; i < headings.length; i++) {
      expect(headings[i].heading).toBeGreaterThanOrEqual(headings[i - 1].heading - 1e-12)
    }
    const mid = headings.find((sample) => sample.distance >= 5)!
    expect(mid.heading).toBeGreaterThanOrEqual(Math.PI / 4 - 1e-9)
    expect(mid.heading).toBeLessThan(Math.PI / 4 + 0.2)
  })

  it('节点处相邻边朝向突变：原地旋转（角速度取边字段）后再出发', () => {
    const map = makeMap(
      [
        makeNode('a', 'park', 0, 0),
        makeNode('b', 'node', 10, 0),
        makeNode('c', 'work', 10, 10),
        makeNode('w_drop_target', 'work', 30, 0),
      ],
      [
        makeEdge('e1', 'a', 'b', {
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
          sFacing: 0,
          eFacing: 0,
        }),
        makeEdge('e2', 'b', 'c', {
          points: [
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ],
          sFacing: Math.PI / 2,
          eFacing: Math.PI / 2,
          // 角速度取待进入边字段：π/4 rad/s（区别于缺省 π/2，验证字段生效）
          maxRotationSpeedFree: Math.PI / 4,
        }),
      ],
    )
    const state = createSimulator(map, { seed: 1, agvCount: 1 })
    const agv = forceDrive(state, ['e1', 'e2'], 'a', 0)

    let stationaryAtNodeSteps = 0
    let sawRotation = false
    let previousHeading = 0
    for (let i = 0; i < 400 && agv.routeEdgeIds !== null; i++) {
      stepSimulator(state, DT)
      if (agv.routeIndex === 1 && agv.legDistance === 0) {
        // 到达节点 b 后：位置不动、速度为 0、朝向向 π/2 旋转
        stationaryAtNodeSteps++
        const point = snapshotMapPoint(state, 0)
        expect(point.x).toBeCloseTo(10, 6)
        expect(point.y).toBeCloseTo(0, 6)
        expect(agv.speed).toBe(0)
        if (agv.heading > previousHeading) sawRotation = true
        previousHeading = agv.heading
      }
    }
    expect(agv.state).toBe('LOADING')
    expect(sawRotation).toBe(true)
    // π/2 转角 ÷ π/4 rad/s ÷ 0.1s = 20 步旋转 + 1 步到达 = 21 步（允许 ±1 步边界）
    expect(stationaryAtNodeSteps).toBeGreaterThanOrEqual(20)
    expect(stationaryAtNodeSteps).toBeLessThanOrEqual(22)
  })

  it('节点 angle 非空时停靠期间车头对齐 angle', () => {
    const map = makeMap(
      [
        makeNode('p1', 'park', 0, 0),
        makeNode('w1', 'work', 10, 0, Math.PI / 3),
        makeNode('w2', 'work', 20, 0),
      ],
      [
        ...makeEdgePair('e_p1_w1', 'e_w1_p1', 'p1', 'w1', [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ]),
        ...makeEdgePair('e_w1_w2', 'e_w2_w1', 'w1', 'w2', [
          { x: 10, y: 0 },
          { x: 20, y: 0 },
        ]),
      ],
    )
    const state = createSimulator(map, { seed: 1, agvCount: 1, loadUnloadSeconds: 3 })
    const agv = state.agvs[0]
    // 白盒：直接置于 LOADING（停靠 w1，到达朝向 0，与 angle π/3 不同）
    agv.state = 'LOADING'
    agv.nodeId = 'w1'
    agv.heading = 0
    agv.dwellRemaining = 3
    agv.pickNodeId = 'w1'

    for (let i = 0; i < 60 && agv.state === 'LOADING'; i++) {
      stepSimulator(state, DT)
    }
    // 停靠期间已旋转对齐节点 angle 并保持
    expect(agv.heading).toBeCloseTo(Math.PI / 3, 9)
    expect(agv.state).toBe('TO_DROP')
  })
})

// ---------------------------------------------------------------------------
// 电量模型（SPEC §7.1）
// ---------------------------------------------------------------------------

describe('simulator：电量模型（SPEC §7.1）', () => {
  it('按行驶里程线性消耗（%/m）', () => {
    const map = makeMap(
      [makeNode('a', 'park', 0, 0), makeNode('b', 'work', 10, 0), makeNode('w_drop_target', 'work', 20, 0)],
      makeEdgePair('e_ab', 'e_ba', 'a', 'b', [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    )
    const state = createSimulator(map, { seed: 1, agvCount: 1, batteryDrainPerMeter: 0.5 })
    const agv = forceDrive(state, ['e_ab'], 'a', 0)
    runSteps(state, 200)
    expect(agv.routeEdgeIds).toBeNull()
    // 恰好行驶 10m：100 - 0.5 × 10 = 95
    expect(agv.battery).toBeCloseTo(95, 9)
  })

  it('充电按时间恢复（%/s）并在 100% 封顶，充满回 IDLE 释放充电位', () => {
    const map = makeMap(
      [makeNode('p1', 'park', 0, 0), makeNode('c1', 'charge', 10, 0), makeNode('w1', 'work', 20, 0)],
      makeEdgePair('e_p1_c1', 'e_c1_p1', 'p1', 'c1', [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    )
    const state = createSimulator(map, { seed: 1, agvCount: 1, batteryChargePerSecond: 10 })
    const agv = state.agvs[0]
    // 白盒：直接进入 CHARGING
    agv.state = 'CHARGING'
    agv.nodeId = 'c1'
    agv.battery = 50
    agv.chargeNodeId = 'c1'
    state.chargeOccupancy.set('c1', agv.id)

    runSteps(state, 10) // 1s × 10%/s = +10
    expect(agv.battery).toBeCloseTo(60, 9)
    expect(agv.state).toBe('CHARGING')

    // 充至 100% 封顶的当步即回 IDLE 并释放充电位
    runSteps(state, 40) // 再 4s：60 + 4 × 10 = 100
    expect(agv.battery).toBe(100)
    expect(agv.state).toBe('IDLE')
    expect(state.chargeOccupancy.size).toBe(0)
    expect(agv.chargeNodeId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 种子可复现（SPEC §7.1 / §15.5）
// ---------------------------------------------------------------------------

/** 3×3 网格混合节点图（双向全连接邻边） */
function makeGridMap(): NormalizedMap {
  const kinds: NodeKind[] = ['park', 'work', 'park', 'work', 'node', 'work', 'park', 'work', 'charge']
  const nodes = kinds.map((kind, i) =>
    makeNode(`n${i}`, kind, (i % 3) * 10, Math.floor(i / 3) * 10),
  )
  const edges: NormalizedEdge[] = []
  const link = (a: number, b: number) => {
    edges.push(
      ...makeEdgePair(`e_${a}_${b}`, `e_${b}_${a}`, `n${a}`, `n${b}`, [
        { x: (a % 3) * 10, y: Math.floor(a / 3) * 10 },
        { x: (b % 3) * 10, y: Math.floor(b / 3) * 10 },
      ]),
    )
  }
  for (let i = 0; i < 9; i++) {
    if (i % 3 !== 2) link(i, i + 1)
    if (i < 6) link(i, i + 3)
  }
  return makeMap(nodes, edges)
}

describe('simulator：种子可复现（SPEC §7.1 / §15.5）', () => {
  it('同一种子两次运行状态序列逐帧一致', () => {
    const a = createSimulator(makeGridMap(), { seed: 99, agvCount: 6 })
    const b = createSimulator(makeGridMap(), { seed: 99, agvCount: 6 })
    for (let i = 0; i < 600; i++) {
      stepSimulator(a, DT)
      stepSimulator(b, DT)
      expect(snapshotSimulator(a)).toEqual(snapshotSimulator(b))
    }
    expect(a.alertCount).toBe(b.alertCount)
    expect(a.time).toBeCloseTo(b.time, 12)
  })

  it('不同种子任务选择发散（演示画面有差异且可复现）', () => {
    const a = createSimulator(makeGridMap(), { seed: 1, agvCount: 6 })
    const b = createSimulator(makeGridMap(), { seed: 2, agvCount: 6 })
    let diverged = false
    for (let i = 0; i < 600; i++) {
      stepSimulator(a, DT)
      stepSimulator(b, DT)
      if (JSON.stringify(snapshotSimulator(a)) !== JSON.stringify(snapshotSimulator(b))) {
        diverged = true
        break
      }
    }
    expect(diverged).toBe(true)
  })

  it('step(dt) 不读真实时钟：仅按步长累积模拟时间', () => {
    const state = createSimulator(makeGridMap(), { seed: 5, agvCount: 2 })
    runSteps(state, 100, 0.1)
    expect(state.time).toBeCloseTo(10, 9)
    // 非正步长不推进
    stepSimulator(state, 0)
    expect(state.time).toBeCloseTo(10, 9)
  })
})

// ---------------------------------------------------------------------------
// 真实 map.json 集成（SPEC §4.1 / §7 / §9 规模）
// ---------------------------------------------------------------------------

describe('simulator：真实 map.json 集成', () => {
  const mapJsonPath = fileURLToPath(new URL('../../public/map.json', import.meta.url))
  const { map } = normalizeMapFromJson(readFileSync(mapJsonPath, 'utf8'))

  it('默认 20 台全部互斥占用 park 节点、初始 IDLE 满电', () => {
    const state = createSimulator(map, { seed: 20260821 })
    expect(state.agvs).toHaveLength(20)
    const occupied = state.agvs.map((agv) => agv.nodeId!)
    expect(new Set(occupied).size).toBe(20)
    const parkIds = new Set(map.nodes.filter((node) => node.kind === 'park').map((node) => node.id))
    for (const nodeId of occupied) {
      expect(parkIds.has(nodeId)).toBe(true)
    }
    expect(state.agvs.every((agv) => agv.state === 'IDLE' && agv.battery === 100)).toBe(true)
  })

  it('上限 100 台：64 台 park 占满后 36 台顺延 work，每节点至多一台', () => {
    const state = createSimulator(map, { seed: 20260821, agvCount: 100 })
    expect(state.agvs).toHaveLength(100)
    const occupied = state.agvs.map((agv) => agv.nodeId!)
    expect(new Set(occupied).size).toBe(100)
    const kindById = new Map(map.nodes.map((node) => [node.id, node.kind]))
    const parkCount = occupied.filter((id) => kindById.get(id) === 'park').length
    const workCount = occupied.filter((id) => kindById.get(id) === 'work').length
    expect(parkCount).toBe(64)
    expect(workCount).toBe(36)
  })

  // 3000 步 × 100 台逐步断言计算量大，本机 / CI 负载波动时易擦边超默认 5s，显式放宽
  it('100 台长跑 300s：任务流 / 充电互斥 / 电量边界不变量全程成立', { timeout: 30_000 }, () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 高耗电迫使触发充电流（1%/m → 约 100m 即低电量）
    const state = createSimulator(map, { seed: 20260821, agvCount: 100, batteryDrainPerMeter: 1 })
    const seenStatus = new Set<string>()
    for (let i = 0; i < 3000; i++) {
      stepSimulator(state, DT)
      // 充电位互斥：占用表与 AGV 声明一致且一一对应
      const claimed = state.agvs.filter((agv) => agv.chargeNodeId !== null)
      expect(state.chargeOccupancy.size).toBe(claimed.length)
      expect(new Set(claimed.map((agv) => agv.chargeNodeId)).size).toBe(claimed.length)
      for (const agv of state.agvs) {
        expect(agv.battery).toBeGreaterThanOrEqual(0)
        expect(agv.battery).toBeLessThanOrEqual(100)
        seenStatus.add(toExternalStatus(agv.state))
      }
    }
    // 任务流与充电流都真实发生
    for (const status of ['toPick', 'hauling', 'loading', 'toCharge', 'charging'] as const) {
      expect(seenStatus.has(status)).toBe(true)
    }
    // 快照结构完整（抽样最后一步）
    const snapshots = snapshotSimulator(state)
    expect(snapshots).toHaveLength(100)
    for (const snapshot of snapshots) {
      expect(Number.isFinite(snapshot.position.x)).toBe(true)
      expect(Number.isFinite(snapshot.position.z)).toBe(true)
      expect(Number.isFinite(snapshot.yaw)).toBe(true)
    }
  })

  it('真实地图固定种子两次运行逐帧一致', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = createSimulator(map, { seed: 7, agvCount: 20 })
    const b = createSimulator(map, { seed: 7, agvCount: 20 })
    for (let i = 0; i < 300; i++) {
      stepSimulator(a, DT)
      stepSimulator(b, DT)
      expect(snapshotSimulator(a)).toEqual(snapshotSimulator(b))
    }
  })
})
