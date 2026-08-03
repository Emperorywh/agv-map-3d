/**
 * 用例输出契约：FactorySceneModel 及全部 DTO（SPEC §5.1 逐字段对应）。
 *
 * FactorySceneModel 是 Worker 与主线程之间的唯一场景契约：
 * - 全部字段只读（readonly / readonly 数组 / 只读元组）；渲染层只能绑定和读取，
 *   不得就地修改场景模型。TypedArray 本身可变，只读约束由类型系统承载。
 * - 可序列化、TypedArray 可转移：Worker 完成构建后把 TypedArray 的底层
 *   ArrayBuffer 以 transfer 方式交给主线程，主线程零拷贝绑定为 BufferAttribute。
 * - 本文件只固定 DTO 形状与标签 id 格式；几何构建算法（TASK-005）、
 *   transfer 前断言与主线程 binder 再校验（后续任务）不在此处实现。
 */

import type { FactoryBounds } from '../domain/bounds'

/**
 * 标签类别（§5.1）；数组顺序即 §8.3 候选保留名额的填充顺序
 * （站点 → 普通节点 → 路径）。
 */
export const LABEL_CATEGORIES = ['station', 'node', 'path'] as const

export type LabelCategory = (typeof LABEL_CATEGORIES)[number]

/** 路径条带合并几何批次：Worker 一次遍历直写，不为每条边创建临时几何（§7.1） */
export interface GeometryBatchDto {
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly indices: Uint32Array
}

/** 厂房内空边界（世界坐标，§6.1）；innerMinX/innerMinZ 是内边界，不是地图平移量 */
export interface FactoryBoundsDto {
  readonly innerMinX: number
  readonly innerMaxX: number
  readonly innerMinZ: number
  readonly innerMaxZ: number
  readonly centerX: number
  readonly centerZ: number
}

/** 实例批次（箭头/节点圆点等 InstancedMesh 数据源） */
export interface InstanceBatchDto {
  readonly matrices: Float32Array // 每个实例连续 16 个数
}

/** 带逐实例颜色的实例批次（站点圆环/朝向符号，instanceColor 线性颜色空间） */
export interface ColoredInstanceBatchDto extends InstanceBatchDto {
  readonly colors: Float32Array // 每个实例连续 RGB 三个数，线性颜色空间
}

/** 标签元数据（§8.2）；CSS2D 选择策略只消费本 DTO，不接触领域实体 */
export interface LabelMetadataDto {
  readonly id: string // 固定使用 node:<nodeId> 或 edge:<edgeId>，避免跨集合冲突
  readonly category: LabelCategory
  readonly text: string
  readonly worldPosition: readonly [number, number, number]
}

/** 场景统计（页面状态空态判定、验收报告数据源） */
export interface SceneStatsDto {
  readonly nodeCount: number
  readonly edgeCount: number
  readonly arrowCount: number
  readonly labelMetadataCount: number
}

/**
 * Worker 完成构建后把 TypedArray 所有权转移给主线程。
 * 渲染层只能绑定和读取这些数组，不得就地修改场景模型。
 */
export interface FactorySceneModel {
  readonly bounds: FactoryBoundsDto
  readonly paths: {
    readonly forward: GeometryBatchDto
    readonly backward: GeometryBatchDto
  }
  readonly arrows: {
    readonly forward: InstanceBatchDto
    readonly backward: InstanceBatchDto
  }
  readonly nodes: {
    readonly dots: InstanceBatchDto
    readonly rings: ColoredInstanceBatchDto
    readonly directions: ColoredInstanceBatchDto
  }
  readonly labels: readonly LabelMetadataDto[]
  readonly stats: SceneStatsDto
}

/** 节点标签 id：node:<nodeId>（§5.1、§8.2；格式全项目唯一出处） */
export function nodeLabelId(nodeId: string): string {
  return `node:${nodeId}`
}

/** 路径标签 id：edge:<edgeId>（§5.1、§8.2；格式全项目唯一出处） */
export function edgeLabelId(edgeId: string): string {
  return `edge:${edgeId}`
}

/** 领域 FactoryBounds → §5.1 六字段 DTO（innerWidth/innerDepth 为派生量，不进契约） */
export function toFactoryBoundsDto(bounds: FactoryBounds): FactoryBoundsDto {
  return {
    innerMinX: bounds.innerMinX,
    innerMaxX: bounds.innerMaxX,
    innerMinZ: bounds.innerMinZ,
    innerMaxZ: bounds.innerMaxZ,
    centerX: bounds.centerX,
    centerZ: bounds.centerZ,
  }
}

/**
 * 空态判定（§11：nodes 与 edges 同时为空 → empty 页面状态）。
 * nodes 非空、edges 为空是合法 ready 状态，不属于空态。
 * 空态模型的批次数组为空且 bounds 为 60×40m（domain/bounds.ts 的
 * deriveFactoryBounds(null, …) 语义），由场景构建层保证。
 */
export function isEmptySceneModel(model: FactorySceneModel): boolean {
  return model.stats.nodeCount === 0 && model.stats.edgeCount === 0
}
