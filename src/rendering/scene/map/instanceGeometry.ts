/**
 * 节点 InstancedMesh 实例几何与布局（SPEC §6.3）。
 *
 * - 全部节点按类型分组渲染：work 方形台 + 图标色块（最大、最醒目）、charge 六边形台（大）、
 *   park 中小圆点、node 小圆点（最小）；每段几何一个 InstancedMesh（work 方台与图标共享
 *   同一组实例矩阵），全图共 5 个 draw call（SPEC 预算 4~5 个）；elevator 仅预留、
 *   本期不渲染（SPEC §4.2）；
 * - 实例世界坐标经 domain/coordinates.ts 统一转换（z 取反唯一收口，SPEC §4.3），
 *   节点 angle 经 headingToWorldYaw 换算为实例朝向，本模块不做任何手写 z 取反；
 * - 每组携带 instanceId → 节点 id 映射表，供拾取按 instanceId 反查
 *   （SPEC §8.2，拾取交互由 TASK-013 实现）；
 * - node 类在相机距离超阈值时整类隐藏：场景层用整体 visible 开关（不逐实例遍历），
 *   判定收敛于 shouldHideNavNodes，阈值常量在 config/constants.ts；
 * - 实例矩阵构建支持分帧推进（SPEC §4.4 避免主线程长任务），与一次性构建结果一致。
 *
 * rendering 层可 import three 与 config，禁止 import infrastructure（SPEC §12）。
 * 地图实例局部几何（节点造型；后续 AGV 造型）唯一存放处。
 */

import {
  BoxGeometry,
  CylinderGeometry,
  Euler,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three'
import type { BufferGeometry } from 'three'

import { headingToWorldYaw, mapToWorld } from '../../../domain/coordinates'
import type { Calibration, NodeKind, NormalizedNode } from '../../../domain/types'

/** 本期渲染的节点类型（elevator 仅预留，SPEC §6.3） */
export type RenderableNodeKind = Exclude<NodeKind, 'elevator'>

/** 分组固定顺序（确定性输出）：work → charge → park → node */
export const RENDERABLE_NODE_KINDS: readonly RenderableNodeKind[] = [
  'work',
  'charge',
  'park',
  'node',
]

// ---------------------------------------------------------------------------
// 类型造型（本地几何，底面贴 y=0，实例矩阵仅做平移 + 绕 Y 旋转）
// ---------------------------------------------------------------------------

/** 各类型造型尺寸（值取自 config/constants.ts，由场景层注入） */
export interface NodeShapeSizes {
  /** work 方形台边长 / 高 */
  workPlatformSize: number
  workPlatformHeight: number
  /** work 图标色块边长 / 高（置于方台顶面之上） */
  workIconSize: number
  workIconHeight: number
  /** charge 六边形台外接圆半径 / 高 */
  chargeRadius: number
  chargeHeight: number
  /** park 圆点半径 / 高 */
  parkRadius: number
  parkHeight: number
  /** node 圆点半径 / 高 */
  navRadius: number
  navHeight: number
}

/** work 方形台：底面贴 y=0 的方台 */
export function buildWorkPlatformGeometry(size: number, height: number): BufferGeometry {
  const geometry = new BoxGeometry(size, height, size)
  geometry.translate(0, height / 2, 0)
  return geometry
}

/** work 图标色块：方台顶面之上的 45° 旋转方块（俯视呈菱形图标） */
export function buildWorkIconGeometry(
  size: number,
  height: number,
  platformHeight: number,
): BufferGeometry {
  const geometry = new BoxGeometry(size, height, size)
  geometry.rotateY(Math.PI / 4)
  geometry.translate(0, platformHeight + height / 2, 0)
  return geometry
}

/** charge 六边形台：6 段圆柱（俯视正六边形），底面贴 y=0 */
export function buildChargePlatformGeometry(radius: number, height: number): BufferGeometry {
  const geometry = new CylinderGeometry(radius, radius, height, 6)
  geometry.translate(0, height / 2, 0)
  return geometry
}

/** park / node 圆点：低矮圆柱，底面贴 y=0（尺寸层级由 sizes 区分：node 最小、park 中小） */
export function buildNodeDotGeometry(radius: number, height: number): BufferGeometry {
  const geometry = new CylinderGeometry(radius, radius, height, 20)
  geometry.translate(0, height / 2, 0)
  return geometry
}

/**
 * 按类型构建本地几何段列表：每段对应一个 InstancedMesh（work = 方台 + 图标色块两段，
 * 共享同一组实例矩阵与 nodeIds）。全图 draw call 数 = Σ 各类型段数 = 5（SPEC §6.3 预算 4~5）。
 */
export function buildNodeKindGeometries(
  kind: RenderableNodeKind,
  sizes: NodeShapeSizes,
): BufferGeometry[] {
  switch (kind) {
    case 'work':
      return [
        buildWorkPlatformGeometry(sizes.workPlatformSize, sizes.workPlatformHeight),
        buildWorkIconGeometry(sizes.workIconSize, sizes.workIconHeight, sizes.workPlatformHeight),
      ]
    case 'charge':
      return [buildChargePlatformGeometry(sizes.chargeRadius, sizes.chargeHeight)]
    case 'park':
      return [buildNodeDotGeometry(sizes.parkRadius, sizes.parkHeight)]
    case 'node':
      return [buildNodeDotGeometry(sizes.navRadius, sizes.navHeight)]
  }
}

// ---------------------------------------------------------------------------
// 按类型分组的实例布局（实例矩阵 + instanceId → 节点 id 映射表）
// ---------------------------------------------------------------------------

/** 单类型实例组：一个 InstancedMesh（work 为共享矩阵的两段）的完整数据 */
export interface NodeInstanceGroup {
  kind: RenderableNodeKind
  /**
   * instanceId → 节点 id 映射表（SPEC §8.2 拾取反查）；
   * 实例顺序保持输入节点顺序，矩阵与之一一对应。
   */
  nodeIds: string[]
  /** 实例矩阵（Matrix4.elements 列主序展平，长度 = nodeIds.length × 16） */
  matrices: Float32Array
}

export interface NodeInstanceBuildResult {
  /** 按 RENDERABLE_NODE_KINDS 固定顺序的分组（空类型同样返回，nodeIds 为空） */
  groups: NodeInstanceGroup[]
}

/** 由 instanceId 反查节点 id（SPEC §8.2）；非法 instanceId 返回 null */
export function getNodeIdAtInstance(group: NodeInstanceGroup, instanceId: number): string | null {
  if (!Number.isInteger(instanceId) || instanceId < 0 || instanceId >= group.nodeIds.length) {
    return null
  }
  return group.nodeIds[instanceId]
}

/**
 * node 类整类隐藏判定（SPEC §6.3）：相机距离（相机 → 视线关注点）超过阈值时
 * node 类型整类隐藏；场景层据此开关整组 visible，不做逐实例操作。
 */
export function shouldHideNavNodes(cameraDistance: number, hideDistance: number): boolean {
  return cameraDistance > hideDistance
}

/**
 * 分帧构建器（SPEC §4.4）：buildNext 按节点增量推进，结果与一次性构建完全一致；
 * done 后 finalize 组装各类型分组。
 */
export interface NodeInstanceBuilder {
  /** 输入节点总数（含将被跳过的 elevator） */
  readonly total: number
  /** 已处理节点数 */
  readonly processed: number
  readonly done: boolean
  /** 处理接下来 count 个节点 */
  buildNext(count: number): void
  /** 全部处理完后调用：组装并返回分组结果（重复调用返回同一结果） */
  finalize(): NodeInstanceBuildResult
}

/** 一次性构建（等价于创建 builder 后一次性推完全部节点；测试与离线场景用） */
export function buildNodeInstances(
  nodes: NormalizedNode[],
  calibration: Calibration,
): NodeInstanceBuildResult {
  const builder = createNodeInstanceBuilder(nodes, calibration)
  while (!builder.done) {
    builder.buildNext(nodes.length)
  }
  return builder.finalize()
}

interface KindAccumulator {
  nodeIds: string[]
  floats: number[]
}

type KindAccumulators = Record<RenderableNodeKind, KindAccumulator>

function createKindAccumulators(): KindAccumulators {
  return {
    work: { nodeIds: [], floats: [] },
    charge: { nodeIds: [], floats: [] },
    park: { nodeIds: [], floats: [] },
    node: { nodeIds: [], floats: [] },
  }
}

interface EmitContext {
  accumulators: KindAccumulators
  calibration: Calibration
  position: Vector3
  quaternion: Quaternion
  euler: Euler
  scale: Vector3
  matrix: Matrix4
}

export function createNodeInstanceBuilder(
  nodes: NormalizedNode[],
  calibration: Calibration,
): NodeInstanceBuilder {
  const context: EmitContext = {
    accumulators: createKindAccumulators(),
    calibration,
    position: new Vector3(),
    quaternion: new Quaternion(),
    euler: new Euler(),
    scale: new Vector3(1, 1, 1),
    matrix: new Matrix4(),
  }
  let cursor = 0
  let finalized: NodeInstanceBuildResult | null = null

  return {
    get total() {
      return nodes.length
    },
    get processed() {
      return cursor
    },
    get done() {
      return cursor >= nodes.length
    },
    buildNext(count: number) {
      if (finalized !== null) {
        return
      }
      const end = Math.min(nodes.length, cursor + Math.max(1, Math.floor(count)))
      for (; cursor < end; cursor++) {
        emitNode(context, nodes[cursor])
      }
    },
    finalize() {
      if (finalized === null) {
        finalized = {
          groups: RENDERABLE_NODE_KINDS.map((kind) => ({
            kind,
            nodeIds: context.accumulators[kind].nodeIds,
            matrices: Float32Array.from(context.accumulators[kind].floats),
          })),
        }
      }
      return finalized
    },
  }
}

/**
 * 单个节点的实例写入：elevator 跳过（本期不渲染，SPEC §6.3）；
 * 世界坐标经 mapToWorld、朝向经 headingToWorldYaw（均收口于 domain/coordinates.ts）。
 */
function emitNode(context: EmitContext, node: NormalizedNode): void {
  if (node.kind === 'elevator') {
    return
  }
  const world = mapToWorld({ x: node.x, y: node.y }, context.calibration)
  const yaw = node.angle === null ? 0 : headingToWorldYaw(node.angle, context.calibration)
  context.position.set(world.x, 0, world.z)
  context.euler.set(0, yaw, 0)
  context.quaternion.setFromEuler(context.euler)
  context.matrix.compose(context.position, context.quaternion, context.scale)
  const accumulator = context.accumulators[node.kind]
  accumulator.nodeIds.push(node.id)
  accumulator.floats.push(...context.matrix.elements)
}
