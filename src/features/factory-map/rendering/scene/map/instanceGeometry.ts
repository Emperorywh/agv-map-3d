/**
 * 地图实例局部几何（SPEC §7.2、§7.3、§7.4）。
 *
 * 主线程纯函数模块（无 React/Three 依赖）：构建方向箭头 chevron、普通节点圆盘、
 * 站点圆环、站点朝向符号四份局部几何批次，由 MapSceneResources 绑定为
 * InstancedMesh 的共享 geometry（实例位置/朝向/颜色由 Worker 构建的实例矩阵与
 * instanceColor 承载，§5.1——局部几何不进 SceneModel transfer 契约）。
 *
 * 几何契约随 TASK-005 冻结（顶点坐标由基准测试钉死）：直接在本地 XZ 平面构建、
 * 法线 +Y、本地 +X 前向，不使用 CircleGeometry 默认 XY 平面再叠加隐式旋转
 * （§4.2）；z 取反唯一定义在 domain/coordinates.ts（mapToWorld）。
 *
 * 模块归属说明：本模块原位于 infrastructure/worker/builders（TASK-005 随构建器
 * 一并冻结），但 Worker 构建管线不消费局部几何（只输出矩阵/颜色），唯一消费者是
 * 主线程 MapSceneResources；rendering 不得依赖 infrastructure（§12 层方向），
 * 故随 TASK-011 迁至 rendering/scene/map——算法逐字保留，Worker 构建器行为不变。
 */

import type { GeometryBatchDto } from '../../../application/factorySceneModel'
import { mapToWorld } from '../../../domain/coordinates'

// ---------------------------------------------------------------------------
// §7.2 / §7.3 / §7.4 构建期固定常量（未列入 §13 配置表，唯一定义于此）
// ---------------------------------------------------------------------------

/** 圆盘/圆环分段数（§7.3：createDiskGeometryXZ(24) / createRingGeometryXZ(24)） */
export const NODE_GEOMETRY_SEGMENTS = 24

/** 朝向符号条宽（§7.4：0.05m，r = 0.15m 时的固定值） */
export const STATION_DIRECTION_STRIP_WIDTH = 0.05

/** 朝向符号顶点前伸比例：顶点 (+0.55r, 0)（§7.4） */
export const STATION_DIRECTION_TIP_RATIO = 0.55

/** 朝向符号翼端比例：两翼端点 (0, ±0.5r)（§7.4） */
export const STATION_DIRECTION_WING_RATIO = 0.5

/** chevron 箭头几何（§7.2）：顶点 (+0.18, 0)，两翼端点 (-0.10, ±0.14)，条宽 0.06m */
export const CHEVRON_TIP_X = 0.18
export const CHEVRON_WING_X = -0.1
export const CHEVRON_WING_SPREAD = 0.14
export const CHEVRON_STRIP_WIDTH = 0.06

// ---------------------------------------------------------------------------
// 本地 XZ 平面几何暂存（法线 +Y、+X 前向）；z 符号约定经 mapToWorld 保持唯一出处
// ---------------------------------------------------------------------------

interface LocalGeometryStaging {
  readonly positions: number[]
  readonly normals: number[]
  readonly indices: number[]
}

function createStaging(): LocalGeometryStaging {
  return { positions: [], normals: [], indices: [] }
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

// ---------------------------------------------------------------------------
// 四份局部几何（§7.2 / §7.3 / §7.4）
// ---------------------------------------------------------------------------

/**
 * 实心圆盘局部几何（§7.3 普通节点，r = 0.10m）：
 * 中心点 + segments 个圆周点的三角扇，本地 XZ 平面、法线 +Y。
 */
export function createDiskGeometryXZ(segments: number, radius: number): GeometryBatchDto {
  const staging = createStaging()
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
  const staging = createStaging()
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
  const staging = createStaging()
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

/**
 * 方向箭头 chevron 几何：顶点 (+0.18, 0)，两翼端点 (-0.10, ±0.14)，条宽 0.06m。
 * 两片 quad = 8 顶点 4 三角形；直接在本地 XZ 平面构建（法线 +Y、+X 前向），
 * 不使用 CircleGeometry 一类默认 XY 平面再叠加旋转的做法（§4.2）。
 * 翼形关于 +X 对称，条带 quad 以「顶点 → 翼端」为中线、两侧各扩条宽一半。
 */
export function createChevronGeometryXZ(): GeometryBatchDto {
  const staging = createStaging()
  const halfStrip = CHEVRON_STRIP_WIDTH / 2
  for (const side of [1, -1] as const) {
    // 叶片中线：顶点 → 翼端（数据坐标；关于 x 轴对称，z 取反后形状不变）
    const tipX = CHEVRON_TIP_X
    const tipY = 0
    const wingX = CHEVRON_WING_X
    const wingY = side * CHEVRON_WING_SPREAD
    const dx = wingX - tipX
    const dy = wingY - tipY
    const len = Math.hypot(dx, dy)
    const nx = (-dy / len) * halfStrip
    const ny = (dx / len) * halfStrip
    const v0 = pushLocalVertex(staging, tipX + nx, tipY + ny)
    const v1 = pushLocalVertex(staging, tipX - nx, tipY - ny)
    const v2 = pushLocalVertex(staging, wingX + nx, wingY + ny)
    const v3 = pushLocalVertex(staging, wingX - nx, wingY - ny)
    pushLocalTriangle(staging, v0, v2, v1)
    pushLocalTriangle(staging, v1, v2, v3)
  }
  return toGeometryBatch(staging)
}
