/**
 * MapSceneResources 单元测试（SPEC §7、§10.3、§4.3、§6.6、§11）。
 *
 * node 环境直接验证资源装配与生命周期（无 WebGL/DOM 依赖）：
 * - 快照结构：§7.5 的 7 个绘制批次（路径 Mesh×2 + InstancedMesh×5）；
 *   绑定零拷贝（attribute.array 与 SceneModel DTO 数组同一引用）；
 * - 材质：roughness 0.8、颜色全部来自 visualTheme、rings/directions 默认白 +
 *   instanceColor 且 vertexColors 关闭（§7.3）；§4.3 逐层 polygonOffset；
 * - 阴影：地图元素 receiveShadow=true、castShadow=false（§6.6 注记）；
 * - 生命周期（§10.3）：SceneModel 替换/卸载逐一 dispose（geometry/实例
 *   buffer/材质），dispose 幂等且可重新 setup（StrictMode 安全）；
 * - 形态（§11）：ready 全量、仅节点（edges 空）与真实基准 map.json 全量加载。
 *
 * 模型夹具经 infrastructure 的 buildFactorySceneModel 真实构建（测试不参与
 * 架构方向检查；§13 固定值内联注入）。
 */

import { readFileSync } from 'node:fs'

import { InstancedMesh, Mesh, MeshStandardMaterial } from 'three'
import { describe, expect, it } from 'vitest'

import type { FactorySceneModel } from '../../application/factorySceneModel'
import { ENV_MAP_INTENSITY } from '../../config/qualityProfile'
import {
  CHEVRON_BACKWARD_COLOR,
  CHEVRON_FORWARD_COLOR,
  NODE_DOT_COLOR,
  PATH_BACKWARD_COLOR,
  PATH_FORWARD_COLOR,
} from '../../config/visualTheme'
import { SceneBuildError } from '../../domain/errors'
import { buildFactorySceneModel } from '../../infrastructure/worker/builders/buildFactorySceneModel'
import type { SceneBuildOptions } from '../../infrastructure/worker/builders/buildFactorySceneModel'
import { createMapSceneResources } from './MapSceneResources'
import type { MapSceneSnapshot } from './MapSceneResources'

// §13 固定值内联注入（与组合根 BROWSER_SCENE_BUILD_OPTIONS 一致）
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

/** 小地图：2 普通节点 + 2 站点（1 带朝向）+ 1 正向 1 反向边（均 ≥1m，有箭头） */
function makeSmallModel(): FactorySceneModel {
  return buildFactorySceneModel(
    makeEnvelope(
      [
        nodeJson('n1', 'node', 0, 0),
        nodeJson('n2', 'node', 4, 0),
        nodeJson('w1', 'work', 1, 1, Math.PI / 2),
        nodeJson('p1', 'park', 2, 2),
      ],
      [
        lineJson('e1', 0, 0, 4, 0, 'n1', 'n2'),
        lineJson('e2', 4, 0, 0, 0, 'n2', 'n1', true),
      ],
    ),
    OPTIONS,
  )
}

function materialOf(mesh: Mesh | InstancedMesh): MeshStandardMaterial {
  return mesh.material as MeshStandardMaterial
}

function meshesOf(snapshot: MapSceneSnapshot): Array<Mesh | InstancedMesh> {
  return [
    snapshot.pathForwardMesh,
    snapshot.pathBackwardMesh,
    snapshot.arrowForwardMesh,
    snapshot.arrowBackwardMesh,
    snapshot.nodeDotMesh,
    snapshot.stationRingMesh,
    snapshot.stationDirectionMesh,
  ]
}

/** 快照全部可释放资源：2 路径 geometry + 5 实例矩阵 + 2 实例颜色 + 4 局部 geometry + 7 材质 */
function disposablesOf(snapshot: MapSceneSnapshot): Array<{ dispose(): void }> {
  return [
    snapshot.pathForwardMesh.geometry,
    snapshot.pathBackwardMesh.geometry,
    snapshot.arrowForwardMesh.instanceMatrix,
    snapshot.arrowBackwardMesh.instanceMatrix,
    snapshot.nodeDotMesh.instanceMatrix,
    snapshot.stationRingMesh.instanceMatrix,
    snapshot.stationDirectionMesh.instanceMatrix,
    snapshot.stationRingMesh.instanceColor as NonNullable<InstancedMesh['instanceColor']>,
    snapshot.stationDirectionMesh.instanceColor as NonNullable<InstancedMesh['instanceColor']>,
    snapshot.arrowForwardMesh.geometry, // 正/反向箭头共享同一 chevron geometry
    snapshot.nodeDotMesh.geometry,
    snapshot.stationRingMesh.geometry,
    snapshot.stationDirectionMesh.geometry,
    ...meshesOf(snapshot).map((mesh) => materialOf(mesh)),
  ]
}

/** 包装 dispose 计数（逐一释放验证） */
function trackDispose(target: { dispose(): void }, tracker: { count: number }): void {
  const original = target.dispose.bind(target)
  target.dispose = () => {
    tracker.count += 1
    original()
  }
}

describe('MapSceneResources 快照结构（§7.5、§5.1 零拷贝、§6.6）', () => {
  const resources = createMapSceneResources()
  const model = makeSmallModel()
  const result = resources.setup(model)
  if (!result.ok) throw new Error('小地图 setup 应成功')
  const snapshot = result.snapshot

  it('7 个绘制批次：路径 Mesh×2 + 箭头/圆点/圆环/朝向符号 InstancedMesh×5', () => {
    expect(snapshot.pathForwardMesh).toBeInstanceOf(Mesh)
    expect(snapshot.pathBackwardMesh).toBeInstanceOf(Mesh)
    expect(snapshot.pathForwardMesh).not.toBeInstanceOf(InstancedMesh)
    for (const mesh of [
      snapshot.arrowForwardMesh,
      snapshot.arrowBackwardMesh,
      snapshot.nodeDotMesh,
      snapshot.stationRingMesh,
      snapshot.stationDirectionMesh,
    ]) {
      expect(mesh).toBeInstanceOf(InstancedMesh)
    }
    expect(meshesOf(snapshot)).toHaveLength(7)
  })

  it('零拷贝绑定：attribute.array 与 SceneModel DTO 数组同一引用（§5.1）', () => {
    expect(snapshot.pathForwardMesh.geometry.getAttribute('position').array)
      .toBe(model.paths.forward.positions)
    expect(snapshot.pathBackwardMesh.geometry.index?.array).toBe(model.paths.backward.indices)
    expect(snapshot.arrowForwardMesh.instanceMatrix.array).toBe(model.arrows.forward.matrices)
    expect(snapshot.nodeDotMesh.instanceMatrix.array).toBe(model.nodes.dots.matrices)
    expect(snapshot.stationRingMesh.instanceColor?.array).toBe(model.nodes.rings.colors)
    expect(snapshot.stationDirectionMesh.instanceColor?.array).toBe(model.nodes.directions.colors)
  })

  it('实例数与批次矩阵一致；正/反向箭头共享同一 chevron geometry', () => {
    expect(snapshot.arrowForwardMesh.count).toBe(model.arrows.forward.matrices.length / 16)
    expect(snapshot.arrowBackwardMesh.count).toBe(model.arrows.backward.matrices.length / 16)
    expect(snapshot.nodeDotMesh.count).toBe(model.nodes.dots.matrices.length / 16)
    expect(snapshot.stationRingMesh.count).toBe(model.nodes.rings.matrices.length / 16)
    expect(snapshot.stationDirectionMesh.count).toBe(model.nodes.directions.matrices.length / 16)
    expect(snapshot.arrowForwardMesh.geometry).toBe(snapshot.arrowBackwardMesh.geometry)
    expect(snapshot.arrowForwardMesh.count).toBeGreaterThan(0)
    expect(snapshot.arrowBackwardMesh.count).toBeGreaterThan(0)
  })

  it('instanceColor 只挂在 rings/directions（§7.3/§7.4）', () => {
    expect(snapshot.stationRingMesh.instanceColor).not.toBeNull()
    expect(snapshot.stationDirectionMesh.instanceColor).not.toBeNull()
    expect(snapshot.arrowForwardMesh.instanceColor).toBeNull()
    expect(snapshot.arrowBackwardMesh.instanceColor).toBeNull()
    expect(snapshot.nodeDotMesh.instanceColor).toBeNull()
  })

  it('地图元素 receiveShadow=true、castShadow=false（§6.6 注记）', () => {
    for (const mesh of meshesOf(snapshot)) {
      expect(mesh.receiveShadow).toBe(true)
      expect(mesh.castShadow).toBe(false)
    }
  })

  it('小地图实例计数：圆点 2、圆环 2、朝向符号 1（angle=null 不生成）', () => {
    expect(snapshot.nodeDotMesh.count).toBe(2)
    expect(snapshot.stationRingMesh.count).toBe(2)
    expect(snapshot.stationDirectionMesh.count).toBe(1)
  })
})

describe('MapSceneResources 材质（§7.1、§7.3、§4.3）', () => {
  const resources = createMapSceneResources()
  const result = resources.setup(makeSmallModel())
  if (!result.ok) throw new Error('小地图 setup 应成功')
  const snapshot = result.snapshot

  it('全部 MeshStandardMaterial：roughness 0.8、envMapIntensity 固定值、vertexColors 关闭', () => {
    for (const mesh of meshesOf(snapshot)) {
      const material = materialOf(mesh)
      expect(material).toBeInstanceOf(MeshStandardMaterial)
      expect(material.roughness).toBe(0.8)
      expect(material.envMapIntensity).toBe(ENV_MAP_INTENSITY)
      expect(material.vertexColors).toBe(false)
    }
  })

  it('颜色全部来自 visualTheme（§7.1/§7.2/§7.3）；rings/directions 默认白（instanceColor 独立生效）', () => {
    const hexOf = (mesh: Mesh | InstancedMesh): string => materialOf(mesh).color.getHexString()
    expect(hexOf(snapshot.pathForwardMesh)).toBe(PATH_FORWARD_COLOR.slice(1).toLowerCase())
    expect(hexOf(snapshot.pathBackwardMesh)).toBe(PATH_BACKWARD_COLOR.slice(1).toLowerCase())
    expect(hexOf(snapshot.arrowForwardMesh)).toBe(CHEVRON_FORWARD_COLOR.slice(1).toLowerCase())
    expect(hexOf(snapshot.arrowBackwardMesh)).toBe(CHEVRON_BACKWARD_COLOR.slice(1).toLowerCase())
    expect(hexOf(snapshot.nodeDotMesh)).toBe(NODE_DOT_COLOR.slice(1).toLowerCase())
    expect(hexOf(snapshot.stationRingMesh)).toBe('ffffff')
    expect(hexOf(snapshot.stationDirectionMesh)).toBe('ffffff')
  })

  it('§4.3 逐层 polygonOffset：polygonOffset=true / factor=-1 / units 按表', () => {
    const expected: Array<[Mesh | InstancedMesh, number]> = [
      [snapshot.pathForwardMesh, -2],
      [snapshot.arrowForwardMesh, -3],
      [snapshot.pathBackwardMesh, -4],
      [snapshot.arrowBackwardMesh, -5],
      [snapshot.nodeDotMesh, -6],
      [snapshot.stationRingMesh, -7],
      [snapshot.stationDirectionMesh, -8],
    ]
    for (const [mesh, units] of expected) {
      const material = materialOf(mesh)
      expect(material.polygonOffset).toBe(true)
      expect(material.polygonOffsetFactor).toBe(-1)
      expect(material.polygonOffsetUnits).toBe(units)
    }
  })
})

describe('MapSceneResources 生命周期（§10.3）', () => {
  it('dispose 逐一释放全部资源且幂等；之后可重新 setup（StrictMode 安全）', () => {
    const resources = createMapSceneResources()
    const result = resources.setup(makeSmallModel())
    if (!result.ok) throw new Error('setup 应成功')
    const tracker = { count: 0 }
    const disposables = disposablesOf(result.snapshot)
    expect(disposables).toHaveLength(20)
    for (const disposable of disposables) trackDispose(disposable, tracker)

    resources.dispose()
    expect(tracker.count).toBe(20)
    expect(resources.current).toBeNull()

    resources.dispose()
    expect(tracker.count).toBe(20) // 幂等：不重复释放

    const again = resources.setup(makeSmallModel())
    expect(again.ok).toBe(true)
    expect(resources.current).not.toBeNull()
  })

  it('SceneModel 替换：再次 setup 先逐一释放旧快照（不保留旧资源）', () => {
    const resources = createMapSceneResources()
    const first = resources.setup(makeSmallModel())
    if (!first.ok) throw new Error('首次 setup 应成功')
    const tracker = { count: 0 }
    for (const disposable of disposablesOf(first.snapshot)) trackDispose(disposable, tracker)

    const second = resources.setup(makeSmallModel())
    expect(second.ok).toBe(true)
    expect(tracker.count).toBe(20)
    if (second.ok) {
      expect(second.snapshot.pathForwardMesh).not.toBe(first.snapshot.pathForwardMesh)
    }
    expect(resources.current).toBe(second.ok ? second.snapshot : null)
    resources.dispose()
  })

  it('绑定校验失败：返回 SceneBuildError 且不创建任何资源；后续合法 setup 仍可用', () => {
    const valid = makeSmallModel()
    const broken: FactorySceneModel = {
      ...valid,
      paths: {
        forward: {
          positions: new Float32Array(9),
          normals: new Float32Array(9),
          indices: new Uint32Array([0, 1, 99]), // 越界 index → SCENE_MODEL_BIND_INVALID
        },
        backward: valid.paths.backward,
      },
    }
    const resources = createMapSceneResources()
    const result = resources.setup(broken)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SceneBuildError)
      expect(result.error.code).toBe('SCENE_MODEL_BIND_INVALID')
    }
    expect(resources.current).toBeNull()

    const recovered = resources.setup(makeSmallModel())
    expect(recovered.ok).toBe(true)
    resources.dispose()
  })
})

describe('MapSceneResources 形态（§11）', () => {
  it('仅节点（edges 空）：合法 ready 形态——路径/箭头批次为空，节点批次正常', () => {
    const model = buildFactorySceneModel(
      makeEnvelope([nodeJson('n1', 'node', 0, 0), nodeJson('w1', 'charge', 3, 4, 0)], []),
      OPTIONS,
    )
    const resources = createMapSceneResources()
    const result = resources.setup(model)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { snapshot } = result
    expect(snapshot.pathForwardMesh.geometry.index?.count).toBe(0)
    expect(snapshot.pathBackwardMesh.geometry.index?.count).toBe(0)
    expect(snapshot.arrowForwardMesh.count).toBe(0)
    expect(snapshot.arrowBackwardMesh.count).toBe(0)
    expect(snapshot.nodeDotMesh.count).toBe(1)
    expect(snapshot.stationRingMesh.count).toBe(1)
    expect(snapshot.stationDirectionMesh.count).toBe(1)
    resources.dispose()
  })

  it('空态模型（nodes/edges 同时为空）：全部批次为空仍可 setup', () => {
    const model = buildFactorySceneModel(makeEnvelope([], []), OPTIONS)
    const resources = createMapSceneResources()
    const result = resources.setup(model)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot.nodeDotMesh.count).toBe(0)
    expect(result.snapshot.stationRingMesh.count).toBe(0)
    expect(result.snapshot.stationDirectionMesh.count).toBe(0)
    resources.dispose()
  })
})

describe('MapSceneResources 基准数据（public/map.json 全量，§3.4）', () => {
  it('1767 节点 / 3043 边全量加载：全部批次绑定成功，计数与模型一致', () => {
    const url = new URL('../../../../../public/map.json', import.meta.url)
    const payload: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const model = buildFactorySceneModel(payload, OPTIONS)
    expect(model.stats.nodeCount).toBe(1767)
    expect(model.stats.edgeCount).toBe(3043)

    const resources = createMapSceneResources()
    const result = resources.setup(model)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { snapshot } = result
    expect(snapshot.nodeDotMesh.count).toBe(1303) // §3.4：普通节点 1303
    expect(snapshot.stationRingMesh.count).toBe(464) // §3.4：work 389 + park 64 + charge 11
    expect(snapshot.stationRingMesh.count + snapshot.nodeDotMesh.count).toBe(1767)
    expect(snapshot.arrowForwardMesh.count + snapshot.arrowBackwardMesh.count)
      .toBe(model.stats.arrowCount)
    expect(snapshot.stationDirectionMesh.count).toBe(model.nodes.directions.matrices.length / 16)
    expect(snapshot.pathForwardMesh.geometry.index?.count).toBeGreaterThan(0)
    expect(snapshot.pathBackwardMesh.geometry.index?.count).toBeGreaterThan(0) // §3.4：反向 878 条
    resources.dispose()
  })
})
