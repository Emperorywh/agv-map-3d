import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  NODE_CHARGE_RADIUS,
  NODE_NAV_RADIUS,
  NODE_PARK_RADIUS,
  NODE_WORK_PLATFORM_SIZE,
} from '../../../config/constants'
import { headingToWorldYaw, mapToWorld } from '../../../domain/coordinates'
import { normalizeMapFromJson } from '../../../domain/normalize'
import type { Calibration, NodeKind, NormalizedNode } from '../../../domain/types'
import {
  RENDERABLE_NODE_KINDS,
  buildChargePlatformGeometry,
  buildNodeDotGeometry,
  buildNodeInstances,
  buildNodeKindGeometries,
  buildWorkIconGeometry,
  buildWorkPlatformGeometry,
  createNodeInstanceBuilder,
  getNodeIdAtInstance,
  shouldHideNavNodes,
} from './instanceGeometry'
import type { NodeInstanceGroup, NodeShapeSizes } from './instanceGeometry'

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
