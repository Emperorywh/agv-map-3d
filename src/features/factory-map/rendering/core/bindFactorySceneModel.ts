/**
 * 主线程 binder：FactorySceneModel → Three 绑定资源（SPEC §5.1、§10.3）。
 *
 * Worker transfer 前已做断言（infrastructure/worker/builders），但主线程不得信任
 * 跨线程边界来的 buffer：绑定前逐字段再校验——
 *   - positions/normals 长度相等且为 3 的倍数
 *   - indices 全部小于顶点数
 *   - matrices 长度为 16 的倍数
 *   - colors 数量与实例数一致（每实例 RGB 三分量）
 *   - 所有浮点数有限（NaN/Infinity 拒绝）
 *   - 数组类型必须是约定的 TypedArray（Float32Array / Uint32Array）
 * 任一失败返回 SceneBuildError（SCENE_MODEL_BIND_INVALID），不创建任何 Three 资源，
 * 不得把不可信 buffer 交给 WebGL。
 *
 * 合法输入零拷贝绑定为 BufferGeometry / BufferAttribute / InstancedBufferAttribute
 * （直接包裹 transfer 过来的 TypedArray，不复制、不修改场景模型），并附带逐一
 * dispose 的释放函数（§10.3：幂等；共享资源只能由唯一 owner 释放）。
 *
 * 本模块为 rendering/core：无 React 依赖；标签元数据不进 WebGL，不在此处绑定。
 */

import { BufferAttribute, BufferGeometry, InstancedBufferAttribute } from 'three'

import type {
  ColoredInstanceBatchDto,
  FactorySceneModel,
  GeometryBatchDto,
  InstanceBatchDto,
} from '../../application/factorySceneModel'
import { SceneBuildError } from '../../domain/errors'
import { describeValue } from '../../domain/invariants'

// ---------------------------------------------------------------------------
// 绑定结果
// ---------------------------------------------------------------------------

/** 绑定后的实例批次：零拷贝包裹 SceneModel 的实例矩阵 buffer */
export interface BoundInstanceBatch {
  /** 实例矩阵（itemSize 16），InstancedMesh.instanceMatrix 数据源 */
  readonly instanceMatrix: InstancedBufferAttribute
  /** 实例数（matrices.length / 16） */
  readonly instanceCount: number
}

/** 绑定后的带颜色实例批次（站点圆环/朝向符号） */
export interface BoundColoredInstanceBatch extends BoundInstanceBatch {
  /** 逐实例颜色（itemSize 3，线性颜色空间），InstancedMesh.instanceColor 数据源 */
  readonly instanceColor: InstancedBufferAttribute
}

/** 绑定后的全部地图批次与统一释放函数 */
export interface BoundSceneBatches {
  readonly paths: {
    readonly forward: BufferGeometry
    readonly backward: BufferGeometry
  }
  readonly arrows: {
    readonly forward: BoundInstanceBatch
    readonly backward: BoundInstanceBatch
  }
  readonly nodes: {
    readonly dots: BoundInstanceBatch
    readonly rings: BoundColoredInstanceBatch
    readonly directions: BoundColoredInstanceBatch
  }
  /** 逐一 dispose 全部 BufferGeometry 与 InstancedBufferAttribute；幂等（§10.3） */
  readonly dispose: () => void
}

/** 绑定结果：失败携带 SceneBuildError，不创建部分资源 */
export type BindFactorySceneModelResult =
  | { readonly ok: true; readonly batches: BoundSceneBatches }
  | { readonly ok: false; readonly error: SceneBuildError }

// ---------------------------------------------------------------------------
// §5.1 主线程再校验
// ---------------------------------------------------------------------------

function bindInvalid(fieldPath: string, reason: string): SceneBuildError {
  return new SceneBuildError('SCENE_MODEL_BIND_INVALID', `场景模型绑定校验失败：${reason}`, {
    fieldPath,
  })
}

/**
 * 防御式读取嵌套字段：模型来自 postMessage（协议层只粗检 model 为对象），
 * 任何中间值不是对象（或为 null）时返回 undefined，交由后续类型断言拒绝。
 */
function nestedField(value: unknown, ...keys: readonly string[]): unknown {
  let current = value
  for (const key of keys) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** 读取批次字段并断言为 Float32Array；失败返回 SceneBuildError */
function readFloat32Array(
  batch: unknown,
  field: string,
  path: string,
): Float32Array | SceneBuildError {
  const value = nestedField(batch, field)
  if (!(value instanceof Float32Array)) {
    return bindInvalid(
      `${path}.${field}`,
      `${path}.${field} 必须是 Float32Array，实际为 ${describeValue(value)}`,
    )
  }
  return value
}

/** 首个非有限数值（NaN/±Infinity）失败；全部有限返回 null */
function firstNonFiniteError(values: Float32Array, fieldPath: string): SceneBuildError | null {
  for (let i = 0; i < values.length; i += 1) {
    if (!Number.isFinite(values[i])) {
      return bindInvalid(fieldPath, `${fieldPath}[${i}] 不是有限数值（${values[i]}）`)
    }
  }
  return null
}

/** 几何批次：positions/normals 等长且为 3 倍数、indices 全部小于顶点数、全部有限 */
function validateGeometryBatch(batch: unknown, path: string): SceneBuildError | null {
  const positions = readFloat32Array(batch, 'positions', path)
  if (positions instanceof SceneBuildError) return positions
  const normals = readFloat32Array(batch, 'normals', path)
  if (normals instanceof SceneBuildError) return normals
  const indices = nestedField(batch, 'indices')
  if (!(indices instanceof Uint32Array)) {
    return bindInvalid(
      `${path}.indices`,
      `${path}.indices 必须是 Uint32Array，实际为 ${describeValue(indices)}`,
    )
  }
  if (positions.length !== normals.length) {
    return bindInvalid(
      `${path}.positions`,
      `${path} positions 长度 ${positions.length} 与 normals 长度 ${normals.length} 不一致`,
    )
  }
  if (positions.length % 3 !== 0) {
    return bindInvalid(
      `${path}.positions`,
      `${path} positions 长度 ${positions.length} 不是 3 的倍数`,
    )
  }
  const vertexCount = positions.length / 3
  for (let i = 0; i < indices.length; i += 1) {
    if (indices[i] >= vertexCount) {
      return bindInvalid(
        `${path}.indices`,
        `${path} indices[${i}]=${indices[i]} 超出顶点数 ${vertexCount}`,
      )
    }
  }
  return firstNonFiniteError(positions, `${path}.positions`)
    ?? firstNonFiniteError(normals, `${path}.normals`)
}

/** 实例矩阵校验：matrices 长度为 16 倍数且全部有限；成功返回 matrices 供颜色校验复用 */
function validateInstanceMatrices(
  batch: unknown,
  path: string,
): Float32Array | SceneBuildError {
  const matrices = readFloat32Array(batch, 'matrices', path)
  if (matrices instanceof SceneBuildError) return matrices
  if (matrices.length % 16 !== 0) {
    return bindInvalid(
      `${path}.matrices`,
      `${path} matrices 长度 ${matrices.length} 不是 16 的倍数`,
    )
  }
  return firstNonFiniteError(matrices, `${path}.matrices`) ?? matrices
}

/** 实例批次（箭头/节点圆点） */
function validateInstanceBatch(batch: unknown, path: string): SceneBuildError | null {
  const matrices = validateInstanceMatrices(batch, path)
  return matrices instanceof SceneBuildError ? matrices : null
}

/** 带颜色实例批次：colors 数量与实例数一致（每实例 RGB 三分量）且全部有限 */
function validateColoredInstanceBatch(batch: unknown, path: string): SceneBuildError | null {
  const matrices = validateInstanceMatrices(batch, path)
  if (matrices instanceof SceneBuildError) return matrices
  const colors = readFloat32Array(batch, 'colors', path)
  if (colors instanceof SceneBuildError) return colors
  const instanceCount = matrices.length / 16
  if (colors.length !== instanceCount * 3) {
    return bindInvalid(
      `${path}.colors`,
      `${path} colors 长度 ${colors.length} 与实例数 ${instanceCount} 不一致（应为 ${instanceCount * 3}）`,
    )
  }
  return firstNonFiniteError(colors, `${path}.colors`)
}

type BatchValidator = (batch: unknown, path: string) => SceneBuildError | null

/** §5.1 再校验清单：按声明顺序 fail-fast，返回首个错误 */
const BATCH_CHECKS: ReadonlyArray<{
  readonly owner: 'paths' | 'arrows' | 'nodes'
  readonly field: string
  readonly validate: BatchValidator
}> = [
  { owner: 'paths', field: 'forward', validate: validateGeometryBatch },
  { owner: 'paths', field: 'backward', validate: validateGeometryBatch },
  { owner: 'arrows', field: 'forward', validate: validateInstanceBatch },
  { owner: 'arrows', field: 'backward', validate: validateInstanceBatch },
  { owner: 'nodes', field: 'dots', validate: validateInstanceBatch },
  { owner: 'nodes', field: 'rings', validate: validateColoredInstanceBatch },
  { owner: 'nodes', field: 'directions', validate: validateColoredInstanceBatch },
]

function validateSceneModelBatches(model: FactorySceneModel): SceneBuildError | null {
  for (const check of BATCH_CHECKS) {
    const path = `${check.owner}.${check.field}`
    const error = check.validate(nestedField(model, check.owner, check.field), path)
    if (error !== null) return error
  }
  return null
}

// ---------------------------------------------------------------------------
// 绑定（仅在全部校验通过后执行，不产生部分资源）
// ---------------------------------------------------------------------------

/** 路径条带批次 → BufferGeometry（零拷贝：position/normal/index 直接包裹 DTO 数组） */
function bindGeometryBatch(batch: GeometryBatchDto): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(batch.positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(batch.normals, 3))
  geometry.setIndex(new BufferAttribute(batch.indices, 1))
  return geometry
}

function bindInstanceBatch(batch: InstanceBatchDto): BoundInstanceBatch {
  return {
    instanceMatrix: new InstancedBufferAttribute(batch.matrices, 16),
    instanceCount: batch.matrices.length / 16,
  }
}

function bindColoredInstanceBatch(batch: ColoredInstanceBatchDto): BoundColoredInstanceBatch {
  return {
    ...bindInstanceBatch(batch),
    instanceColor: new InstancedBufferAttribute(batch.colors, 3),
  }
}

/**
 * bindFactorySceneModel：再校验 → 绑定（§5.1）。
 * 校验失败返回 { ok: false, error } 且不创建任何 Three 资源；
 * 成功返回 { ok: true, batches }，batches.dispose() 逐一释放全部 geometry/attribute。
 */
export function bindFactorySceneModel(model: FactorySceneModel): BindFactorySceneModelResult {
  const invalid = validateSceneModelBatches(model)
  if (invalid !== null) {
    return { ok: false, error: invalid }
  }

  const pathsForward = bindGeometryBatch(model.paths.forward)
  const pathsBackward = bindGeometryBatch(model.paths.backward)
  const arrowsForward = bindInstanceBatch(model.arrows.forward)
  const arrowsBackward = bindInstanceBatch(model.arrows.backward)
  const dots = bindInstanceBatch(model.nodes.dots)
  const rings = bindColoredInstanceBatch(model.nodes.rings)
  const directions = bindColoredInstanceBatch(model.nodes.directions)

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    pathsForward.dispose()
    pathsBackward.dispose()
    for (const batch of [arrowsForward, arrowsBackward, dots, rings, directions]) {
      batch.instanceMatrix.dispose()
    }
    rings.instanceColor.dispose()
    directions.instanceColor.dispose()
  }

  return {
    ok: true,
    batches: {
      paths: { forward: pathsForward, backward: pathsBackward },
      arrows: { forward: arrowsForward, backward: arrowsBackward },
      nodes: { dots, rings, directions },
      dispose,
    },
  }
}
