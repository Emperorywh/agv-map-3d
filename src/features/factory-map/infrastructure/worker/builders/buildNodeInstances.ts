/**
 * 节点实例构建器（SPEC §7.3、§7.4、§4.3 节点高度层）。
 *
 * Worker 内纯函数：不依赖 DOM/Three，可在 vitest node 环境直接测试。
 * - 普通节点（node）：一个 InstancedMesh 圆点批次（实例矩阵只含平移，半径由局部几何承载）
 * - 站点（work/charge/park）：一个 InstancedMesh 圆环批次，instanceColor 表达三种
 *   合法类型（线性颜色空间；材质不得启用 vertexColors，§7.3）
 * - 站点 angle !== null 时叠加朝向符号批次（一个 InstancedMesh，颜色同所属圆环）；
 *   angle === null 不生成朝向符号；普通 node 的 angle 由领域不变量保证为 null（§3.3）
 *
 * 圆盘/圆环/朝向符号局部几何直接在本地 XZ 平面构建、法线 +Y、本地 +X 前向，
 * 不使用 CircleGeometry 默认 XY 平面叠加旋转（§4.2）。
 *
 * 层依赖说明：§13.1 的半径尺寸与 §13.4 的站点颜色由组合根经 options/参数注入
 * （infrastructure 不反向依赖 config 层，§12）；§4.3 高度层 y 偏移与 §7.4 符号
 * 几何比例未列入 §13 配置表，作为构建期固定常量定义在本文件。
 */

import { mapToWorld, yawFromMapAngle } from '../../../domain/coordinates'
import type { FactoryMapNode } from '../../../domain/factoryMap'
import type {
  ColoredInstanceBatchDto,
  GeometryBatchDto,
  InstanceBatchDto,
} from '../../../application/factorySceneModel'

// ---------------------------------------------------------------------------
// §4.3 高度层 y 偏移（构建期烘焙进实例矩阵）
// ---------------------------------------------------------------------------

/** 普通节点圆点 y 偏移（§4.3） */
export const NODE_DOT_Y = 0.012
/** 站点圆环 y 偏移（§4.3） */
export const STATION_RING_Y = 0.014
/** 站点朝向符号 y 偏移（§4.3） */
export const STATION_DIRECTION_Y = 0.016

/** 圆盘/圆环分段数（§7.3：createDiskGeometryXZ(24) / createRingGeometryXZ(24)） */
export const NODE_GEOMETRY_SEGMENTS = 24

/** 朝向符号条宽（§7.4：0.05m，r = 0.15m 时的固定值） */
export const STATION_DIRECTION_STRIP_WIDTH = 0.05

/** 朝向符号顶点前伸比例：顶点 (+0.55r, 0)（§7.4） */
export const STATION_DIRECTION_TIP_RATIO = 0.55

/** 朝向符号翼端比例：两翼端点 (0, ±0.5r)（§7.4） */
export const STATION_DIRECTION_WING_RATIO = 0.5

// ---------------------------------------------------------------------------
// 注入选项（站点颜色为 sRGB hex，由组合根从 config/visualTheme.ts 传入）
// ---------------------------------------------------------------------------

export interface StationColorOptions {
  /** work 工作站颜色（#2196F3 蓝） */
  readonly work: string
  /** charge 充电点颜色（#8BC34A 绿） */
  readonly charge: string
  /** park 停车点颜色（#F44336 红） */
  readonly park: string
}

export interface NodeBuildOptions {
  readonly stationColors: StationColorOptions
}

export interface NodeInstancesResult {
  /** 普通节点圆点实例（y=+0.012 已烘焙） */
  readonly dots: InstanceBatchDto
  /** 站点圆环实例 + 逐实例线性颜色（y=+0.014 已烘焙） */
  readonly rings: ColoredInstanceBatchDto
  /** 站点朝向符号实例 + 逐实例线性颜色（y=+0.016 已烘焙；仅 angle !== null 的站点） */
  readonly directions: ColoredInstanceBatchDto
}

// ---------------------------------------------------------------------------
// sRGB → 线性颜色空间（instanceColor 契约：线性空间 RGB 三分量）
// ---------------------------------------------------------------------------

function srgbChannelToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

/** '#RRGGBB' sRGB 十六进制 → 线性颜色空间 [r, g, b]（IEC 61966-2-1 转换） */
export function srgbHexToLinearRgb(hex: string): readonly [number, number, number] {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255
  return [srgbChannelToLinear(r), srgbChannelToLinear(g), srgbChannelToLinear(b)]
}

// ---------------------------------------------------------------------------
// 本地 XZ 平面几何（法线 +Y、+X 前向）；z 符号约定经 mapToWorld 保持唯一出处
// ---------------------------------------------------------------------------

interface LocalGeometryStaging {
  readonly positions: number[]
  readonly normals: number[]
  readonly indices: number[]
}

/** 本地平面坐标 (x, y) → 本地世界坐标 (x, 0, -y)（与地图数据同一 z 约定） */
function pushLocalVertex(staging: LocalGeometryStaging, x: number, y: number): number {
  const world = mapToWorld(x, y)
  staging.positions.push(world.x, 0, world.z)
  staging.normals.push(0, 1, 0)
  return staging.positions.length / 3 - 1
}

/** 按世界坐标叉积 y 分量自动排布绕序，保证三角形法线为 +Y */
function pushLocalTriangle(
  staging: LocalGeometryStaging,
  ia: number,
  ib: number,
  ic: number,
): void {
  const p = staging.positions
  const ax = p[ia * 3]
  const az = p[ia * 3 + 2]
  const bx = p[ib * 3]
  const bz = p[ib * 3 + 2]
  const cx = p[ic * 3]
  const cz = p[ic * 3 + 2]
  const crossY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
  if (crossY < 0) {
    staging.indices.push(ia, ic, ib)
  } else {
    staging.indices.push(ia, ib, ic)
  }
}

function toGeometryBatch(staging: LocalGeometryStaging): GeometryBatchDto {
  return {
    positions: Float32Array.from(staging.positions),
    normals: Float32Array.from(staging.normals),
    indices: Uint32Array.from(staging.indices),
  }
}

/**
 * 实心圆盘局部几何（§7.3 普通节点，r = 0.10m）：
 * 中心点 + segments 个圆周点的三角扇，本地 XZ 平面、法线 +Y。
 */
export function createDiskGeometryXZ(segments: number, radius: number): GeometryBatchDto {
  const staging: LocalGeometryStaging = { positions: [], normals: [], indices: [] }
  const center = pushLocalVertex(staging, 0, 0)
  const rim: number[] = []
  for (let k = 0; k < segments; k += 1) {
    const angle = (k / segments) * Math.PI * 2
    rim.push(pushLocalVertex(staging, radius * Math.cos(angle), radius * Math.sin(angle)))
  }
  for (let k = 0; k < segments; k += 1) {
    pushLocalTriangle(staging, center, rim[k], rim[(k + 1) % segments])
  }
  return toGeometryBatch(staging)
}

/**
 * 圆环局部几何（§7.3 站点，外 r 0.15m / 内 r 0.09m）：
 * 外/内两圈各 segments 个点，每段一个 quad，本地 XZ 平面、法线 +Y。
 */
export function createRingGeometryXZ(
  segments: number,
  outerRadius: number,
  innerRadius: number,
): GeometryBatchDto {
  const staging: LocalGeometryStaging = { positions: [], normals: [], indices: [] }
  const outer: number[] = []
  const inner: number[] = []
  for (let k = 0; k < segments; k += 1) {
    const angle = (k / segments) * Math.PI * 2
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    outer.push(pushLocalVertex(staging, outerRadius * cos, outerRadius * sin))
    inner.push(pushLocalVertex(staging, innerRadius * cos, innerRadius * sin))
  }
  for (let k = 0; k < segments; k += 1) {
    const next = (k + 1) % segments
    pushLocalTriangle(staging, outer[k], inner[k], outer[next])
    pushLocalTriangle(staging, outer[next], inner[k], inner[next])
  }
  return toGeometryBatch(staging)
}

/**
 * 站点朝向符号局部几何（§7.4）：圆环内人字形「>」，
 * 顶点 (+0.55r, 0)，两翼端点 (0, ±0.5r)，条宽 0.05m（r 为站点圆环外径）。
 * 两片 quad，本地 XZ 平面、法线 +Y、+X 前向（rotation.y = node.angle 即得正确朝向）。
 */
export function createStationDirectionGeometryXZ(outerRadius: number): GeometryBatchDto {
  const staging: LocalGeometryStaging = { positions: [], normals: [], indices: [] }
  const tipX = STATION_DIRECTION_TIP_RATIO * outerRadius
  const wingSpread = STATION_DIRECTION_WING_RATIO * outerRadius
  const halfStrip = STATION_DIRECTION_STRIP_WIDTH / 2
  for (const side of [1, -1] as const) {
    const wingX = 0
    const wingY = side * wingSpread
    const dx = wingX - tipX
    const dy = wingY
    const len = Math.hypot(dx, dy)
    const nx = (-dy / len) * halfStrip
    const ny = (dx / len) * halfStrip
    const v0 = pushLocalVertex(staging, tipX + nx, ny)
    const v1 = pushLocalVertex(staging, tipX - nx, -ny)
    const v2 = pushLocalVertex(staging, wingX + nx, wingY + ny)
    const v3 = pushLocalVertex(staging, wingX - nx, wingY - ny)
    pushLocalTriangle(staging, v0, v2, v1)
    pushLocalTriangle(staging, v1, v2, v3)
  }
  return toGeometryBatch(staging)
}

// ---------------------------------------------------------------------------
// 实例矩阵（列主序 16 floats：rotation.y = yaw + 平移）
// ---------------------------------------------------------------------------

function pushInstanceMatrix(
  staging: number[],
  yaw: number,
  worldX: number,
  layerY: number,
  worldZ: number,
): void {
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  staging.push(cos, 0, -sin, 0, 0, 1, 0, 0, sin, 0, cos, 0, worldX, layerY, worldZ, 1)
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * buildNodeInstances（§7.3、§7.4）：一次遍历 nodes 产出圆点/圆环/朝向符号三批次。
 * 圆点与圆环实例矩阵为纯平移（旋转对旋转对称几何无意义）；
 * 朝向符号矩阵 rotation.y = node.angle（§4.2：+X 前向几何体直接取数据系角度）。
 */
export function buildNodeInstances(
  nodes: readonly FactoryMapNode[],
  options: NodeBuildOptions,
): NodeInstancesResult {
  const dotMatrices: number[] = []
  const ringMatrices: number[] = []
  const ringColors: number[] = []
  const directionMatrices: number[] = []
  const directionColors: number[] = []

  for (const node of nodes) {
    const world = mapToWorld(node.x, node.y)
    if (node.type === 'node') {
      pushInstanceMatrix(dotMatrices, 0, world.x, NODE_DOT_Y, world.z)
      continue
    }
    const [r, g, b] = srgbHexToLinearRgb(options.stationColors[node.type])
    pushInstanceMatrix(ringMatrices, 0, world.x, STATION_RING_Y, world.z)
    ringColors.push(r, g, b)
    if (node.angle === null) continue
    pushInstanceMatrix(directionMatrices, yawFromMapAngle(node.angle), world.x, STATION_DIRECTION_Y, world.z)
    directionColors.push(r, g, b)
  }

  return {
    dots: { matrices: Float32Array.from(dotMatrices) },
    rings: {
      matrices: Float32Array.from(ringMatrices),
      colors: Float32Array.from(ringColors),
    },
    directions: {
      matrices: Float32Array.from(directionMatrices),
      colors: Float32Array.from(directionColors),
    },
  }
}
