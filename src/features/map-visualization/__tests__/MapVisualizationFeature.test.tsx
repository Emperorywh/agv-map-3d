/*
 * MapVisualizationFeature 场景组件测试（与实现共置；TASK-004/005）。
 *
 * 职责：用 @react-three/test-renderer 在无真实 WebGL 的前提下验证公开根组件
 *       的场景图合同：
 * 1. 携带种子描述符时：背景色、环境贴图、方向光、地坪/路径/节点图层全部就位，
 *    节点为单个 InstancedMesh 且实例颜色已挂载；TASK-005 语义层（地标方垫、
 *    充电桩/光环/呼吸灯、名称合批、独占区外沿与名称）就位且各为一个批次；
 * 2. 无描述符时：只保留背景与灯光，无任何地图对象（首次失败保持清屏色）；
 * 3. 刷新失败时旧场景对象原样保留（§11.10 的组件侧表现）；
 * 4. 装饰动画开关（decorationsEnabled）即时反映在呼吸灯 uniforms；
 * 5. 名称图集创建失败时名称图层整体降级，地标与外沿不受影响（逐项隔离）；
 * 6. 卸载时环境、图层几何与材质、名称图集全部释放；
 * 7. 动态阴影/阴影分辨率能力开关（TASK-014）驱动方向光换代生效且场景唯一。
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
import type { MapNameAtlasFactory } from '../hooks/useMapNameAtlas'
import { MAP_CLEAR_COLOR } from '../scene/mapAppearance'
import { makeGroup, makeLineEdge, makeNode } from './fixtures'
import { MapVisualizationFeature } from '../components/MapVisualizationFeature'

/** 微任务冲刷：让 effect 内同步 setState 之后的提交完成 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

/** 夹具地图：work a、charge b、warehouse w1、park p1 + 一条边 + 一个独占区 */
function buildModel(): ReturnType<typeof createMapModel> {
  return createMapModel(
    validateMap({
      nodes: [
        makeNode({ id: 'a', name: 'A', x: 0, y: 0 }),
        makeNode({ id: 'b', name: 'B', type: 'charge', x: 3, y: 4 }),
        makeNode({ id: 'w1', name: 'AMR-PICK001', type: 'warehouse', x: 8, y: 0 }),
        makeNode({ id: 'p1', name: '847', type: 'park', x: 12, y: -2 }),
      ],
      edges: [makeLineEdge({ id: 'e1', snodeId: 'a', enodeId: 'b' })],
      zones: [],
      nodeEdgeGroups: [
        makeGroup({ id: 'g1', name: '独占区1', nodeIds: ['a', 'b'], edgeIds: ['e1'] }),
      ],
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

/** 注入的名称图集工厂替身：为每个条目分配固定单元格，可观察 dispose */
function makeAtlasStub() {
  const texture = new THREE.Texture()
  const dispose = vi.fn()
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
    dispose,
  })) as unknown as MapNameAtlasFactory
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

/** 断言某场景对象是唯一实例且为 InstancedMesh，返回其 count 与 instanceColor */
function expectSingleInstanced(
  scene: Parameters<typeof findByName>[0],
  name: string,
): { count: number; hasColor: boolean } {
  const found = findByName(scene, name)
  expect(found).toHaveLength(1)
  const mesh = toThree(found[0]) as unknown as THREE.InstancedMesh
  expect(mesh.isInstancedMesh).toBe(true)
  return { count: mesh.count, hasColor: mesh.instanceColor !== null }
}

describe('MapVisualizationFeature 场景组合', () => {
  it('种子就绪：背景/环境/灯光/静态图层与 TASK-005 语义层全部就位且各为一个批次', async () => {
    const env = makeEnvStub()
    const atlas = makeAtlasStub()
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <MapVisualizationFeature
          map={makeDescriptor()}
          environmentFactory={env.factory}
          nameAtlasFactory={atlas.factory}
        />
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
    const nodes = expectSingleInstanced(renderer.scene, 'map-nodes')
    expect(nodes.count).toBe(4)

    // TASK-005 地标：方垫 = warehouse + park；充电桩/光环/呼吸灯 = charge 数
    const pads = expectSingleInstanced(renderer.scene, 'map-landmark-pads')
    expect(pads.count).toBe(2)
    expect(pads.hasColor).toBe(true)
    expect(expectSingleInstanced(renderer.scene, 'map-charge-piles').count).toBe(1)
    expect(expectSingleInstanced(renderer.scene, 'map-charge-rings').count).toBe(1)
    expect(expectSingleInstanced(renderer.scene, 'map-charge-lights').count).toBe(1)

    // 名称合批：仓库 1 + 停车字形 1 → 8 顶点；分组名称 1 → 4 顶点
    const landmarkNames = findByName(renderer.scene, 'map-landmark-names')
    expect(landmarkNames).toHaveLength(1)
    expect(
      (toThree(landmarkNames[0]) as unknown as THREE.Mesh).geometry.getAttribute('position')
        .count,
    ).toBe(8)
    const exclusiveOutline = findByName(renderer.scene, 'map-exclusive-outline')
    expect(exclusiveOutline).toHaveLength(1)
    const groupNames = findByName(renderer.scene, 'map-group-names')
    expect(groupNames).toHaveLength(1)
    expect(
      (toThree(groupNames[0]) as unknown as THREE.Mesh).geometry.getAttribute('position')
        .count,
    ).toBe(4)

    renderer.unmount()
  })

  it('无描述符：只保留背景与灯光，无任何地图对象（清屏色）', async () => {
    const env = makeEnvStub()
    const atlas = makeAtlasStub()
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <MapVisualizationFeature
          map={null}
          environmentFactory={env.factory}
          nameAtlasFactory={atlas.factory}
        />
      </StrictMode>,
    )
    await flush()

    const scene = toThree(renderer.scene) as unknown as THREE.Scene
    expect((scene.background as THREE.Color).getHexString()).toBe(MAP_CLEAR_COLOR.replace('#', ''))
    expect(findByName(renderer.scene, 'map-ground')).toHaveLength(0)
    expect(findByName(renderer.scene, 'map-path-surface')).toHaveLength(0)
    expect(findByName(renderer.scene, 'map-nodes')).toHaveLength(0)
    expect(findByName(renderer.scene, 'map-landmark-pads')).toHaveLength(0)
    expect(findByName(renderer.scene, 'map-exclusive-outline')).toHaveLength(0)
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
      const atlas = makeAtlasStub()
      const renderer = await ReactThreeTestRenderer.create(
        <StrictMode>
          <MapVisualizationFeature
            map={makeDescriptor()}
            environmentFactory={env.factory}
            nameAtlasFactory={atlas.factory}
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
            nameAtlasFactory={atlas.factory}
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

  it('decorationsEnabled=false：呼吸灯 uniforms 即时关闭，其余地标照常渲染', async () => {
    const env = makeEnvStub()
    const atlas = makeAtlasStub()
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <MapVisualizationFeature
          map={makeDescriptor()}
          environmentFactory={env.factory}
          nameAtlasFactory={atlas.factory}
          decorationsEnabled={false}
        />
      </StrictMode>,
    )
    await flush()

    const lights = toThree(findByName(renderer.scene, 'map-charge-lights')[0]) as unknown as {
      material: { userData: { uniforms: { uPulseEnabled: { value: number } } } }
    }
    expect(lights.material.userData.uniforms.uPulseEnabled.value).toBe(0)
    // 开关不隐藏业务语义：方垫/立柱/名称仍然在场
    expect(findByName(renderer.scene, 'map-landmark-pads')).toHaveLength(1)
    expect(findByName(renderer.scene, 'map-charge-piles')).toHaveLength(1)
    expect(findByName(renderer.scene, 'map-landmark-names')).toHaveLength(1)

    // 切换为 true：重建后 uniforms 打开（useFrame 运行时同步同一开关）
    await renderer.update(
      <StrictMode>
        <MapVisualizationFeature
          map={makeDescriptor()}
          environmentFactory={env.factory}
          nameAtlasFactory={atlas.factory}
          decorationsEnabled={true}
        />
      </StrictMode>,
    )
    await flush()
    const lightsAfter = toThree(findByName(renderer.scene, 'map-charge-lights')[0]) as unknown as {
      material: { userData: { uniforms: { uPulseEnabled: { value: number } } } }
    }
    expect(lightsAfter.material.userData.uniforms.uPulseEnabled.value).toBe(1)
    renderer.unmount()
  })

  it('dynamicShadowsEnabled/shadowMapSize 变化：方向光换代生效且场景唯一（TASK-014）', async () => {
    const env = makeEnvStub()
    const atlas = makeAtlasStub()
    // 同一描述符复用：排他地验证阴影能力 props 驱动灯光重建
    const descriptor = makeDescriptor()
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <MapVisualizationFeature
          map={descriptor}
          environmentFactory={env.factory}
          nameAtlasFactory={atlas.factory}
          shadowMapSize={2048}
          dynamicShadowsEnabled={true}
        />
      </StrictMode>,
    )
    await flush()
    const light = toThree(findByName(renderer.scene, 'map-directional-light')[0]) as unknown as THREE.DirectionalLight
    expect(light.castShadow).toBe(true)
    expect(light.shadow.mapSize.x).toBe(2048)

    // 质量 2/3 级能力（分辨率 1024 + 关闭动态阴影）：灯光对象换代且场景唯一，
    // 目标点同步换代（primitive key 携带资源代，规避 R3F primitive 换 object
    // 的重建丢弃问题）
    await renderer.update(
      <StrictMode>
        <MapVisualizationFeature
          map={descriptor}
          environmentFactory={env.factory}
          nameAtlasFactory={atlas.factory}
          shadowMapSize={1024}
          dynamicShadowsEnabled={false}
        />
      </StrictMode>,
    )
    await flush()
    const lights = findByName(renderer.scene, 'map-directional-light')
    expect(lights).toHaveLength(1)
    const rebuilt = toThree(lights[0]) as unknown as THREE.DirectionalLight
    expect(rebuilt).not.toBe(light)
    expect(rebuilt.castShadow).toBe(false)
    expect(rebuilt.shadow.mapSize.x).toBe(1024)
    expect(findByName(renderer.scene, 'map-light-target')).toHaveLength(1)
    renderer.unmount()
  })

  it('名称图集创建失败：名称图层整体降级，地标与独占区外沿不受影响', async () => {
    const records: DiagnosticRecord[] = []
    const diagnostics = createDiagnosticsReporter({ sink: (record) => records.push(record) })
    const env = makeEnvStub()
    const failedFactory = vi.fn(() => {
      throw new Error('no canvas')
    }) as unknown as MapNameAtlasFactory
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <MapVisualizationFeature
          map={makeDescriptor()}
          environmentFactory={env.factory}
          nameAtlasFactory={failedFactory}
          diagnostics={diagnostics}
        />
      </StrictMode>,
    )
    await flush()

    expect(findByName(renderer.scene, 'map-landmark-names')).toHaveLength(0)
    expect(findByName(renderer.scene, 'map-group-names')).toHaveLength(0)
    expect(findByName(renderer.scene, 'map-landmark-pads')).toHaveLength(1)
    expect(findByName(renderer.scene, 'map-charge-piles')).toHaveLength(1)
    expect(findByName(renderer.scene, 'map-exclusive-outline')).toHaveLength(1)
    expect(records.some((record) => record.code === 'MAP_NAME_ATLAS_FAILED')).toBe(true)
    renderer.unmount()
  })

  it('图集条目缺失逐项隔离：缺失 key 的名称不参与合批，其余名称照常', async () => {
    const env = makeEnvStub()
    // 替身工厂跳过节点名称（仓库）：只保留分组名称与停车字形
    const partialFactory = vi.fn((specs: readonly { key: string }[]) => ({
      texture: new THREE.Texture(),
      cells: new Map(
        specs
          .filter((spec) => !spec.key.startsWith('node:'))
          .map((spec, index) => [
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
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <MapVisualizationFeature
          map={makeDescriptor()}
          environmentFactory={env.factory}
          nameAtlasFactory={partialFactory}
        />
      </StrictMode>,
    )
    await flush()

    // 地标名称只剩停车字形（4 顶点）；分组名称不受影响
    const landmarkNames = toThree(findByName(renderer.scene, 'map-landmark-names')[0]) as unknown as THREE.Mesh
    expect(landmarkNames.geometry.getAttribute('position').count).toBe(4)
    expect(findByName(renderer.scene, 'map-group-names')).toHaveLength(1)
    renderer.unmount()
  })

  it('卸载释放环境贴图、图层全部 GPU 资源与名称图集', async () => {
    const env = makeEnvStub()
    const atlas = makeAtlasStub()
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <MapVisualizationFeature
          map={makeDescriptor()}
          environmentFactory={env.factory}
          nameAtlasFactory={atlas.factory}
        />
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
    expect(atlas.dispose).toHaveBeenCalledTimes(1)
  })
})
