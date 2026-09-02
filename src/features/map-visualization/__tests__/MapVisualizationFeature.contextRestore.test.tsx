/*
 * MapVisualizationFeature 上下文恢复重建测试（TASK-016；SPEC §7.4、§11.9）。
 *
 * 职责：验证资源代驱动的恢复重建合同——contextGeneration 递增时五个地图图
 *       层整体卸载/重建（先释放旧 GPU 对象再挂载新对象）且环境工厂随后重建
 *       （恢复顺序：地图 → 环境）；恢复期环境工厂失败上抛 onContextRecreateFailed
 *       并降级为无 IBL；初始挂载（资源代 0）的环境失败沿用既有降级、不计入
 *       恢复失败。图层以记录挂载/卸载轨迹的替身组件替换，保证顺序断言确定。
 */
import { act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ReactThreeTestRenderer from '@react-three/test-renderer'
import * as THREE from 'three'
import { useEffect } from 'react'
import { createDiagnosticsReporter, type DiagnosticRecord } from '@/shared/diagnostics'
import { IDENTITY_AFFINE } from '@/shared/spatial'
import { createMapModel } from '../model/createMapModel'
import { validateMap } from '../model/validateMap'
import type { MapViewDescriptor } from '../hooks/useMapVisualization'
import type { MapNameAtlasFactory } from '../hooks/useMapNameAtlas'
import { makeGroup, makeLineEdge, makeNode } from './fixtures'
import { MapVisualizationFeature } from '../components/MapVisualizationFeature'

/** 图层挂载/卸载轨迹（vi.hoisted：vi.mock 工厂内可引用） */
const layerTrace = vi.hoisted(() => ({
  events: [] as string[],
}))

/** 生成记录挂载/卸载轨迹的图层替身（不创建任何 GPU 对象）。
 *  挂载记录在 effect 阶段（与真实图层的对象挂载同相），卸载记录在清理阶段
 *  ——轨迹如实反映提交中「先释放全部旧资源、再挂载新资源」的顺序。 */
function layerMock(name: string): () => null {
  return () => {
    useEffect(() => {
      layerTrace.events.push(`mount:${name}`)
      return () => {
        layerTrace.events.push(`cleanup:${name}`)
      }
    }, [])
    return null
  }
}

vi.mock('../components/GroundLayer', () => ({ GroundLayer: layerMock('ground') }))
vi.mock('../components/PhysicalPathsLayer', () => ({ PhysicalPathsLayer: layerMock('paths') }))
vi.mock('../components/NodesLayer', () => ({ NodesLayer: layerMock('nodes') }))
vi.mock('../components/LandmarksLayer', () => ({ LandmarksLayer: layerMock('landmarks') }))
vi.mock('../components/ExclusiveGroupsLayer', () => ({
  ExclusiveGroupsLayer: layerMock('exclusive'),
}))

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

/** 夹具地图：work a、charge b + 一条边 + 一个独占区（种子直供首次建模） */
function makeDescriptor(): MapViewDescriptor {
  const { mapModel, worldTransform } = createMapModel(
    validateMap({
      nodes: [
        makeNode({ id: 'a', name: 'A', x: 0, y: 0 }),
        makeNode({ id: 'b', name: 'B', type: 'charge', x: 3, y: 4 }),
      ],
      edges: [makeLineEdge({ id: 'e1', snodeId: 'a', enodeId: 'b' })],
      zones: [],
      nodeEdgeGroups: [
        makeGroup({ id: 'g1', name: '独占区1', nodeIds: ['a', 'b'], edgeIds: ['e1'] }),
      ],
    }),
  )
  return {
    mapUrl: 'http://t/map.json',
    coordinateTransform: IDENTITY_AFFINE,
    initial: { mapModel, worldTransform },
  }
}

/** 环境工厂替身：可控成败，重建/释放记入与图层同一条轨迹时间线 */
function makeEnvStub() {
  let mode: 'fail' | 'succeed' = 'fail'
  const textures: THREE.Texture[] = []
  const dispose = vi.fn(() => {
    layerTrace.events.push('cleanup:env')
  })
  const factory = vi.fn(() => {
    layerTrace.events.push('mount:env')
    if (mode === 'fail') {
      throw new Error('环境工厂注入失败')
    }
    const texture = new THREE.Texture()
    textures.push(texture)
    return { texture, dispose }
  })
  return {
    factory,
    textures,
    dispose,
    fail(): void {
      mode = 'fail'
    },
    succeed(): void {
      mode = 'succeed'
    },
  }
}

/** 名称图集工厂替身：避免真实 Canvas 2D 依赖 */
function makeAtlasStub() {
  const texture = new THREE.Texture()
  const factory = vi.fn((specs: readonly { key: string }[]) => ({
    texture,
    cells: new Map(
      specs.map((spec, index) => [
        spec.key,
        { x: 0, y: index * 8, w: 32, h: 8, u0: 0, v0: 0, u1: 1, v1: 1 },
      ]),
    ),
    width: 64,
    height: 64,
    fontPx: 8,
    droppedKeys: [] as readonly string[],
    dispose: vi.fn(),
  })) as unknown as MapNameAtlasFactory
  return { factory }
}

describe('MapVisualizationFeature 上下文恢复重建（TASK-016）', () => {
  it('资源代递增：五个图层先整体释放旧对象再按 地图→环境 顺序重建，环境工厂重跑且旧环境释放一次', async () => {
    const env = makeEnvStub()
    env.succeed()
    const atlas = makeAtlasStub()
    const renderer = await ReactThreeTestRenderer.create(
      <MapVisualizationFeature
        map={makeDescriptor()}
        environmentFactory={env.factory}
        nameAtlasFactory={atlas.factory}
        contextGeneration={0}
      />,
    )
    try {
      await flush()
      const initialScene = toThreeOf(renderer)
      expect(initialScene.environment).not.toBeNull()
      // 种子视图在挂载后有一次内部换代（useMapVisualization 建模收敛）：
      // 等待视图稳定（轨迹出现换代清理）后清空轨迹，只断言恢复提交的顺序
      for (let i = 0; i < 5 && !layerTrace.events.includes('cleanup:ground'); i += 1) {
        await flush()
      }
      const envCallsAfterMount = env.factory.mock.calls.length
      expect(envCallsAfterMount).toBeGreaterThanOrEqual(1)
      layerTrace.events.length = 0

      // 资源代递增：同一次提交内「先释放全部旧资源，再按 地图五层→环境 重建」
      await act(async () => {
        await renderer.update(
          <MapVisualizationFeature
            map={makeDescriptor()}
            environmentFactory={env.factory}
            nameAtlasFactory={atlas.factory}
            contextGeneration={1}
          />,
        )
      })
      await flush()
      expect(layerTrace.events).toEqual([
        'cleanup:ground',
        'cleanup:paths',
        'cleanup:nodes',
        'cleanup:landmarks',
        'cleanup:exclusive',
        'cleanup:env',
        'mount:ground',
        'mount:paths',
        'mount:nodes',
        'mount:landmarks',
        'mount:exclusive',
        'mount:env',
      ])
      // 环境工厂恰好在恢复提交中重跑一次；旧环境句柄释放恰好一次（无泄漏）
      expect(env.factory.mock.calls).toHaveLength(envCallsAfterMount + 1)
      expect(env.dispose).toHaveBeenCalledTimes(1)
      // 场景环境贴图已换代为新实例
      const sceneAfter = toThreeOf(renderer)
      expect(sceneAfter.environment).toBe(env.textures[env.textures.length - 1])
      expect(sceneAfter.environment).not.toBeNull()
    } finally {
      renderer.unmount()
    }
  })

  it('恢复期环境工厂失败：上抛 onContextRecreateFailed，场景降级为无 IBL（回滚为一致状态）', async () => {
    const env = makeEnvStub()
    env.succeed()
    const atlas = makeAtlasStub()
    const records: DiagnosticRecord[] = []
    const diagnostics = createDiagnosticsReporter({ sink: (record) => records.push(record) })
    const recreateFailed = vi.fn()
    const renderer = await ReactThreeTestRenderer.create(
      <MapVisualizationFeature
        map={makeDescriptor()}
        environmentFactory={env.factory}
        nameAtlasFactory={atlas.factory}
        diagnostics={diagnostics}
        contextGeneration={0}
        onContextRecreateFailed={recreateFailed}
      />,
    )
    try {
      await flush()
      expect(recreateFailed).not.toHaveBeenCalled()
      const firstTexture = env.textures[0]

      // 恢复代：工厂翻转为失败 → 恢复失败上抛 + 降级诊断，环境贴图清空
      env.fail()
      await act(async () => {
        await renderer.update(
          <MapVisualizationFeature
            map={makeDescriptor()}
            environmentFactory={env.factory}
            nameAtlasFactory={atlas.factory}
            diagnostics={diagnostics}
            contextGeneration={1}
            onContextRecreateFailed={recreateFailed}
          />,
        )
      })
      await flush()
      expect(recreateFailed).toHaveBeenCalledTimes(1)
      const scene = toThreeOf(renderer)
      expect(scene.environment).toBeNull()
      expect(records.some((record) => record.code === 'MAP_ENVIRONMENT_FAILED')).toBe(true)
      // 失败前创建的环境句柄已随换代释放（回滚不保留半建资源）
      expect(env.dispose).toHaveBeenCalledTimes(1)
      void firstTexture
    } finally {
      renderer.unmount()
    }
  })

  it('初始挂载（资源代 0）环境失败：仅按既有语义降级，不计入恢复失败', async () => {
    const env = makeEnvStub()
    env.fail()
    const atlas = makeAtlasStub()
    const recreateFailed = vi.fn()
    const renderer = await ReactThreeTestRenderer.create(
      <MapVisualizationFeature
        map={makeDescriptor()}
        environmentFactory={env.factory}
        nameAtlasFactory={atlas.factory}
        contextGeneration={0}
        onContextRecreateFailed={recreateFailed}
      />,
    )
    try {
      await flush()
      expect(recreateFailed).not.toHaveBeenCalled()

      // 恢复代：工厂转为成功 → 正常重建，此前初始失败的降级不被误报为恢复失败
      env.succeed()
      await act(async () => {
        await renderer.update(
          <MapVisualizationFeature
            map={makeDescriptor()}
            environmentFactory={env.factory}
            nameAtlasFactory={atlas.factory}
            contextGeneration={1}
            onContextRecreateFailed={recreateFailed}
          />,
        )
      })
      await flush()
      expect(recreateFailed).not.toHaveBeenCalled()
      expect(toThreeOf(renderer).environment).toBe(env.textures[0])
    } finally {
      renderer.unmount()
    }
  })
})

/** 取 test-renderer 场景底层的 THREE.Scene 对象 */
function toThreeOf(renderer: Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>): THREE.Scene {
  const toThree = (instance: unknown): THREE.Object3D =>
    (instance as { instance: THREE.Object3D }).instance
  return toThree(renderer.scene) as unknown as THREE.Scene
}
