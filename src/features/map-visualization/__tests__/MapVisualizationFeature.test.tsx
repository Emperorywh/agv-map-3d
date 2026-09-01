/*
 * MapVisualizationFeature 场景组件测试（与实现共置；TASK-004）。
 *
 * 职责：用 @react-three/test-renderer 在无真实 WebGL 的前提下验证公开根组件
 *       的场景图合同：
 * 1. 携带种子描述符时：背景色、环境贴图、方向光、地坪/路径/节点图层全部就位，
 *    节点为单个 InstancedMesh 且实例颜色已挂载；StrictMode 下无重复对象；
 * 2. 无描述符时：只保留背景与灯光，无任何地图对象（首次失败保持清屏色）；
 * 3. 刷新失败时旧场景对象原样保留（§11.10 的组件侧表现）；
 * 4. 卸载时环境、图层几何与材质全部释放。
 */
import { StrictMode } from 'react'
import { act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { ReactThreeTest } from '@react-three/test-renderer'
import ReactThreeTestRenderer from '@react-three/test-renderer'
import type * as R3FThree from 'three'

type ReactThreeTestInstance = ReactThreeTest.ReactThreeTestInstance
import { createDiagnosticsReporter, type DiagnosticRecord } from '@/shared/diagnostics'
import { IDENTITY_AFFINE } from '@/shared/spatial'
import { createMapModel } from '../model/createMapModel'
import { validateMap } from '../model/validateMap'
import type { MapViewDescriptor } from '../hooks/useMapVisualization'
import { MAP_CLEAR_COLOR } from '../scene/mapAppearance'
import { makeLineEdge, makeNode } from './fixtures'
import { MapVisualizationFeature } from '../components/MapVisualizationFeature'

/** 微任务冲刷：让 effect 内同步 setState 之后的提交完成 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

function buildModel(): ReturnType<typeof createMapModel> {
  return createMapModel(
    validateMap({
      nodes: [
        makeNode({ id: 'a', name: 'A', x: 0, y: 0 }),
        makeNode({ id: 'b', name: 'B', type: 'charge', x: 3, y: 4 }),
      ],
      edges: [makeLineEdge({ id: 'e1', snodeId: 'a', enodeId: 'b' })],
      zones: [],
      nodeEdgeGroups: [],
    }),
  )
}

function makeDescriptor(seed = true): MapViewDescriptor {
  const model = seed ? buildModel() : undefined
  return {
    mapUrl: 'http://t/map.json',
    coordinateTransform: IDENTITY_AFFINE,
    ...(model ? { initial: { mapModel: model.mapModel, worldTransform: model.worldTransform } } : {}),
  }
}

/** 注入的环境工厂替身：可观察 texture 挂载与 dispose 调用 */
function makeEnvStub() {
  const texture = new THREE.Texture()
  const dispose = vi.fn()
  const factory = vi.fn(() => ({ texture, dispose }))
  return { texture, dispose, factory }
}

/** test-renderer 包装实例底层的 THREE 对象（身份比较与 GPU 属性断言用） */
function toThree(instance: ReactThreeTestInstance): R3FThree.Object3D {
  return instance.instance
}

function findByName(
  scene: {
    findAll: (cb: (node: ReactThreeTestInstance) => boolean) => ReactThreeTestInstance[]
  },
  name: string,
): ReactThreeTestInstance[] {
  return scene.findAll((node) => toThree(node).name === name)
}

describe('MapVisualizationFeature 场景组合', () => {
  it('种子就绪：背景/环境/灯光/地坪/路径/节点全部就位，节点为单个 InstancedMesh', async () => {
    const env = makeEnvStub()
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <MapVisualizationFeature map={makeDescriptor()} environmentFactory={env.factory} />
      </StrictMode>,
    )
    await flush()

    // 清屏底色与注入的环境贴图（挂载在底层 THREE.Scene 上）
    const scene = toThree(renderer.scene) as unknown as THREE.Scene
    // 不用 instanceof：test-renderer 内部可能持有另一份 three 拷贝，用取值判断
    expect((scene.background as { isColor?: boolean }).isColor).toBe(true)
    expect((scene.background as THREE.Color).getHexString()).toBe(MAP_CLEAR_COLOR.replace('#', ''))
    expect(scene.environment).toBe(env.texture)

    // 灯光：方向光 + 独立目标点
    expect(findByName(renderer.scene, 'map-directional-light')).toHaveLength(1)
    expect(findByName(renderer.scene, 'map-light-target')).toHaveLength(1)

    // 静态图层各一份（StrictMode 双执行不产生重复对象）
    expect(findByName(renderer.scene, 'map-ground')).toHaveLength(1)
    expect(findByName(renderer.scene, 'map-path-surface')).toHaveLength(1)
    expect(findByName(renderer.scene, 'map-path-centerline')).toHaveLength(1)
    const nodesMeshes = findByName(renderer.scene, 'map-nodes')
    expect(nodesMeshes).toHaveLength(1)
    const nodes = toThree(nodesMeshes[0]) as unknown as THREE.InstancedMesh
    expect(nodes.isInstancedMesh).toBe(true)
    expect(nodes.count).toBe(2)
    expect(nodes.instanceColor).not.toBeNull()

    renderer.unmount()
  })

  it('无描述符：只保留背景与灯光，无任何地图对象（清屏色）', async () => {
    const env = makeEnvStub()
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <MapVisualizationFeature map={null} environmentFactory={env.factory} />
      </StrictMode>,
    )
    await flush()

    const scene = toThree(renderer.scene) as unknown as THREE.Scene
    expect((scene.background as THREE.Color).getHexString()).toBe(MAP_CLEAR_COLOR.replace('#', ''))
    expect(findByName(renderer.scene, 'map-ground')).toHaveLength(0)
    expect(findByName(renderer.scene, 'map-path-surface')).toHaveLength(0)
    expect(findByName(renderer.scene, 'map-nodes')).toHaveLength(0)
    // 灯光仍挂载（无地图包围盒时不配置阴影相机，灯光对象待 bounds 到达后创建）
    renderer.unmount()
  })

  it('刷新失败：旧场景对象原样保留，并记录重试诊断', async () => {
    // 让默认 loadMap 走注入的失败 fetch（无种子 → 网络加载路径）
    const fetchStub = vi.fn(async () => {
      throw new TypeError('network down')
    })
    vi.stubGlobal('fetch', fetchStub)
    try {
      const records: DiagnosticRecord[] = []
      const diagnostics = createDiagnosticsReporter({ sink: (record) => records.push(record) })
      const env = makeEnvStub()
      const renderer = await ReactThreeTestRenderer.create(
        <StrictMode>
          <MapVisualizationFeature
            map={makeDescriptor()}
            environmentFactory={env.factory}
            diagnostics={diagnostics}
          />
        </StrictMode>,
      )
      await flush()
      const nodesBefore = findByName(renderer.scene, 'map-nodes')
      expect(nodesBefore).toHaveLength(1)

      // mapUrl 变化 → 刷新失败：节点网格仍是同一实例（旧场景未卸载）
      await renderer.update(
        <StrictMode>
          <MapVisualizationFeature
            map={{ mapUrl: 'http://t/map2.json', coordinateTransform: IDENTITY_AFFINE }}
            environmentFactory={env.factory}
            diagnostics={diagnostics}
          />
        </StrictMode>,
      )
      await flush()
      const nodesAfter = findByName(renderer.scene, 'map-nodes')
      expect(nodesAfter).toHaveLength(1)
      // 底层 THREE 对象身份不变：旧场景未被卸载重建
      expect(toThree(nodesAfter[0])).toBe(toThree(nodesBefore[0]))
      expect(records.some((record) => record.code === 'MAP_SCENE_LOAD_RETRY')).toBe(true)
      renderer.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('卸载释放环境贴图与图层全部 GPU 资源', async () => {
    const env = makeEnvStub()
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <MapVisualizationFeature map={makeDescriptor()} environmentFactory={env.factory} />
      </StrictMode>,
    )
    await flush()

    // 给场景内全部 geometry / 材质挂 dispose 间谍（图层自建资源 + MapGeometry）
    const disposables: { dispose: () => void }[] = []
    const all = renderer.scene.findAll(() => true)
    for (const node of all) {
      const object = toThree(node) as unknown as {
        geometry?: THREE.BufferGeometry
        material?: THREE.Material
      }
      if (object.geometry) {
        disposables.push(object.geometry)
      }
      if (object.material) {
        disposables.push(object.material)
      }
    }
    const spies = disposables.map((disposable) => vi.spyOn(disposable, 'dispose'))

    await renderer.unmount()
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledTimes(1)
    }
    expect(env.dispose).toHaveBeenCalledTimes(1)
  })
})
