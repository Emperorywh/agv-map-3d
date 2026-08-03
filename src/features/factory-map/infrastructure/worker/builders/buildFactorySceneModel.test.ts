import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { isEmptySceneModel } from '../../../application/factorySceneModel'
import type { FactorySceneModel } from '../../../application/factorySceneModel'
import { MapEnvelopeError, MapValidationError, SceneBuildError } from '../../../domain/errors'
import { computeEdgeArcLength } from '../../../domain/invariants'
import { decodeMapEnvelope } from '../../../domain/decodeMapEnvelope'
import {
  PATH_LABEL_NORMAL_OFFSET,
  assertSceneModelTransferable,
  buildFactorySceneModel,
} from './buildFactorySceneModel'
import type { SceneBuildOptions } from './buildFactorySceneModel'

// §13 固定值内联注入（config 层常量；infrastructure 由组合根注入，测试直接给值）
const OPTIONS: SceneBuildOptions = {
  factoryMargin: 10,
  labelAnchorY: 0.5,
  path: {
    pathWidth: 0.12,
    curveMaxError: 0.01,
    curveMaxSegment: 0.25,
    miterLimit: 2,
    chevronSpacing: 6,
    chevronMinPathLength: 1.0,
  },
  nodes: {
    stationColors: { work: '#2196F3', charge: '#8BC34A', park: '#F44336' },
  },
}

function makeEnvelope(nodes: unknown[], edges: unknown[]): unknown {
  return {
    code: 200,
    message: 'ok',
    data: { currentMapInfoVersion: { mapJson: { nodes, edges } } },
  }
}

function nodeJson(
  id: string,
  type: string,
  x: number,
  y: number,
  angle: number | null = null,
): Record<string, unknown> {
  return { id, name: `节点${id}`, type, x, y, angle }
}

function lineJson(
  id: string,
  sx: number, sy: number,
  ex: number, ey: number,
  snodeId: string,
  enodeId: string,
  isBackEdge = false,
): Record<string, unknown> {
  return {
    id, name: `路径${id}`, edgeType: 'LINE',
    sx, sy, ex, ey,
    cx: null, cy: null, dx: null, dy: null,
    isBackEdge, snodeId, enodeId,
  }
}

describe('buildFactorySceneModel 编排（SPEC §5.1、§8.2）', () => {
  it('小地图端到端：批次、stats、bounds（margin 外扩）与标签元数据', () => {
    const payload = makeEnvelope(
      [nodeJson('n1', 'node', 0, 0), nodeJson('n2', 'work', 10, 0, 0)],
      [lineJson('e1', 0, 0, 10, 0, 'n1', 'n2')],
    )
    const model = buildFactorySceneModel(payload, OPTIONS)

    // bounds：bbox [0,10]×[0,0] 四周外扩 10m → 30m × 20m，center (5, 0)
    expect(model.bounds).toEqual({
      innerMinX: -10, innerMaxX: 20, innerMinZ: -10, innerMaxZ: 10, centerX: 5, centerZ: 0,
    })

    // stats：L=10m → n = max(1, floor(10/6)) = 1 个箭头
    expect(model.stats).toEqual({ nodeCount: 2, edgeCount: 1, arrowCount: 1, labelMetadataCount: 3 })

    // 批次：正向条带 4 顶点；反向为空；圆点 1、圆环 1、朝向 1
    expect(model.paths.forward.positions).toHaveLength(12)
    expect(model.paths.backward.positions).toHaveLength(0)
    expect(model.arrows.forward.matrices).toHaveLength(16)
    expect(model.arrows.backward.matrices).toHaveLength(0)
    expect(model.nodes.dots.matrices).toHaveLength(16)
    expect(model.nodes.rings.matrices).toHaveLength(16)
    expect(model.nodes.rings.colors).toHaveLength(3)
    expect(model.nodes.directions.matrices).toHaveLength(16)

    // 标签：id 前缀全局唯一；节点锚点正上方 0.5m；路径锚点 s=0.4L 沿左法线偏移 0.2m
    expect(model.labels).toHaveLength(3)
    expect(model.labels[0]).toEqual({
      id: 'node:n1', category: 'node', text: '节点n1', worldPosition: [0, 0.5, 0],
    })
    expect(model.labels[1]).toEqual({
      id: 'node:n2', category: 'station', text: '节点n2', worldPosition: [10, 0.5, 0],
    })
    // s = 4m 处 (4, 0)，左法线 (0, 1) → 数据 (4, 0.2) → 世界 (4, 0.5, -0.2)
    expect(model.labels[2]).toEqual({
      id: 'edge:e1', category: 'path', text: '路径e1', worldPosition: [4, 0.5, -0.2],
    })
    expect(PATH_LABEL_NORMAL_OFFSET).toBe(0.2)

    expect(isEmptySceneModel(model)).toBe(false)
    // 正常构建恒通过 transfer 前断言
    expect(() => assertSceneModelTransferable(model)).not.toThrow()
  })

  it('空图（nodes/edges 同时为空）：空批次 + bounds 60×40m + stats 全零', () => {
    const model = buildFactorySceneModel(makeEnvelope([], []), OPTIONS)
    expect(model.bounds).toEqual({
      innerMinX: -30, innerMaxX: 30, innerMinZ: -20, innerMaxZ: 20, centerX: 0, centerZ: 0,
    })
    expect(model.paths.forward.positions).toHaveLength(0)
    expect(model.paths.backward.positions).toHaveLength(0)
    expect(model.arrows.forward.matrices).toHaveLength(0)
    expect(model.nodes.dots.matrices).toHaveLength(0)
    expect(model.nodes.rings.matrices).toHaveLength(0)
    expect(model.nodes.directions.matrices).toHaveLength(0)
    expect(model.labels).toHaveLength(0)
    expect(model.stats).toEqual({ nodeCount: 0, edgeCount: 0, arrowCount: 0, labelMetadataCount: 0 })
    expect(isEmptySceneModel(model)).toBe(true)
  })

  it('仅节点无路径：合法 ready 语义，只渲染节点', () => {
    const model = buildFactorySceneModel(makeEnvelope([nodeJson('n1', 'park', 3, 4)], []), OPTIONS)
    expect(model.stats.nodeCount).toBe(1)
    expect(model.stats.edgeCount).toBe(0)
    expect(model.nodes.rings.matrices).toHaveLength(16)
    expect(model.paths.forward.positions).toHaveLength(0)
    expect(model.labels).toHaveLength(1)
    expect(isEmptySceneModel(model)).toBe(false)
  })

  it('领域错误原样透传：非法信封 → MapEnvelopeError；弧长 <0.01m → MapValidationError', () => {
    expect(() => buildFactorySceneModel({ code: 500 }, OPTIONS)).toThrow(MapEnvelopeError)
    const shortEdge = makeEnvelope(
      [nodeJson('n1', 'node', 0, 0), nodeJson('n2', 'node', 0.005, 0)],
      [lineJson('e1', 0, 0, 0.005, 0, 'n1', 'n2')],
    )
    let caught: unknown
    try {
      buildFactorySceneModel(shortEdge, OPTIONS)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(MapValidationError)
    expect((caught as MapValidationError).code).toBe('MAP_PATH_TOO_SHORT')
  })
})

describe('assertSceneModelTransferable（SPEC §5.1 transfer 前断言失败测试）', () => {
  function validModel(): FactorySceneModel {
    return buildFactorySceneModel(
      makeEnvelope(
        [nodeJson('n1', 'node', 0, 0), nodeJson('n2', 'node', 2, 0)],
        [lineJson('e1', 0, 0, 2, 0, 'n1', 'n2')],
      ),
      OPTIONS,
    )
  }

  function expectAssertionFailure(model: FactorySceneModel, reasonPart: string): void {
    let caught: unknown
    try {
      assertSceneModelTransferable(model)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SceneBuildError)
    expect((caught as SceneBuildError).code).toBe('SCENE_MODEL_ASSERTION_FAILED')
    expect((caught as SceneBuildError).message).toContain(reasonPart)
  }

  it('positions/normals 长度不一致 → SceneBuildError', () => {
    const model = validModel()
    expectAssertionFailure(
      {
        ...model,
        paths: {
          ...model.paths,
          forward: { ...model.paths.forward, normals: new Float32Array(3) },
        },
      },
      '不一致',
    )
  })

  it('positions 长度不是 3 的倍数 → SceneBuildError', () => {
    const model = validModel()
    expectAssertionFailure(
      {
        ...model,
        paths: {
          ...model.paths,
          forward: {
            ...model.paths.forward,
            positions: new Float32Array(4),
            normals: new Float32Array(4),
            indices: new Uint32Array(0),
          },
        },
      },
      '3 的倍数',
    )
  })

  it('indices 越界（≥ 顶点数）→ SceneBuildError', () => {
    const model = validModel()
    expectAssertionFailure(
      {
        ...model,
        paths: {
          ...model.paths,
          forward: { ...model.paths.forward, indices: new Uint32Array([0, 1, 999]) },
        },
      },
      '超出顶点数',
    )
  })

  it('positions 含非有限值 → SceneBuildError', () => {
    const model = validModel()
    const corrupted = new Float32Array(model.paths.forward.positions)
    corrupted[5] = Number.NaN
    expectAssertionFailure(
      { ...model, paths: { ...model.paths, forward: { ...model.paths.forward, positions: corrupted } } },
      '有限',
    )
  })

  it('箭头 matrices 长度不是 16 的倍数 → SceneBuildError', () => {
    const model = validModel()
    expectAssertionFailure(
      { ...model, arrows: { ...model.arrows, forward: { matrices: new Float32Array(17) } } },
      '16 的倍数',
    )
  })

  it('圆环 colors 与实例数不一致 → SceneBuildError', () => {
    const model = validModel()
    expectAssertionFailure(
      { ...model, nodes: { ...model.nodes, rings: { matrices: new Float32Array(16), colors: new Float32Array(6) } } },
      '不一致',
    )
  })

  it('朝向 colors 含 Infinity → SceneBuildError', () => {
    const model = validModel()
    expectAssertionFailure(
      {
        ...model,
        nodes: {
          ...model.nodes,
          directions: { matrices: new Float32Array(16), colors: new Float32Array([1, Number.POSITIVE_INFINITY, 0]) },
        },
      },
      '有限',
    )
  })

  it('标签 id 不全局唯一 → SceneBuildError', () => {
    const model = validModel()
    const duplicated = { ...model.labels[0], text: '重复' }
    expectAssertionFailure({ ...model, labels: [model.labels[0], duplicated] }, '全局唯一')
  })
})

describe('buildFactorySceneModel 基准数据（public/map.json，§3.4、VERIFY-003）', () => {
  const url = new URL('../../../../../../public/map.json', import.meta.url)
  const payload: unknown = JSON.parse(readFileSync(url, 'utf8'))

  it('真实基准子集夹具：stats 与夹具一致、全部有限、transfer 断言通过', () => {
    const envelope = payload as {
      data: { currentMapInfoVersion: { mapJson: { nodes: Array<{ id: string }>; edges: Array<{ snodeId: string; enodeId: string }> } } }
    }
    const mapJson = envelope.data.currentMapInfoVersion.mapJson
    const subsetEdges = mapJson.edges.slice(0, 50)
    const referenced = new Set<string>()
    for (const edge of subsetEdges) {
      referenced.add(edge.snodeId)
      referenced.add(edge.enodeId)
    }
    const subsetNodes = mapJson.nodes.filter((node) => referenced.has(node.id))
    const subset = makeEnvelope(subsetNodes, subsetEdges)

    const model = buildFactorySceneModel(subset, OPTIONS)
    expect(model.stats.nodeCount).toBe(subsetNodes.length)
    expect(model.stats.edgeCount).toBe(50)
    expect(model.stats.labelMetadataCount).toBe(subsetNodes.length + 50)
    expect(model.stats.arrowCount).toBeLessThanOrEqual(50 * 3) // L 中位数约 1.44m → 每边至多 1~2 个
    expect(() => assertSceneModelTransferable(model)).not.toThrow()
    for (const v of model.paths.forward.positions) expect(Number.isFinite(v)).toBe(true)
    for (const v of model.paths.backward.positions) expect(Number.isFinite(v)).toBe(true)
  })

  it('完整基准地图：stats 与 §3.4 一致，bounds 内空 187.84m × 95.32m（§6.1）', () => {
    const model = buildFactorySceneModel(payload, OPTIONS)
    expect(model.stats.nodeCount).toBe(1767)
    expect(model.stats.edgeCount).toBe(3043)
    expect(model.stats.labelMetadataCount).toBe(1767 + 3043)

    const innerWidth = model.bounds.innerMaxX - model.bounds.innerMinX
    const innerDepth = model.bounds.innerMaxZ - model.bounds.innerMinZ
    expect(innerWidth).toBeCloseTo(187.84, 2)
    expect(innerDepth).toBeCloseTo(95.32, 2)

    // 箭头密度（§7.2）：基准约 869 条边（28.6%）因 L < 1.0m 无箭头
    // （以 domain 弧长为参照，允许细分折线弧长与其微小偏差导致的边界波动）
    const map = decodeMapEnvelope(payload)
    const noArrowEdges = map.edges.filter((edge) => computeEdgeArcLength(edge) < 1.0).length
    expect(Math.abs(noArrowEdges - 869)).toBeLessThanOrEqual(8)
    const expectedArrowCount = map.edges
      .map((edge) => computeEdgeArcLength(edge))
      .filter((length) => length >= 1.0)
      .reduce((sum, length) => sum + Math.max(1, Math.floor(length / 6)), 0)
    expect(Math.abs(model.stats.arrowCount - expectedArrowCount)).toBeLessThanOrEqual(8)
    expect(model.stats.arrowCount).toBeGreaterThan(2000)

    // 标签 id 全局唯一（断言之外再独立验证一次）
    const ids = new Set(model.labels.map((label) => label.id))
    expect(ids.size).toBe(model.labels.length)

    // 顶点规模非空且有限性由 transfer 断言保证
    expect(model.paths.forward.positions.length).toBeGreaterThan(0)
    expect(model.paths.backward.positions.length).toBeGreaterThan(0)
    expect(model.nodes.dots.matrices.length / 16).toBe(1303)
    expect(model.nodes.rings.matrices.length / 16).toBe(389 + 64 + 11)
    expect(model.nodes.directions.matrices.length / 16).toBe(464)
  })
})
