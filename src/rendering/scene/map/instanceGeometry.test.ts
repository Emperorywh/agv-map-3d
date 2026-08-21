import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { Color } from 'three'

import {
  AGV_BODY_LENGTH,
  AGV_BODY_WIDTH,
  AGV_CHASSIS_HEIGHT,
  AGV_COVER_HEIGHT,
  AGV_COVER_LENGTH,
  AGV_COVER_REAR_OFFSET,
  AGV_COVER_WIDTH,
  AGV_HEADLIGHT_DEPTH,
  AGV_HEADLIGHT_HEIGHT,
  AGV_HEADLIGHT_INSET,
  AGV_HEADLIGHT_LIFT,
  AGV_HEADLIGHT_WIDTH,
  AGV_STATUS_RING_LIFT,
  AGV_STATUS_RING_RADIUS,
  AGV_STATUS_RING_TUBE,
  AGV_WEDGE_HEIGHT,
  AGV_WEDGE_LENGTH,
  AGV_WEDGE_WIDTH,
  NODE_CHARGE_RADIUS,
  NODE_NAV_RADIUS,
  NODE_PARK_RADIUS,
  NODE_WORK_PLATFORM_SIZE,
} from '../../../config/constants'
import { agvBodyColors, agvStatusColors } from '../../../config/theme'
import { headingToWorldYaw, mapToWorld } from '../../../domain/coordinates'
import { normalizeMapFromJson } from '../../../domain/normalize'
import { createSimulator, snapshotSimulator, stepSimulator } from '../../../domain/simulator'
import type { AgvSnapshot, AgvStatus } from '../../../domain/simulator'
import type { Calibration, NodeKind, NormalizedNode } from '../../../domain/types'
import {
  RENDERABLE_NODE_KINDS,
  buildAgvBodyGeometry,
  buildAgvStatusRingGeometry,
  buildAgvWedgeGeometry,
  buildChargePlatformGeometry,
  buildNodeDotGeometry,
  buildNodeInstances,
  buildNodeKindGeometries,
  buildWorkIconGeometry,
  buildWorkPlatformGeometry,
  createNodeInstanceBuilder,
  getNodeIdAtInstance,
  resolveAgvStatusColors,
  shouldHideNavNodes,
  writeAgvInstanceMatrices,
  writeAgvStatusColors,
} from './instanceGeometry'
import type {
  AgvShapeColors,
  AgvShapeSizes,
  NodeInstanceGroup,
  NodeShapeSizes,
} from './instanceGeometry'

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/** 恒等校准：地图 (x, y) → 世界 (x, 0, -y) */
const IDENTITY_CALIBRATION: Calibration = { scale: 1, rotationRad: 0, offsetX: 0, offsetY: 0 }

const TEST_SIZES: NodeShapeSizes = {
  workPlatformSize: 1.4,
  workPlatformHeight: 0.26,
  workIconSize: 0.8,
  workIconHeight: 0.22,
  chargeRadius: 0.62,
  chargeHeight: 0.2,
  parkRadius: 0.3,
  parkHeight: 0.12,
  navRadius: 0.15,
  navHeight: 0.07,
}

let nextId = 0
function makeNode(kind: NodeKind, x: number, y: number, angle: number | null = null): NormalizedNode {
  nextId += 1
  return { id: `n${nextId}`, name: `节点${nextId}`, kind, x, y, angle }
}

function groupOf(result: { groups: NodeInstanceGroup[] }, kind: NodeKind): NodeInstanceGroup {
  const group = result.groups.find((item) => item.kind === kind)
  if (group === undefined) {
    throw new Error(`缺少分组 ${kind}`)
  }
  return group
}

/** 实例矩阵（列主序）中的平移分量 */
function instancePosition(group: NodeInstanceGroup, instanceId: number): [number, number, number] {
  const base = instanceId * 16
  return [group.matrices[base + 12], group.matrices[base + 13], group.matrices[base + 14]]
}

// ---------------------------------------------------------------------------
// 按类型分组与 instanceId → 节点 id 映射表（SPEC §6.3 / §8.2）
// ---------------------------------------------------------------------------

describe('instanceGeometry：类型分组与实例计数（SPEC §6.3）', () => {
  it('按 work → charge → park → node 固定顺序分组，各类型实例数与输入一致', () => {
    const nodes = [
      makeNode('node', 0, 0),
      makeNode('work', 1, 1),
      makeNode('node', 2, 2),
      makeNode('charge', 3, 3),
      makeNode('park', 4, 4),
      makeNode('work', 5, 5),
    ]
    const result = buildNodeInstances(nodes, IDENTITY_CALIBRATION)
    expect(result.groups.map((group) => group.kind)).toEqual([...RENDERABLE_NODE_KINDS])
    expect(groupOf(result, 'work').nodeIds).toHaveLength(2)
    expect(groupOf(result, 'charge').nodeIds).toHaveLength(1)
    expect(groupOf(result, 'park').nodeIds).toHaveLength(1)
    expect(groupOf(result, 'node').nodeIds).toHaveLength(2)
  })

  it('elevator 类型本期不渲染：跳过且不计入任何分组', () => {
    const nodes = [makeNode('elevator', 0, 0), makeNode('node', 1, 1)]
    const result = buildNodeInstances(nodes, IDENTITY_CALIBRATION)
    for (const group of result.groups) {
      expect(group.nodeIds).not.toContain(nodes[0].id)
    }
    expect(groupOf(result, 'node').nodeIds).toEqual([nodes[1].id])
    const total = result.groups.reduce((sum, group) => sum + group.nodeIds.length, 0)
    expect(total).toBe(1)
  })

  it('空输入 / 全 elevator：分组齐全且全部为空', () => {
    for (const nodes of [[], [makeNode('elevator', 0, 0)]]) {
      const result = buildNodeInstances(nodes, IDENTITY_CALIBRATION)
      expect(result.groups).toHaveLength(4)
      for (const group of result.groups) {
        expect(group.nodeIds).toEqual([])
        expect(group.matrices).toHaveLength(0)
      }
    }
  })

  it('draw call 预算：work 两段 + charge/park/node 各一段，合计 5（SPEC 4~5 个）', () => {
    const segmentCounts = RENDERABLE_NODE_KINDS.map(
      (kind) => buildNodeKindGeometries(kind, TEST_SIZES).length,
    )
    expect(segmentCounts).toEqual([2, 1, 1, 1])
    const drawCalls = segmentCounts.reduce((sum, count) => sum + count, 0)
    expect(drawCalls).toBeGreaterThanOrEqual(4)
    expect(drawCalls).toBeLessThanOrEqual(5)
  })
})

describe('instanceGeometry：instanceId → 节点 id 映射表（SPEC §8.2）', () => {
  it('nodeIds 与矩阵一一对应，getNodeIdAtInstance 按 instanceId 反查', () => {
    const nodes = [
      makeNode('work', 0, 0),
      makeNode('work', 1, 1),
      makeNode('node', 2, 2),
      makeNode('work', 3, 3),
    ]
    const result = buildNodeInstances(nodes, IDENTITY_CALIBRATION)
    const work = groupOf(result, 'work')
    // 实例顺序保持输入顺序（按类型过滤后）
    expect(work.nodeIds).toEqual([nodes[0].id, nodes[1].id, nodes[3].id])
    expect(work.matrices).toHaveLength(work.nodeIds.length * 16)
    expect(getNodeIdAtInstance(work, 0)).toBe(nodes[0].id)
    expect(getNodeIdAtInstance(work, 1)).toBe(nodes[1].id)
    expect(getNodeIdAtInstance(work, 2)).toBe(nodes[3].id)
  })

  it('非法 instanceId 返回 null', () => {
    const result = buildNodeInstances([makeNode('node', 0, 0)], IDENTITY_CALIBRATION)
    const group = groupOf(result, 'node')
    expect(getNodeIdAtInstance(group, -1)).toBeNull()
    expect(getNodeIdAtInstance(group, 1)).toBeNull()
    expect(getNodeIdAtInstance(group, 0.5)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 世界坐标与朝向（经 domain/coordinates.ts 统一转换，SPEC §4.3）
// ---------------------------------------------------------------------------

describe('instanceGeometry：世界坐标与朝向（SPEC §4.3）', () => {
  it('实例平移 = mapToWorld 输出（含 offset 校准；无手写 z 取反）', () => {
    const calibration: Calibration = { scale: 1, rotationRad: 0, offsetX: 5, offsetY: -3 }
    const node = makeNode('park', 12.5, -7.25)
    const result = buildNodeInstances([node], calibration)
    const group = groupOf(result, 'park')
    const world = mapToWorld({ x: node.x, y: node.y }, calibration)
    const [x, y, z] = instancePosition(group, 0)
    // 实例矩阵以 Float32Array 存储，精度按 float32 舍入放宽
    expect(x).toBeCloseTo(world.x, 5)
    expect(y).toBe(0)
    expect(z).toBeCloseTo(world.z, 5)
    // 恒等校准下退化为 (x, 0, -y)：显式验证 z 取反只来自 coordinates.ts 的约定
    const identity = buildNodeInstances([node], IDENTITY_CALIBRATION)
    const [ix, , iz] = instancePosition(groupOf(identity, 'park'), 0)
    expect(ix).toBeCloseTo(node.x, 5)
    expect(iz).toBeCloseTo(-node.y, 5)
  })

  it('节点 angle 经 headingToWorldYaw 写入实例旋转；angle 为空时无旋转', () => {
    const nodes = [makeNode('work', 0, 0, 0), makeNode('work', 0, 0, Math.PI / 2), makeNode('work', 0, 0)]
    const result = buildNodeInstances(nodes, IDENTITY_CALIBRATION)
    const group = groupOf(result, 'work')
    // 列主序 elements[8] / elements[10] = 旋转矩阵第三列（+Z 基）的 x / z = (sinβ, cosβ)
    // （Float32Array 存储，精度按 float32 放宽）
    for (const [instanceId, node] of nodes.entries()) {
      const yaw = node.angle === null ? 0 : headingToWorldYaw(node.angle, IDENTITY_CALIBRATION)
      const base = instanceId * 16
      expect(group.matrices[base + 8]).toBeCloseTo(Math.sin(yaw), 6)
      expect(group.matrices[base + 10]).toBeCloseTo(Math.cos(yaw), 6)
    }
    // angle = 0 → yaw = π/2；angle = π/2 → yaw = π；angle = null → 单位旋转
    expect(group.matrices[8]).toBeCloseTo(1, 6)
    expect(group.matrices[16 + 10]).toBeCloseTo(-1, 6)
    expect(group.matrices[32 + 10]).toBeCloseTo(1, 6)
  })
})

// ---------------------------------------------------------------------------
// node 类整类隐藏判定（SPEC §6.3）
// ---------------------------------------------------------------------------

describe('instanceGeometry：node 类整类隐藏判定（SPEC §6.3）', () => {
  it('相机距离超过阈值整类隐藏，等于 / 小于阈值保持可见', () => {
    expect(shouldHideNavNodes(151, 150)).toBe(true)
    expect(shouldHideNavNodes(150, 150)).toBe(false)
    expect(shouldHideNavNodes(80, 150)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 分帧构建
// ---------------------------------------------------------------------------

describe('instanceGeometry：分帧构建（SPEC §4.4）', () => {
  it('分帧构建与一次性构建结果一致，done / processed 语义正确', () => {
    const nodes = [
      makeNode('work', 0, 0, 1),
      makeNode('node', 1, 1),
      makeNode('charge', 2, 2),
      makeNode('elevator', 3, 3),
      makeNode('park', 4, 4),
      makeNode('node', 5, 5, -1),
    ]
    const oneShot = buildNodeInstances(nodes, IDENTITY_CALIBRATION)

    const builder = createNodeInstanceBuilder(nodes, IDENTITY_CALIBRATION)
    expect(builder.total).toBe(nodes.length)
    expect(builder.done).toBe(false)
    builder.buildNext(2)
    expect(builder.processed).toBe(2)
    expect(builder.done).toBe(false)
    builder.buildNext(100)
    expect(builder.processed).toBe(nodes.length)
    expect(builder.done).toBe(true)
    const chunked = builder.finalize()

    expect(chunked.groups.map((group) => group.kind)).toEqual(
      oneShot.groups.map((group) => group.kind),
    )
    for (let i = 0; i < oneShot.groups.length; i++) {
      expect(chunked.groups[i].nodeIds).toEqual(oneShot.groups[i].nodeIds)
      expect(Array.from(chunked.groups[i].matrices)).toEqual(
        Array.from(oneShot.groups[i].matrices),
      )
    }
    // finalize 幂等；done 后 buildNext 不再改变结果
    builder.buildNext(1)
    expect(builder.finalize()).toBe(chunked)
  })
})

// ---------------------------------------------------------------------------
// 类型造型（本地几何）
// ---------------------------------------------------------------------------

describe('instanceGeometry：类型造型与尺寸层级（SPEC §6.3）', () => {
  it('work 方形台：底面贴 y=0，尺寸 = size × height', () => {
    const geometry = buildWorkPlatformGeometry(TEST_SIZES.workPlatformSize, TEST_SIZES.workPlatformHeight)
    geometry.computeBoundingBox()
    const box = geometry.boundingBox
    // three 几何顶点为 float32 存储，包围盒断言按 float32 精度放宽
    expect(box?.min.y).toBeCloseTo(0, 6)
    expect(box?.max.y).toBeCloseTo(TEST_SIZES.workPlatformHeight, 6)
    expect(box ? box.max.x - box.min.x : 0).toBeCloseTo(TEST_SIZES.workPlatformSize, 6)
    expect(box ? box.max.z - box.min.z : 0).toBeCloseTo(TEST_SIZES.workPlatformSize, 6)
  })

  it('work 图标色块：45° 旋转（俯视菱形），整体位于方台顶面之上', () => {
    const geometry = buildWorkIconGeometry(
      TEST_SIZES.workIconSize,
      TEST_SIZES.workIconHeight,
      TEST_SIZES.workPlatformHeight,
    )
    geometry.computeBoundingBox()
    const box = geometry.boundingBox
    expect(box?.min.y).toBeCloseTo(TEST_SIZES.workPlatformHeight, 6)
    expect(box?.max.y).toBeCloseTo(TEST_SIZES.workPlatformHeight + TEST_SIZES.workIconHeight, 6)
    // 45° 旋转后包围盒边长 = size × √2（菱形对角线）
    expect(box ? box.max.x - box.min.x : 0).toBeCloseTo(TEST_SIZES.workIconSize * Math.SQRT2, 5)
  })

  it('charge 六边形台：6 段圆柱，深度 = 2r（对顶点）、宽度 = r√3（对边）', () => {
    const geometry = buildChargePlatformGeometry(TEST_SIZES.chargeRadius, TEST_SIZES.chargeHeight)
    geometry.computeBoundingBox()
    const box = geometry.boundingBox
    expect(box?.min.y).toBeCloseTo(0, 6)
    expect(box ? box.max.z - box.min.z : 0).toBeCloseTo(2 * TEST_SIZES.chargeRadius, 5)
    expect(box ? box.max.x - box.min.x : 0).toBeCloseTo(TEST_SIZES.chargeRadius * Math.sqrt(3), 5)
  })

  it('park / node 圆点：低矮圆柱，尺寸 = 2r × height', () => {
    const geometry = buildNodeDotGeometry(TEST_SIZES.parkRadius, TEST_SIZES.parkHeight)
    geometry.computeBoundingBox()
    const box = geometry.boundingBox
    expect(box?.min.y).toBeCloseTo(0, 6)
    expect(box?.max.y).toBeCloseTo(TEST_SIZES.parkHeight, 6)
    expect(box ? box.max.x - box.min.x : 0).toBeCloseTo(2 * TEST_SIZES.parkRadius, 5)
    expect(box ? box.max.z - box.min.z : 0).toBeCloseTo(2 * TEST_SIZES.parkRadius, 5)
  })

  it('尺寸层级（真实 config 常量）：node < park < charge < work', () => {
    expect(NODE_NAV_RADIUS * 2).toBeLessThan(NODE_PARK_RADIUS * 2)
    expect(NODE_PARK_RADIUS * 2).toBeLessThan(NODE_CHARGE_RADIUS * 2)
    expect(NODE_CHARGE_RADIUS * 2).toBeLessThan(NODE_WORK_PLATFORM_SIZE)
  })
})

// ---------------------------------------------------------------------------
// 真实 map.json 集成（SPEC §4.1 / §6.3）
// ---------------------------------------------------------------------------

describe('instanceGeometry：真实 map.json 集成（SPEC §4.1 / §6.3）', () => {
  it('全部 1767 个节点按类型计数（1303/389/64/11），映射表与世界坐标一致', () => {
    const mapJsonPath = fileURLToPath(new URL('../../../../public/map.json', import.meta.url))
    const { map } = normalizeMapFromJson(readFileSync(mapJsonPath, 'utf8'))
    expect(map.nodes).toHaveLength(1767)

    const result = buildNodeInstances(map.nodes, map.calibration)
    expect(groupOf(result, 'node').nodeIds).toHaveLength(1303)
    expect(groupOf(result, 'work').nodeIds).toHaveLength(389)
    expect(groupOf(result, 'park').nodeIds).toHaveLength(64)
    expect(groupOf(result, 'charge').nodeIds).toHaveLength(11)

    // 映射表一致性：nodeIds 全局唯一、矩阵等长且全部有限、坐标与 mapToWorld 一致
    const nodeById = new Map(map.nodes.map((node) => [node.id, node]))
    const seenIds = new Set<string>()
    for (const group of result.groups) {
      expect(group.matrices).toHaveLength(group.nodeIds.length * 16)
      for (const component of group.matrices) {
        expect(Number.isFinite(component)).toBe(true)
      }
      for (const [instanceId, nodeId] of group.nodeIds.entries()) {
        expect(seenIds.has(nodeId)).toBe(false)
        seenIds.add(nodeId)
        expect(getNodeIdAtInstance(group, instanceId)).toBe(nodeId)
        const node = nodeById.get(nodeId)
        expect(node).toBeDefined()
        const world = mapToWorld({ x: node?.x ?? 0, y: node?.y ?? 0 }, map.calibration)
        const [x, y, z] = instancePosition(group, instanceId)
        // 世界坐标量级达 ~90m，Float32Array 存储误差 ~1e-5，按精度 4 断言
        expect(x).toBeCloseTo(world.x, 4)
        expect(y).toBe(0)
        expect(z).toBeCloseTo(world.z, 4)
      }
    }
    expect(seenIds.size).toBe(1767)
  })
})

// ---------------------------------------------------------------------------
// AGV 风格化小车几何（SPEC §7.3）
// ---------------------------------------------------------------------------

/** AGV 造型尺寸夹具：直接取真实 config 常量（与应用一致） */
const TEST_AGV_SIZES: AgvShapeSizes = {
  bodyLength: AGV_BODY_LENGTH,
  bodyWidth: AGV_BODY_WIDTH,
  chassisHeight: AGV_CHASSIS_HEIGHT,
  coverLength: AGV_COVER_LENGTH,
  coverWidth: AGV_COVER_WIDTH,
  coverHeight: AGV_COVER_HEIGHT,
  coverRearOffset: AGV_COVER_REAR_OFFSET,
  wedgeLength: AGV_WEDGE_LENGTH,
  wedgeWidth: AGV_WEDGE_WIDTH,
  wedgeHeight: AGV_WEDGE_HEIGHT,
  headlightWidth: AGV_HEADLIGHT_WIDTH,
  headlightHeight: AGV_HEADLIGHT_HEIGHT,
  headlightDepth: AGV_HEADLIGHT_DEPTH,
  headlightInset: AGV_HEADLIGHT_INSET,
  headlightLift: AGV_HEADLIGHT_LIFT,
  ringRadius: AGV_STATUS_RING_RADIUS,
  ringTube: AGV_STATUS_RING_TUBE,
  ringLift: AGV_STATUS_RING_LIFT,
}

const TEST_AGV_COLORS: AgvShapeColors = {
  chassis: agvBodyColors.chassis,
  cover: agvBodyColors.cover,
  wedge: agvBodyColors.wedge,
  headlight: agvBodyColors.headlight,
}

function makeAgvSnapshot(id: number, overrides: Partial<AgvSnapshot> = {}): AgvSnapshot {
  return {
    id,
    status: 'idle',
    battery: 100,
    edgeId: null,
    nodeId: null,
    task: null,
    position: { x: 0, y: 0, z: 0 },
    yaw: 0,
    ...overrides,
  }
}

describe('instanceGeometry：AGV 车体几何（SPEC §7.3 底盘 + 顶盖 + 方向楔形/前灯）', () => {
  it('合并为单个非索引 BufferGeometry：position/normal/uv/color 同长，可单 InstancedMesh 渲染', () => {
    const geometry = buildAgvBodyGeometry(TEST_AGV_SIZES, TEST_AGV_COLORS)
    expect(geometry.index).toBeNull()
    const count = geometry.getAttribute('position').count
    expect(count).toBeGreaterThan(0)
    expect(geometry.getAttribute('normal').count).toBe(count)
    expect(geometry.getAttribute('uv').count).toBe(count)
    expect(geometry.getAttribute('color').count).toBe(count)
    geometry.dispose()
  })

  it('包围盒符合 1.6×1.0m 叉车示意比例：底面贴 y=0，车头朝本地 +Z（前灯略凸出车头端面）', () => {
    const geometry = buildAgvBodyGeometry(TEST_AGV_SIZES, TEST_AGV_COLORS)
    geometry.computeBoundingBox()
    const box = geometry.boundingBox
    expect(box?.min.y).toBeCloseTo(0, 6)
    expect(box ? box.max.x - box.min.x : 0).toBeCloseTo(AGV_BODY_WIDTH, 5)
    expect(box?.min.z).toBeCloseTo(-AGV_BODY_LENGTH / 2, 5)
    // 前灯凸出车头端面（+Z），凸出量 < 前灯深度
    expect(box?.max.z).toBeGreaterThan(AGV_BODY_LENGTH / 2)
    expect(box?.max.z).toBeLessThan(AGV_BODY_LENGTH / 2 + AGV_HEADLIGHT_DEPTH)
    // 最高点 = 顶盖顶面
    expect(box?.max.y).toBeCloseTo(AGV_CHASSIS_HEIGHT + AGV_COVER_HEIGHT, 5)
    geometry.dispose()
  })

  it('顶点色分段：底盘 / 顶盖 / 楔形 / 前灯四色均出现在 color 属性中', () => {
    const geometry = buildAgvBodyGeometry(TEST_AGV_SIZES, TEST_AGV_COLORS)
    const color = geometry.getAttribute('color')
    const seen = new Set<string>()
    for (let i = 0; i < color.count; i++) {
      seen.add(
        `${color.getX(i).toFixed(4)},${color.getY(i).toFixed(4)},${color.getZ(i).toFixed(4)}`,
      )
    }
    for (const hex of Object.values(agvBodyColors)) {
      const expected = new Color(hex)
      const key = `${expected.r.toFixed(4)},${expected.g.toFixed(4)},${expected.b.toFixed(4)}`
      expect(seen.has(key)).toBe(true)
    }
    geometry.dispose()
  })

  it('方向楔形：薄边（y=0）在 +Z 车头端，全高在 -Z 车尾端', () => {
    const wedge = buildAgvWedgeGeometry(AGV_WEDGE_LENGTH, AGV_WEDGE_WIDTH, AGV_WEDGE_HEIGHT)
    const position = wedge.getAttribute('position')
    const halfLength = AGV_WEDGE_LENGTH / 2
    let maxY = 0
    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i)
      const z = position.getZ(i)
      maxY = Math.max(maxY, y)
      // 车头端（+Z）顶点全部贴底（薄边）；高于底面的顶点只能出现在车尾端（-Z）
      if (z > halfLength - 1e-6) {
        expect(y).toBe(0)
      }
      if (y > 1e-6) {
        expect(z).toBeCloseTo(-halfLength, 6)
      }
    }
    expect(maxY).toBeCloseTo(AGV_WEDGE_HEIGHT, 6)
    wedge.dispose()
  })

  it('顶部状态色环：环心位于顶盖顶面之上、随顶盖偏车尾（本地 -Z）', () => {
    const ring = buildAgvStatusRingGeometry(TEST_AGV_SIZES)
    ring.computeBoundingBox()
    const box = ring.boundingBox
    const ringTop =
      AGV_CHASSIS_HEIGHT + AGV_COVER_HEIGHT + AGV_STATUS_RING_LIFT + 2 * AGV_STATUS_RING_TUBE
    expect(box?.max.y).toBeCloseTo(ringTop, 5)
    expect(box ? (box.min.x + box.max.x) / 2 : 1).toBeCloseTo(0, 5)
    expect(box ? (box.min.z + box.max.z) / 2 : 0).toBeCloseTo(-AGV_COVER_REAR_OFFSET, 5)
    expect(box ? box.max.x - box.min.x : 0).toBeCloseTo(
      2 * (AGV_STATUS_RING_RADIUS + AGV_STATUS_RING_TUBE),
      4,
    )
    ring.dispose()
  })
})

// ---------------------------------------------------------------------------
// AGV 每帧实例写入（纯函数：in-place 写既有数组，SPEC §7.3 / §9）
// ---------------------------------------------------------------------------

describe('instanceGeometry：AGV 每帧实例写入（SPEC §7.3 / §9 只写矩阵与颜色）', () => {
  it('writeAgvInstanceMatrices：yaw=0 为单位旋转 + 快照世界坐标平移，列主序 16 float/实例', () => {
    const snapshots = [
      makeAgvSnapshot(0, { position: { x: 3, y: 0, z: -2 }, yaw: 0 }),
      makeAgvSnapshot(1, { position: { x: -5, y: 0, z: 7 }, yaw: 0 }),
    ]
    const target = new Float32Array(32)
    writeAgvInstanceMatrices(target, snapshots)
    // Float32 存储 + -0/+0 差异，按精度断言
    const expected = [
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, -2, 1],
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -5, 0, 7, 1],
    ]
    for (let instance = 0; instance < 2; instance++) {
      for (let i = 0; i < 16; i++) {
        expect(target[instance * 16 + i]).toBeCloseTo(expected[instance][i], 6)
      }
    }
  })

  it('writeAgvInstanceMatrices：yaw 为绕 Y 旋转，与 headingToWorldYaw 同口径——地图朝向 0（+x）车头朝世界 +x，无二次翻转', () => {
    // headingToWorldYaw(0) = π/2：本地 +Z 车头经 R_y(π/2) 应映射为世界 +x（即地图 +x）
    const yaw = headingToWorldYaw(0, IDENTITY_CALIBRATION)
    const target = new Float32Array(16)
    writeAgvInstanceMatrices(target, [makeAgvSnapshot(0, { yaw })])
    // 车头方向 = 矩阵第三列（e[8], e[9], e[10]）= (sin(yaw), 0, cos(yaw)) = (1, 0, 0)
    expect(target[8]).toBeCloseTo(1, 5)
    expect(target[9]).toBe(0)
    expect(target[10]).toBeCloseTo(0, 5)
    // 地图朝向 π/2（地图 +y，即世界 -z）：车头应朝 (0, 0, -1)
    const yawNorth = headingToWorldYaw(Math.PI / 2, IDENTITY_CALIBRATION)
    writeAgvInstanceMatrices(target, [makeAgvSnapshot(0, { yaw: yawNorth })])
    expect(target[8]).toBeCloseTo(0, 5)
    expect(target[10]).toBeCloseTo(-1, 5)
  })

  it('resolveAgvStatusColors / writeAgvStatusColors：六状态 hex 预解析为 RGB，按快照状态逐实例写入', () => {
    const table = resolveAgvStatusColors({
      idle: '#ff0000',
      toPick: '#00ff00',
      hauling: '#0000ff',
      toCharge: '#ffffff',
      charging: '#000000',
      loading: '#ff00ff',
    })
    const snapshots = [
      makeAgvSnapshot(0, { status: 'idle' }),
      makeAgvSnapshot(1, { status: 'hauling' }),
      makeAgvSnapshot(2, { status: 'charging' }),
    ]
    const target = new Float32Array(9)
    writeAgvStatusColors(target, snapshots, table)
    expect(Array.from(target.slice(0, 3))).toEqual([1, 0, 0])
    expect(Array.from(target.slice(3, 6))).toEqual([0, 0, 1])
    expect(Array.from(target.slice(6, 9))).toEqual([0, 0, 0])
  })

  it('resolveAgvStatusColors：theme.agvStatusColors 六状态全覆盖（与对外状态集合一一对应）', () => {
    const table = resolveAgvStatusColors(agvStatusColors)
    const statuses: AgvStatus[] = ['idle', 'toPick', 'hauling', 'toCharge', 'charging', 'loading']
    for (const status of statuses) {
      const rgb = table[status]
      expect(rgb).toHaveLength(3)
      for (const component of rgb) {
        expect(Number.isFinite(component)).toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// AGV 真实 map.json 模拟集成（SPEC §7：模拟器快照 → 实例写入全链路）
// ---------------------------------------------------------------------------

describe('instanceGeometry：AGV 真实 map.json 模拟集成（SPEC §7）', () => {
  it('20 台 AGV 固定步长推进 60s：快照写入实例矩阵 / 状态色全部有限，且有 AGV 离开初始位置', () => {
    const mapJsonPath = fileURLToPath(new URL('../../../../public/map.json', import.meta.url))
    const { map } = normalizeMapFromJson(readFileSync(mapJsonPath, 'utf8'))
    const simulator = createSimulator(map, { agvCount: 20 })
    expect(simulator.agvs).toHaveLength(20)

    const initial = snapshotSimulator(simulator)
    const matrices = new Float32Array(initial.length * 16)
    const colors = new Float32Array(initial.length * 3)
    const table = resolveAgvStatusColors(agvStatusColors)
    writeAgvInstanceMatrices(matrices, initial)
    writeAgvStatusColors(colors, initial, table)

    // 渲染循环同口径：1/60s 固定步长推进 60 秒
    for (let i = 0; i < 3600; i++) {
      stepSimulator(simulator, 1 / 60)
    }
    const after = snapshotSimulator(simulator)
    writeAgvInstanceMatrices(matrices, after)
    writeAgvStatusColors(colors, after, table)
    for (const component of matrices) {
      expect(Number.isFinite(component)).toBe(true)
    }
    for (const component of colors) {
      expect(Number.isFinite(component)).toBe(true)
    }

    // 60s 内必有 AGV 开始巡航（位置离开初始停靠点）
    const moved = after.some((snapshot, index) => {
      const before = initial[index]
      const dx = snapshot.position.x - before.position.x
      const dz = snapshot.position.z - before.position.z
      return Math.hypot(dx, dz) > 0.5
    })
    expect(moved).toBe(true)
  })
})
