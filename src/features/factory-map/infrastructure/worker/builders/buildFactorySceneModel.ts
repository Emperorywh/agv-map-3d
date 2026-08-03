/**
 * 场景模型编排器（SPEC §5.1、§8.2、§11）。
 *
 * Worker 构建管线的单一入口（Worker 内纯函数，不依赖 DOM/Three）：
 *   decodeMapEnvelope（含 §3.3 全部不变量）→ bounds（§6.1）
 *   → 路径条带/箭头批次（§7.1、§7.2）→ 节点实例批次（§7.3、§7.4）
 *   → labels 元数据（§8.2）→ stats → transfer 前断言（§5.1）
 *
 * 空图（nodes 与 edges 同时为空）：全部批次为空数组，bounds 为 60×40m 空态
 * 尺寸（domain/bounds.ts 语义），stats 全零——由页面状态判定为 empty（§11）。
 *
 * 层依赖说明：FACTORY_MARGIN（§13.1）、LABEL_ANCHOR_Y（§13.2）与站点颜色
 * （§13.4）由组合根经 options 注入（infrastructure 不反向依赖 config 层，§12）。
 */

import {
  edgeLabelId,
  nodeLabelId,
  toFactoryBoundsDto,
} from '../../../application/factorySceneModel'
import type {
  FactorySceneModel,
  GeometryBatchDto,
  InstanceBatchDto,
  ColoredInstanceBatchDto,
  LabelMetadataDto,
} from '../../../application/factorySceneModel'
import { computeMapBounds, deriveFactoryBounds } from '../../../domain/bounds'
import { mapToWorld } from '../../../domain/coordinates'
import { decodeMapEnvelope } from '../../../domain/decodeMapEnvelope'
import { SceneBuildError } from '../../../domain/errors'
import type { FactoryMap } from '../../../domain/factoryMap'
import { isStationNodeType } from '../../../domain/factoryMap'
import { buildNodeInstances } from './buildNodeInstances'
import type { NodeBuildOptions } from './buildNodeInstances'
import { buildPathBatches } from './buildPathBatches'
import type { EdgeLabelAnchor, PathBuildOptions } from './buildPathBatches'

/** 路径标签锚点沿左法线的偏移距离（§8.2：0.2m；未列入 §13 配置表，唯一定义于此） */
export const PATH_LABEL_NORMAL_OFFSET = 0.2

// ---------------------------------------------------------------------------
// 注入选项
// ---------------------------------------------------------------------------

export interface SceneBuildOptions {
  /** 地图 bbox 四周外扩量 FACTORY_MARGIN（§6.1、§13.1：10m） */
  readonly factoryMargin: number
  /** 标签锚点高度 LABEL_ANCHOR_Y（§8.2、§13.2：0.5m） */
  readonly labelAnchorY: number
  /** 路径构建选项（§13.1 度量常量） */
  readonly path: PathBuildOptions
  /** 节点构建选项（§13.4 站点颜色） */
  readonly nodes: NodeBuildOptions
}

// ---------------------------------------------------------------------------
// 标签元数据组装（§8.2）
// ---------------------------------------------------------------------------

/**
 * 组装标签元数据：
 * - 节点标签：node.name，锚点位于节点正上方 labelAnchorY 处；
 *   类别按是否站点（work/charge/park → station，node → node）
 * - 路径标签：edge.name，锚点位于弧长 s=0.4L 处沿左法线偏移 0.2m、同高
 * - id 固定 node:<nodeId> / edge:<edgeId>（application 契约函数），
 *   节点/边 id 各自唯一（§3.3 不变量）且前缀隔离跨集合冲突 → 全局唯一
 */
function buildLabelMetadata(
  map: FactoryMap,
  pathAnchors: readonly EdgeLabelAnchor[],
  labelAnchorY: number,
): LabelMetadataDto[] {
  const labels: LabelMetadataDto[] = []
  for (const node of map.nodes) {
    const world = mapToWorld(node.x, node.y)
    labels.push({
      id: nodeLabelId(node.id),
      category: isStationNodeType(node.type) ? 'station' : 'node',
      text: node.name,
      worldPosition: [world.x, labelAnchorY, world.z],
    })
  }
  for (const anchor of pathAnchors) {
    const world = mapToWorld(
      anchor.x + anchor.leftNormalX * PATH_LABEL_NORMAL_OFFSET,
      anchor.y + anchor.leftNormalY * PATH_LABEL_NORMAL_OFFSET,
    )
    labels.push({
      id: edgeLabelId(anchor.edgeId),
      category: 'path',
      text: anchor.edgeName,
      worldPosition: [world.x, labelAnchorY, world.z],
    })
  }
  return labels
}

// ---------------------------------------------------------------------------
// transfer 前断言（§5.1：Worker 不得把不可信 buffer 交给主线程）
// ---------------------------------------------------------------------------

function failAssertion(reason: string): never {
  throw new SceneBuildError(
    'SCENE_MODEL_ASSERTION_FAILED',
    `场景模型 transfer 前断言失败：${reason}`,
  )
}

function assertFinite(values: Float32Array | Uint32Array, label: string): void {
  for (let i = 0; i < values.length; i += 1) {
    if (!Number.isFinite(values[i])) {
      failAssertion(`${label}[${i}] 不是有限数值（${values[i]}）`)
    }
  }
}

/** 几何批次：positions/normals 等长且为 3 倍数、indices 全部小于顶点数、全部有限 */
function assertGeometryBatch(batch: GeometryBatchDto, label: string): void {
  if (batch.positions.length !== batch.normals.length) {
    failAssertion(`${label} positions 长度 ${batch.positions.length} 与 normals 长度 ${batch.normals.length} 不一致`)
  }
  if (batch.positions.length % 3 !== 0) {
    failAssertion(`${label} positions 长度 ${batch.positions.length} 不是 3 的倍数`)
  }
  const vertexCount = batch.positions.length / 3
  for (let i = 0; i < batch.indices.length; i += 1) {
    if (batch.indices[i] >= vertexCount) {
      failAssertion(`${label} indices[${i}]=${batch.indices[i]} 超出顶点数 ${vertexCount}`)
    }
  }
  assertFinite(batch.positions, `${label} positions`)
  assertFinite(batch.normals, `${label} normals`)
}

/** 实例批次：matrices 长度为 16 倍数且全部有限 */
function assertInstanceBatch(batch: InstanceBatchDto, label: string): number {
  if (batch.matrices.length % 16 !== 0) {
    failAssertion(`${label} matrices 长度 ${batch.matrices.length} 不是 16 的倍数`)
  }
  assertFinite(batch.matrices, `${label} matrices`)
  return batch.matrices.length / 16
}

/** 带颜色实例批次：colors 数量与实例数一致（每实例 RGB 三分量）且全部有限 */
function assertColoredInstanceBatch(batch: ColoredInstanceBatchDto, label: string): void {
  const instanceCount = assertInstanceBatch(batch, label)
  if (batch.colors.length !== instanceCount * 3) {
    failAssertion(
      `${label} colors 长度 ${batch.colors.length} 与实例数 ${instanceCount} 不一致（应为 ${instanceCount * 3}）`,
    )
  }
  assertFinite(batch.colors, `${label} colors`)
}

/**
 * §5.1 transfer 前断言：任一不满足抛 SceneBuildError（不产出部分 SceneModel）。
 * 导出以便对断言本身做失败测试；正常构建路径恒通过（构建器保证不变量）。
 */
export function assertSceneModelTransferable(model: FactorySceneModel): void {
  assertGeometryBatch(model.paths.forward, 'paths.forward')
  assertGeometryBatch(model.paths.backward, 'paths.backward')
  assertInstanceBatch(model.arrows.forward, 'arrows.forward')
  assertInstanceBatch(model.arrows.backward, 'arrows.backward')
  assertInstanceBatch(model.nodes.dots, 'nodes.dots')
  assertColoredInstanceBatch(model.nodes.rings, 'nodes.rings')
  assertColoredInstanceBatch(model.nodes.directions, 'nodes.directions')

  const labelIds = new Set<string>()
  for (const label of model.labels) {
    if (labelIds.has(label.id)) {
      failAssertion(`标签 id 不全局唯一：${JSON.stringify(label.id)}`)
    }
    labelIds.add(label.id)
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * buildFactorySceneModel：unknown 信封 → FactorySceneModel（§5.1 唯一场景契约）。
 * 任一环节失败抛领域错误（MapEnvelopeError / MapValidationError / MapCapacityError /
 * MapGeometryError / SceneBuildError），不产出部分结果。
 */
export function buildFactorySceneModel(
  payload: unknown,
  options: SceneBuildOptions,
): FactorySceneModel {
  const map = decodeMapEnvelope(payload)
  const bounds = deriveFactoryBounds(computeMapBounds(map), options.factoryMargin)

  const pathResult = buildPathBatches(map.edges, options.path)
  const nodeResult = buildNodeInstances(map.nodes, options.nodes)
  const labels = buildLabelMetadata(map, pathResult.labelAnchors, options.labelAnchorY)

  const arrowCount =
    pathResult.forwardArrows.matrices.length / 16 + pathResult.backwardArrows.matrices.length / 16

  const model: FactorySceneModel = {
    bounds: toFactoryBoundsDto(bounds),
    paths: { forward: pathResult.forward, backward: pathResult.backward },
    arrows: { forward: pathResult.forwardArrows, backward: pathResult.backwardArrows },
    nodes: {
      dots: nodeResult.dots,
      rings: nodeResult.rings,
      directions: nodeResult.directions,
    },
    labels,
    stats: {
      nodeCount: map.nodes.length,
      edgeCount: map.edges.length,
      arrowCount,
      labelMetadataCount: labels.length,
    },
  }
  assertSceneModelTransferable(model)
  return model
}
