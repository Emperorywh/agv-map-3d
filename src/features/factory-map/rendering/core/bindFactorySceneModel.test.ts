/**
 * bindFactorySceneModel 单元测试（SPEC §5.1、§15.1 bindFactorySceneModel 行、§10.3）。
 *
 * 覆盖主线程 binder 再校验：长度不匹配、越界 index、NaN/Infinity、
 * 颜色/实例数不一致、非约定 TypedArray、结构缺失；失败返回 SceneBuildError
 * （SCENE_MODEL_BIND_INVALID）且不创建 Three 资源。
 * 合法输入零拷贝绑定为 BufferGeometry/BufferAttribute/InstancedBufferAttribute，
 * dispose 逐一释放且幂等，绑定与释放均不修改场景模型。
 */

import { BufferAttribute, BufferGeometry, InstancedBufferAttribute } from 'three'
import { describe, expect, it, vi } from 'vitest'

import type { FactorySceneModel } from '../../application/factorySceneModel'
import { SceneBuildError } from '../../domain/errors'
import { bindFactorySceneModel } from './bindFactorySceneModel'
import type { BoundSceneBatches } from './bindFactorySceneModel'

/** 合法模型：forward 路径 1 三角形、1 箭头实例、2 圆点、1 圆环；backward/directions 为空批次 */
function makeValidModel(): FactorySceneModel {
  return {
    bounds: {
      innerMinX: -30,
      innerMaxX: 30,
      innerMinZ: -20,
      innerMaxZ: 20,
      centerX: 0,
      centerZ: 0,
    },
    paths: {
      forward: {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
        normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
      },
      backward: {
        positions: new Float32Array(0),
        normals: new Float32Array(0),
        indices: new Uint32Array(0),
      },
    },
    arrows: {
      forward: { matrices: new Float32Array(16) },
      backward: { matrices: new Float32Array(0) },
    },
    nodes: {
      dots: { matrices: new Float32Array(32) },
      rings: { matrices: new Float32Array(16), colors: new Float32Array([1, 0, 0]) },
      directions: { matrices: new Float32Array(0), colors: new Float32Array(0) },
    },
    labels: [],
    stats: { nodeCount: 2, edgeCount: 1, arrowCount: 1, labelMetadataCount: 3 },
  }
}

/** 以写视角访问只读 DTO（模拟跨线程不可信数据注入；运行时 DTO 并不冻结） */
function writable(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

/** 在合法模型上注入非法值，返回绕过类型系统的不可信模型 */
function corruptModel(corrupt: (model: FactorySceneModel) => void): FactorySceneModel {
  const model = makeValidModel()
  corrupt(model)
  return model
}

function expectBindFailure(model: FactorySceneModel, fieldPath: string, summaryPart: string): void {
  const result = bindFactorySceneModel(model)
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.error).toBeInstanceOf(SceneBuildError)
  expect(result.error.code).toBe('SCENE_MODEL_BIND_INVALID')
  expect(result.error.fieldPath).toBe(fieldPath)
  expect(result.error.message).toContain(summaryPart)
}

describe('bindFactorySceneModel 再校验（§5.1、§15.1）', () => {
  it('positions/normals 长度不匹配 → SceneBuildError', () => {
    const model = corruptModel((m) => {
      writable(m.paths.forward).normals = new Float32Array(6)
    })
    expectBindFailure(model, 'paths.forward.positions', '不一致')
  })

  it('positions 长度不是 3 的倍数 → SceneBuildError', () => {
    const model = corruptModel((m) => {
      writable(m.paths.forward).positions = new Float32Array(4)
      writable(m.paths.forward).normals = new Float32Array(4)
    })
    expectBindFailure(model, 'paths.forward.positions', '不是 3 的倍数')
  })

  it('index 等于顶点数（边界越界）→ SceneBuildError', () => {
    const model = corruptModel((m) => {
      writable(m.paths.forward).indices = new Uint32Array([0, 1, 3])
    })
    expectBindFailure(model, 'paths.forward.indices', '超出顶点数 3')
  })

  it('index 远大于顶点数 → SceneBuildError', () => {
    const model = corruptModel((m) => {
      writable(m.paths).backward = {
        positions: new Float32Array(6),
        normals: new Float32Array(6),
        indices: new Uint32Array([0, 1, 999]),
      }
    })
    expectBindFailure(model, 'paths.backward.indices', '超出顶点数 2')
  })

  it('matrices 长度不是 16 的倍数 → SceneBuildError', () => {
    const model = corruptModel((m) => {
      writable(m.arrows).forward = { matrices: new Float32Array(8) }
    })
    expectBindFailure(model, 'arrows.forward.matrices', '不是 16 的倍数')
  })

  it('colors 数量与实例数不一致 → SceneBuildError', () => {
    const model = corruptModel((m) => {
      writable(m.nodes).rings = { matrices: new Float32Array(16), colors: new Float32Array(6) }
    })
    expectBindFailure(model, 'nodes.rings.colors', '与实例数 1 不一致')
  })

  it('带颜色批次的 matrices 不是 16 的倍数 → SceneBuildError（颜色校验前拦截）', () => {
    const model = corruptModel((m) => {
      writable(m.nodes).rings = { matrices: new Float32Array(8), colors: new Float32Array(0) }
    })
    expectBindFailure(model, 'nodes.rings.matrices', '不是 16 的倍数')
  })

  it.each([
    ['positions 含 NaN', (m: FactorySceneModel) => {
      writable(m.paths.forward).positions = new Float32Array([0, 0, 0, Number.NaN, 0, 0, 0, 0, 1])
    }, 'paths.forward.positions', '不是有限数值（NaN）'],
    ['normals 含 Infinity', (m: FactorySceneModel) => {
      writable(m.paths.forward).normals = new Float32Array([0, 1, 0, 0, Number.POSITIVE_INFINITY, 0, 0, 1, 0])
    }, 'paths.forward.normals', '不是有限数值（Infinity）'],
    ['matrices 含 NaN', (m: FactorySceneModel) => {
      writable(m.nodes).dots = { matrices: new Float32Array(32).fill(Number.NaN, 17, 18) }
    }, 'nodes.dots.matrices', '不是有限数值（NaN）'],
    ['colors 含 -Infinity', (m: FactorySceneModel) => {
      writable(m.nodes).rings = {
        matrices: new Float32Array(16),
        colors: new Float32Array([1, Number.NEGATIVE_INFINITY, 0]),
      }
    }, 'nodes.rings.colors', '不是有限数值（-Infinity）'],
  ])('%s → SceneBuildError', (_label, corrupt, fieldPath, summaryPart) => {
    expectBindFailure(corruptModel(corrupt), fieldPath, summaryPart)
  })

  it.each([
    ['positions 为普通数组', (m: FactorySceneModel) => {
      writable(m.paths).forward = {
        positions: [0, 0, 0],
        normals: new Float32Array(3),
        indices: new Uint32Array(0),
      }
    }, 'paths.forward.positions', '必须是 Float32Array'],
    ['normals 为普通数组', (m: FactorySceneModel) => {
      writable(m.paths).forward = {
        positions: new Float32Array(3),
        normals: [0, 1, 0],
        indices: new Uint32Array(0),
      }
    }, 'paths.forward.normals', '必须是 Float32Array'],
    ['indices 为 Uint16Array', (m: FactorySceneModel) => {
      writable(m.paths).forward = {
        positions: new Float32Array(3),
        normals: new Float32Array(3),
        indices: new Uint16Array(0),
      }
    }, 'paths.forward.indices', '必须是 Uint32Array'],
    ['matrices 为普通数组', (m: FactorySceneModel) => {
      writable(m.arrows).forward = { matrices: new Array(16).fill(0) }
    }, 'arrows.forward.matrices', '必须是 Float32Array'],
    ['colors 为普通数组', (m: FactorySceneModel) => {
      writable(m.nodes).rings = {
        matrices: new Float32Array(16),
        colors: [1, 0, 0],
      }
    }, 'nodes.rings.colors', '必须是 Float32Array'],
  ])('非约定 TypedArray（%s）→ SceneBuildError', (_label, corrupt, fieldPath, summaryPart) => {
    expectBindFailure(corruptModel(corrupt), fieldPath, summaryPart)
  })

  it.each([
    ['model 无任何批次字段', {}],
    ['paths 为 null', { paths: null }],
    ['paths 为非对象', { paths: 42 }],
    ['paths.forward 为 null', { paths: { forward: null } }],
  ])('结构缺失（%s）→ SceneBuildError 而非 TypeError', (_label, garbage) => {
    expectBindFailure(
      garbage as unknown as FactorySceneModel,
      'paths.forward.positions',
      '必须是 Float32Array',
    )
  })

  it('fail-fast：多处非法时返回按 §5.1 清单顺序的首个错误', () => {
    const model = corruptModel((m) => {
      writable(m.paths).backward = {
        positions: new Float32Array(3),
        normals: new Float32Array(6),
        indices: new Uint32Array(0),
      }
      writable(m.nodes).rings = { matrices: new Float32Array(16), colors: new Float32Array(99) }
    })
    expectBindFailure(model, 'paths.backward.positions', '不一致')
  })
})

describe('bindFactorySceneModel 合法绑定（§5.1）', () => {
  it('路径批次零拷贝绑定为 BufferGeometry（position/normal/index）', () => {
    const model = makeValidModel()
    const result = bindFactorySceneModel(model)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const geometry = result.batches.paths.forward
    expect(geometry).toBeInstanceOf(BufferGeometry)
    const position = geometry.getAttribute('position') as BufferAttribute
    expect(position).toBeInstanceOf(BufferAttribute)
    expect(position.array).toBe(model.paths.forward.positions) // 零拷贝：同一 buffer
    expect(position.itemSize).toBe(3)
    const normal = geometry.getAttribute('normal') as BufferAttribute
    expect(normal).toBeInstanceOf(BufferAttribute)
    expect(normal.array).toBe(model.paths.forward.normals)
    expect(normal.itemSize).toBe(3)
    const index = geometry.getIndex()
    expect(index).toBeInstanceOf(BufferAttribute)
    expect(index?.array).toBe(model.paths.forward.indices)
    expect(index?.itemSize).toBe(1)
  })

  it('实例批次绑定为 InstancedBufferAttribute（itemSize 16/3）且实例数正确', () => {
    const model = makeValidModel()
    const result = bindFactorySceneModel(model)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const arrowsForward = result.batches.arrows.forward
    expect(arrowsForward.instanceMatrix).toBeInstanceOf(InstancedBufferAttribute)
    expect(arrowsForward.instanceMatrix.itemSize).toBe(16)
    expect(arrowsForward.instanceMatrix.array).toBe(model.arrows.forward.matrices)
    expect(arrowsForward.instanceCount).toBe(1)

    expect(result.batches.nodes.dots.instanceCount).toBe(2)
    expect(result.batches.nodes.dots.instanceMatrix.array).toBe(model.nodes.dots.matrices)

    const rings = result.batches.nodes.rings
    expect(rings.instanceColor).toBeInstanceOf(InstancedBufferAttribute)
    expect(rings.instanceColor.itemSize).toBe(3)
    expect(rings.instanceColor.array).toBe(model.nodes.rings.colors)
    expect(rings.instanceCount).toBe(1)
  })

  it('空批次（空态场景）是合法输入：绑定为空 geometry 与 0 实例', () => {
    const model = makeValidModel()
    const result = bindFactorySceneModel(model)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const backward = result.batches.paths.backward
    expect(backward.getAttribute('position').count).toBe(0)
    expect(backward.getIndex()?.count).toBe(0)
    expect(result.batches.arrows.backward.instanceCount).toBe(0)
    expect(result.batches.nodes.directions.instanceCount).toBe(0)
    expect(result.batches.nodes.directions.instanceColor.count).toBe(0)
  })
})

describe('BoundSceneBatches.dispose（§10.3）', () => {
  function collectResources(batches: BoundSceneBatches) {
    return [
      batches.paths.forward,
      batches.paths.backward,
      batches.arrows.forward.instanceMatrix,
      batches.arrows.backward.instanceMatrix,
      batches.nodes.dots.instanceMatrix,
      batches.nodes.rings.instanceMatrix,
      batches.nodes.rings.instanceColor,
      batches.nodes.directions.instanceMatrix,
      batches.nodes.directions.instanceColor,
    ]
  }

  it('逐一 dispose 全部 geometry 与实例 attribute', () => {
    const result = bindFactorySceneModel(makeValidModel())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const spies = collectResources(result.batches).map((resource) => {
      const spy = vi.fn()
      resource.addEventListener('dispose', spy)
      return spy
    })

    result.batches.dispose()
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledTimes(1)
    }
  })

  it('dispose 幂等：重复调用不重复释放', () => {
    const result = bindFactorySceneModel(makeValidModel())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const spies = collectResources(result.batches).map((resource) => {
      const spy = vi.fn()
      resource.addEventListener('dispose', spy)
      return spy
    })

    result.batches.dispose()
    result.batches.dispose()
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledTimes(1)
    }
  })

  it('绑定与 dispose 均不修改场景模型（渲染层只读，§5.1）', () => {
    const model = makeValidModel()
    const snapshot = {
      positions: Array.from(model.paths.forward.positions),
      normals: Array.from(model.paths.forward.normals),
      indices: Array.from(model.paths.forward.indices),
      matrices: Array.from(model.arrows.forward.matrices),
      colors: Array.from(model.nodes.rings.colors),
    }
    const result = bindFactorySceneModel(model)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    result.batches.dispose()

    expect(Array.from(model.paths.forward.positions)).toEqual(snapshot.positions)
    expect(Array.from(model.paths.forward.normals)).toEqual(snapshot.normals)
    expect(Array.from(model.paths.forward.indices)).toEqual(snapshot.indices)
    expect(Array.from(model.arrows.forward.matrices)).toEqual(snapshot.matrices)
    expect(Array.from(model.nodes.rings.colors)).toEqual(snapshot.colors)
  })
})
