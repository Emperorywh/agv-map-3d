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
 * 圆盘/圆环/朝向符号局部几何不进 SceneModel transfer 契约（Worker 只输出矩阵/颜色），
 * 其构建由主线程唯一消费者持有：rendering/scene/map/instanceGeometry.ts
 * （本地 XZ 平面、法线 +Y、+X 前向，§4.2）。
 *
 * 层依赖说明：§13.4 的站点颜色由组合根经 options 注入（infrastructure 不反向
 * 依赖 config 层，§12）；§4.3 高度层 y 偏移未列入 §13 配置表，作为构建期固定
 * 常量定义在本文件并烘焙进实例矩阵。
 */

import { mapToWorld, yawFromMapAngle } from '../../../domain/coordinates'
import type { FactoryMapNode } from '../../../domain/factoryMap'
import type {
  ColoredInstanceBatchDto,
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
