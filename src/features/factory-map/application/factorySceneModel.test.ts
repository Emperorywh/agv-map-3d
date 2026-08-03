import { describe, expect, it } from 'vitest'

import { deriveFactoryBounds } from '../domain/bounds'
import type { FactorySceneModel, GeometryBatchDto } from './factorySceneModel'
import {
  LABEL_CATEGORIES,
  edgeLabelId,
  isEmptySceneModel,
  nodeLabelId,
  toFactoryBoundsDto,
} from './factorySceneModel'

function makeGeometryBatch(): GeometryBatchDto {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  }
}

function makeSceneModel(nodeCount: number, edgeCount: number): FactorySceneModel {
  return {
    bounds: { innerMinX: -1, innerMaxX: 1, innerMinZ: -2, innerMaxZ: 2, centerX: 0, centerZ: 0 },
    paths: { forward: makeGeometryBatch(), backward: makeGeometryBatch() },
    arrows: {
      forward: { matrices: new Float32Array(16) },
      backward: { matrices: new Float32Array(16) },
    },
    nodes: {
      dots: { matrices: new Float32Array(16) },
      rings: { matrices: new Float32Array(16), colors: new Float32Array([0.1, 0.2, 0.3]) },
      directions: { matrices: new Float32Array(16), colors: new Float32Array([0.4, 0.5, 0.6]) },
    },
    labels: [
      { id: nodeLabelId('n1'), category: 'node', text: 'n1', worldPosition: [1, 0.5, -2] },
    ],
    stats: { nodeCount, edgeCount, arrowCount: 2, labelMetadataCount: 1 },
  }
}

describe('标签契约（SPEC §5.1、§8.2）', () => {
  it('标签类别固定为 station | node | path，顺序即 §8.3 保留名额填充顺序', () => {
    expect([...LABEL_CATEGORIES]).toEqual(['station', 'node', 'path'])
  })

  it('标签 id 固定为 node:<nodeId> / edge:<edgeId>，避免跨集合冲突', () => {
    expect(nodeLabelId('n17')).toBe('node:n17')
    expect(edgeLabelId('e3')).toBe('edge:e3')
    // 同名节点与路径不冲突
    expect(nodeLabelId('x')).not.toBe(edgeLabelId('x'))
  })
})

describe('toFactoryBoundsDto（SPEC §5.1 FactoryBoundsDto / §6.1）', () => {
  it('恰好携带 §5.1 定义的六个字段', () => {
    const dto = toFactoryBoundsDto(
      deriveFactoryBounds({ minX: -5, maxX: 15, minY: -3, maxY: 7 }, 10),
    )
    expect(dto).toEqual({
      innerMinX: -15,
      innerMaxX: 25,
      innerMinZ: -17,
      innerMaxZ: 13,
      centerX: 5,
      centerZ: -2,
    })
  })

  it('空态 bounds 为 60×40m 且居中于原点（§6.1 空场景尺寸）', () => {
    const dto = toFactoryBoundsDto(deriveFactoryBounds(null, 10))
    expect(dto.innerMaxX - dto.innerMinX).toBe(60)
    expect(dto.innerMaxZ - dto.innerMinZ).toBe(40)
    expect(dto.centerX).toBe(0)
    expect(dto.centerZ).toBe(0)
  })
})

describe('isEmptySceneModel（SPEC §11 空态判定）', () => {
  it('nodes 与 edges 同时为空 → empty', () => {
    expect(isEmptySceneModel(makeSceneModel(0, 0))).toBe(true)
  })

  it('nodes 非空、edges 为空是合法 ready，不是 empty（§11）', () => {
    expect(isEmptySceneModel(makeSceneModel(5, 0))).toBe(false)
  })

  it('edges 非空即非空态', () => {
    expect(isEmptySceneModel(makeSceneModel(0, 3))).toBe(false)
    expect(isEmptySceneModel(makeSceneModel(5, 3))).toBe(false)
  })
})

describe('FactorySceneModel 传输契约（SPEC §5.1）', () => {
  it('几何/实例批次使用指定 TypedArray 类型', () => {
    const model = makeSceneModel(2, 1)
    expect(model.paths.forward.positions).toBeInstanceOf(Float32Array)
    expect(model.paths.forward.normals).toBeInstanceOf(Float32Array)
    expect(model.paths.forward.indices).toBeInstanceOf(Uint32Array)
    expect(model.arrows.forward.matrices).toBeInstanceOf(Float32Array)
    expect(model.nodes.rings.colors).toBeInstanceOf(Float32Array)
    expect(model.nodes.directions.colors).toBeInstanceOf(Float32Array)
  })

  it('全部 TypedArray 可按 transfer 语义转移，模型整体可序列化', () => {
    const model = makeSceneModel(2, 1)
    const arrays = [
      model.paths.forward.positions,
      model.paths.forward.normals,
      model.paths.forward.indices,
      model.paths.backward.positions,
      model.paths.backward.normals,
      model.paths.backward.indices,
      model.arrows.forward.matrices,
      model.arrows.backward.matrices,
      model.nodes.dots.matrices,
      model.nodes.rings.matrices,
      model.nodes.rings.colors,
      model.nodes.directions.matrices,
      model.nodes.directions.colors,
    ]
    // transfer 列表为各 TypedArray 的底层 ArrayBuffer（本夹具每个数组独占一个 buffer）
    const buffers = [...new Set(arrays.map((array) => array.buffer as ArrayBuffer))]
    const clone = structuredClone(model, { transfer: buffers })

    for (const array of arrays) {
      expect(array.byteLength).toBe(0) // 原 buffer 所有权已转移
    }
    expect([...clone.paths.forward.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 1])
    expect([...clone.paths.forward.indices]).toEqual([0, 1, 2])
    expect(clone.nodes.rings.colors).toBeInstanceOf(Float32Array)
    expect(clone.labels[0]).toEqual({
      id: 'node:n1',
      category: 'node',
      text: 'n1',
      worldPosition: [1, 0.5, -2],
    })
    expect(clone.stats).toEqual({
      nodeCount: 2,
      edgeCount: 1,
      arrowCount: 2,
      labelMetadataCount: 1,
    })
  })

  it('DTO 全部字段只读（编译期契约，由 tsc 强制；运行时不冻结以兼容 transfer）', () => {
    const model = makeSceneModel(1, 1)
    // @ts-expect-error §5.1：渲染层不得就地修改场景模型
    model.bounds.innerMinX = 0
    // @ts-expect-error TypedArray 引用只读，不可替换
    model.paths.forward.positions = new Float32Array(0)
    // @ts-expect-error labels 为只读数组
    model.labels.push({ id: 'node:x', category: 'node', text: 'x', worldPosition: [0, 0, 0] })
    // @ts-expect-error worldPosition 为只读三元组
    model.labels[0].worldPosition[0] = 9
    // @ts-expect-error stats 字段只读
    model.stats.nodeCount = 99
  })
})
