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
 * 地图实例局部几何（节点造型与 AGV 造型，SPEC §6.3 / §7.3）唯一存放处。
 */

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  Matrix4,
  Quaternion,
  TorusGeometry,
  Vector3,
} from 'three'
import type { ColorRepresentation } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import { headingToWorldYaw, mapToWorld } from '../../../domain/coordinates'
import type { AgvSnapshot, AgvStatus } from '../../../domain/simulator'
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

// ---------------------------------------------------------------------------
// AGV 风格化小车（SPEC §7.3）：底盘 + 顶盖 + 方向楔形/前灯 + 顶部状态色环
//
// - 本地几何约定 +Z 为车头（SPEC §5.4 资产前向轴，与 headingToWorldYaw 的推导同口径）；
// - 车体（底盘 / 顶盖 / 楔形 / 前灯）合并为单个 BufferGeometry，顶点色分色，
//   一个 InstancedMesh 一个 draw call；状态色环为独立 InstancedMesh，六状态
//   走实例色（agvStatusColors）；100 台上限内合计恒为 2 个 draw call（SPEC §9）；
// - 每帧写入收敛于 writeAgvInstanceMatrices / writeAgvStatusColors 纯函数：
//   只写既有实例矩阵 / 实例色数组（in-place，零分配、零几何重建，SPEC §7.3 / §9）。
// ---------------------------------------------------------------------------

/** AGV 造型尺寸（值取自 config/constants.ts，由场景层注入） */
export interface AgvShapeSizes {
  /** 车体 footprint：长（沿车头方向 +Z）× 宽 */
  bodyLength: number
  bodyWidth: number
  /** 底盘高度（底面贴 y=0） */
  chassisHeight: number
  /** 顶盖：长 × 宽 × 高 + 向车尾（-Z）的偏移 */
  coverLength: number
  coverWidth: number
  coverHeight: number
  coverRearOffset: number
  /** 方向楔形：长 × 宽 × 高（薄边指向 +Z 车头） */
  wedgeLength: number
  wedgeWidth: number
  wedgeHeight: number
  /** 前灯：宽 × 高 × 深 + 横向安装位置 / 安装高度 */
  headlightWidth: number
  headlightHeight: number
  headlightDepth: number
  headlightInset: number
  headlightLift: number
  /** 顶部状态色环：半径 / 管径 / 环底相对顶盖顶面的抬升 */
  ringRadius: number
  ringTube: number
  ringLift: number
}

/** AGV 本体分段色（状态色环为实例色，不在此列；值取自 config/theme.ts） */
export interface AgvShapeColors {
  chassis: string
  cover: string
  wedge: string
  headlight: string
}

/** 为几何填充单一顶点色（合并几何走顶点色管线，单材质多色） */
function withSolidVertexColor(
  geometry: BufferGeometry,
  color: ColorRepresentation,
): BufferGeometry {
  const parsed = new Color(color)
  const count = geometry.getAttribute('position').count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    colors[i * 3] = parsed.r
    colors[i * 3 + 1] = parsed.g
    colors[i * 3 + 2] = parsed.b
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
  return geometry
}

/**
 * 方向楔形本地几何：三棱柱，底面贴 y=0、z ∈ [-length/2, length/2]，
 * 薄边指向 +Z（车头方向），厚边（全高）在 -Z 车尾侧。
 * 非索引几何（每面独立顶点，平直着色）；uv 置零仅为与 Box 段属性一致以便合并。
 */
export function buildAgvWedgeGeometry(
  length: number,
  width: number,
  height: number,
): BufferGeometry {
  const w = width / 2
  const l = length / 2
  // 6 个棱柱角点：底面四角 + 车尾顶边两点
  const A = [-w, 0, -l] // 车尾-底-左
  const B = [w, 0, -l] // 车尾-底-右
  const C = [w, 0, l] // 车头-底-右
  const D = [-w, 0, l] // 车头-底-左
  const E = [-w, height, -l] // 车尾-顶-左
  const F = [w, height, -l] // 车尾-顶-右
  // 8 个三角形（外表面逆时针）：底面 / 车尾 / 斜面 / 左右侧
  const triangles = [
    [A, B, C],
    [A, C, D], // 底面（-Y）
    [A, F, B],
    [A, E, F], // 车尾（-Z）
    [E, C, F],
    [E, D, C], // 斜面（+Y +Z）
    [A, D, E], // 左侧（-X）
    [B, F, C], // 右侧（+X）
  ]
  const positions = new Float32Array(triangles.length * 9)
  for (let i = 0; i < triangles.length; i++) {
    for (let corner = 0; corner < 3; corner++) {
      const vertex = triangles[i][corner]
      positions.set(vertex, i * 9 + corner * 3)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(new Float32Array(triangles.length * 6), 2))
  geometry.computeVertexNormals()
  return geometry
}

/**
 * AGV 车体合并几何（SPEC §7.3：底盘 + 顶盖 + 方向楔形/前灯）：
 * 四段顶点色分色合并为单个 BufferGeometry，底面贴 y=0、车头朝本地 +Z；
 * 实例矩阵仅做平移 + 绕 Y 旋转（见 writeAgvInstanceMatrices）。
 */
export function buildAgvBodyGeometry(
  sizes: AgvShapeSizes,
  colors: AgvShapeColors,
): BufferGeometry {
  const parts: BufferGeometry[] = []

  const chassis = new BoxGeometry(sizes.bodyWidth, sizes.chassisHeight, sizes.bodyLength)
  chassis.translate(0, sizes.chassisHeight / 2, 0)
  parts.push(withSolidVertexColor(chassis.toNonIndexed(), colors.chassis))

  const cover = new BoxGeometry(sizes.coverWidth, sizes.coverHeight, sizes.coverLength)
  cover.translate(0, sizes.chassisHeight + sizes.coverHeight / 2, -sizes.coverRearOffset)
  parts.push(withSolidVertexColor(cover.toNonIndexed(), colors.cover))

  const wedge = buildAgvWedgeGeometry(sizes.wedgeLength, sizes.wedgeWidth, sizes.wedgeHeight)
  // 楔形薄边（+Z 端）对齐车头端面
  wedge.translate(0, sizes.chassisHeight, sizes.bodyLength / 2 - sizes.wedgeLength / 2)
  parts.push(withSolidVertexColor(wedge, colors.wedge))

  for (const side of [-1, 1]) {
    const headlight = new BoxGeometry(
      sizes.headlightWidth,
      sizes.headlightHeight,
      sizes.headlightDepth,
    )
    headlight.translate(
      side * sizes.headlightInset,
      sizes.headlightLift,
      sizes.bodyLength / 2 + sizes.headlightDepth / 2 - 0.01,
    )
    parts.push(withSolidVertexColor(headlight.toNonIndexed(), colors.headlight))
  }

  // 各段均为非索引且同属性集（position/normal/uv/color），合并必然成功
  const merged = mergeGeometries(parts, false) as BufferGeometry
  for (const part of parts) {
    part.dispose()
  }
  return merged
}

/** 顶部状态色环本地几何（SPEC §7.3）：水平 torus，环心位于顶盖顶面之上（随顶盖偏车尾） */
export function buildAgvStatusRingGeometry(sizes: AgvShapeSizes): BufferGeometry {
  // 管圆周 12 段：90° 整点处必有顶点，包围盒顶 = 环心 + 管径（精确）
  const ring = new TorusGeometry(sizes.ringRadius, sizes.ringTube, 12, 28)
  ring.rotateX(Math.PI / 2) // 默认 XY 平面 → XZ 水平面
  ring.translate(
    0,
    sizes.chassisHeight + sizes.coverHeight + sizes.ringLift + sizes.ringTube,
    -sizes.coverRearOffset,
  )
  return ring
}

// ---------------------------------------------------------------------------
// AGV 每帧实例写入（纯函数：只写既有数组，零分配、零几何重建，SPEC §7.3 / §9）
// ---------------------------------------------------------------------------

/** 六状态 → RGB 查表（hex 预解析结果；实例色逐帧写入时不再解析字符串） */
export type AgvStatusRgbTable = Readonly<Record<AgvStatus, readonly [number, number, number]>>

/** 把 theme 的六状态 hex 色预解析为 RGB 查表（场景层启动时调用一次） */
export function resolveAgvStatusColors(
  colors: Readonly<Record<AgvStatus, string>>,
): AgvStatusRgbTable {
  const table = {} as Record<AgvStatus, readonly [number, number, number]>
  for (const status of Object.keys(colors) as AgvStatus[]) {
    const parsed = new Color(colors[status])
    table[status] = [parsed.r, parsed.g, parsed.b]
  }
  return table
}

/**
 * 把快照位姿写入实例矩阵数组（列主序 16 float/实例，in-place）。
 * 快照 position / yaw 已由 domain/simulator 经 coordinates.ts（mapToWorld /
 * headingToWorldYaw）换算为世界量，本函数仅做刚体组合（平移 + 绕 Y 旋转），
 * 不做任何额外翻转——倒车姿态由车头朝向语义自然得出（SPEC §7.2）。
 */
export function writeAgvInstanceMatrices(
  target: Float32Array,
  snapshots: readonly AgvSnapshot[],
): void {
  for (let i = 0; i < snapshots.length; i++) {
    const snapshot = snapshots[i]
    const cos = Math.cos(snapshot.yaw)
    const sin = Math.sin(snapshot.yaw)
    const base = i * 16
    // 绕 Y 旋转 yaw（three Matrix4.makeRotationY 同式），平移取快照世界坐标
    target[base] = cos
    target[base + 1] = 0
    target[base + 2] = -sin
    target[base + 3] = 0
    target[base + 4] = 0
    target[base + 5] = 1
    target[base + 6] = 0
    target[base + 7] = 0
    target[base + 8] = sin
    target[base + 9] = 0
    target[base + 10] = cos
    target[base + 11] = 0
    target[base + 12] = snapshot.position.x
    target[base + 13] = snapshot.position.y
    target[base + 14] = snapshot.position.z
    target[base + 15] = 1
  }
}

/** 把快照状态对应的实例色（RGB 查表）写入实例色数组（in-place） */
export function writeAgvStatusColors(
  target: Float32Array,
  snapshots: readonly AgvSnapshot[],
  table: AgvStatusRgbTable,
): void {
  for (let i = 0; i < snapshots.length; i++) {
    const rgb = table[snapshots[i].status]
    const base = i * 3
    target[base] = rgb[0]
    target[base + 1] = rgb[1]
    target[base + 2] = rgb[2]
  }
}
