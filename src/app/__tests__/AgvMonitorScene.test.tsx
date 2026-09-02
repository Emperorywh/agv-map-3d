/*
 * AgvMonitorScene 场景组合测试（与实现共置）。
 *
 * 职责：用 @react-three/test-renderer 在不依赖真实 WebGL 的前提下，校验
 *       Canvas 内唯一组合根的场景图内容与跨 Feature 桥接（TASK-004 接入地
 *       图 Feature，TASK-013 接入相机导航与跟随桥接）。
 * 关键不变量（F3 / F4 / §11.10 / §12.3）：
 * 1. 唯一组合锚点 agv-monitor-scene：StrictMode 双执行与更新不产生重复或残留；
 * 2. 无地图描述符时场景内无任何地图对象（首次失败保持清屏色）；
 * 3. 携带 bootstrap 种子描述符时，地图静态图层（地坪/路径/节点）就位且唯一；
 * 4. 本组件只做组合：不自行解析描述符以外的任何业务状态；
 * 5. 相机由 camera-navigation 接管：地图包围盒到位即自动取景（45° 俯瞰）；
 * 6. 跨 Feature 协作只在组合层：车队双击跟随请求经命令引用转交相机，相机
 *    逐帧读取运行时+世界变换合成的只读目标——跟随位姿与渲染车体同口径。
 * 注意：test-renderer 的容器在 unmount 后即失效，完整生命周期断言必须在
 * 单个用例内完成。环境工厂默认实现需要真实 WebGL，测试中经 catch 降级为
 * 无 IBL，不影响场景结构断言。
 */
import { StrictMode } from 'react'
import { act } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  createDiagnosticsReporter,
  type DiagnosticRecord,
} from '@/shared/diagnostics'
import { ReactThreeTest } from '@react-three/test-renderer'
import ReactThreeTestRenderer from '@react-three/test-renderer'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { AgvMonitorScene } from '@/app/scene/AgvMonitorScene'
import {
  createMapModel,
  validateMap,
  type MapViewDescriptor,
  type SceneBounds,
} from '@/features/map-visualization'
import {
  computeOverviewPose,
} from '@/features/camera-navigation'
import {
  type VehicleDataEvent,
  type VehicleDataSource,
} from '@/features/fleet-monitoring'
import { snapshotOf } from '@/features/fleet-monitoring/__tests__/testVehicles'
import { useRenderQualityStore } from '@/features/render-quality/model/renderQualityStore'

const ANCHOR_NAME = 'agv-monitor-scene'

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

type TestInstance = ReactThreeTest.ReactThreeTestInstance
type TestRenderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>

function findByName(
  scene: { findAll: (cb: (node: TestInstance) => boolean) => TestInstance[] },
  name: string,
): TestInstance[] {
  return scene.findAll((node) => node.instance.name === name)
}

interface SeedResult {
  descriptor: MapViewDescriptor
  sceneBounds: SceneBounds
  worldTransform: ReturnType<typeof createMapModel>['worldTransform']
  mapId: string
}

/** 最小合法地图（公开入口建模），作为场景描述符的 bootstrap 种子 */
function buildSeedDescriptor(): SeedResult {
  const { mapModel, worldTransform } = createMapModel(
    validateMap({
      nodes: [
        { id: 'a', name: 'A', type: 'work', mapId: 'm1', highPrecision: false, x: 0, y: 0, angle: null },
        { id: 'b', name: 'B', type: 'work', mapId: 'm1', highPrecision: false, x: 3, y: 4, angle: null },
      ],
      edges: [
        {
          id: 'e1',
          mapId: 'm1',
          edgeType: 'LINE',
          sx: 0,
          sy: 0,
          ex: 3,
          ey: 4,
          cx: null,
          cy: null,
          dx: null,
          dy: null,
          isBackEdge: false,
          cost: 5,
          maxLoadSpeed: 1,
          maxFreeSpeed: 1,
          maxLoadRotationSpeed: null,
          maxFreeRotationSpeed: null,
          loadSecurity: null,
          freeSecurity: null,
          snodeId: 'a',
          enodeId: 'b',
        },
      ],
      zones: [],
      nodeEdgeGroups: [],
    }),
  )
  return {
    descriptor: {
      mapUrl: 'http://t/map.json',
      coordinateTransform: { scale: 1, rotation: 0, mirrorY: false, translateX: 0, translateY: 0 },
      initial: { mapModel, worldTransform },
    },
    sceneBounds: mapModel.sceneBounds,
    worldTransform,
    mapId: mapModel.mapId,
  }
}

/** 场景探针：捕获默认相机（断言取景与跟随位姿） */
function makeProbe(capture: { current: THREE.PerspectiveCamera | null }) {
  return function SceneProbe() {
    const camera = useThree((state) => state.camera)
    capture.current = camera as THREE.PerspectiveCamera
    return null
  }
}

/** 最小 VehicleDataSource 桩：连接即发布既有事件，测试可继续追加发布 */
function makeFakeSource(events: readonly VehicleDataEvent[]): VehicleDataSource & {
  emit: (event: VehicleDataEvent) => void
} {
  const listeners = new Set<(event: VehicleDataEvent) => void>()
  const emit = (event: VehicleDataEvent): void => {
    for (const listener of listeners) {
      listener(event)
    }
  }
  return {
    status: 'OPEN',
    connect: () => {
      for (const event of events) {
        emit(event)
      }
      return Promise.resolve()
    },
    disconnect: () => {},
    requestSnapshot: () => {},
    onEvent: (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    onStatusChange: () => () => {},
    emit,
  }
}

async function advance(renderer: TestRenderer, frames = 1): Promise<void> {
  await act(async () => {
    renderer.advanceFrames(frames, 1 / 60)
  })
}

describe('AgvMonitorScene 场景组合根', () => {
  it('无描述符：唯一锚点、无地图对象（保持清屏色），更新不残留', async () => {
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <AgvMonitorScene />
      </StrictMode>,
    )

    expect(renderer.scene.findAllByProps({ name: ANCHOR_NAME })).toHaveLength(1)
    expect(findByName(renderer.scene, 'map-ground')).toHaveLength(0)
    expect(findByName(renderer.scene, 'map-path-surface')).toHaveLength(0)
    expect(findByName(renderer.scene, 'map-nodes')).toHaveLength(0)

    await renderer.update(
      <StrictMode>
        <AgvMonitorScene />
      </StrictMode>,
    )
    expect(renderer.scene.findAllByProps({ name: ANCHOR_NAME })).toHaveLength(1)
    expect(findByName(renderer.scene, 'map-ground')).toHaveLength(0)
    renderer.unmount()
  })

  it('携带种子描述符：地图静态图层就位且唯一，StrictMode 无重复', async () => {
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <AgvMonitorScene mapDescriptor={buildSeedDescriptor().descriptor} />
      </StrictMode>,
    )
    await flush()

    expect(renderer.scene.findAllByProps({ name: ANCHOR_NAME })).toHaveLength(1)
    expect(findByName(renderer.scene, 'map-ground')).toHaveLength(1)
    expect(findByName(renderer.scene, 'map-path-surface')).toHaveLength(1)
    expect(findByName(renderer.scene, 'map-path-centerline')).toHaveLength(1)

    const nodes = findByName(renderer.scene, 'map-nodes')
    expect(nodes).toHaveLength(1)
    const nodesMesh = nodes[0].instance as unknown as {
      isInstancedMesh: boolean
      count: number
    }
    expect(nodesMesh.isInstancedMesh).toBe(true)
    expect(nodesMesh.count).toBe(2)
    renderer.unmount()
  })

  it('相机由 camera-navigation 接管：种子包围盒到位即 45° 自动取景', async () => {
    const seed = buildSeedDescriptor()
    const capture: { current: THREE.PerspectiveCamera | null } = { current: null }
    const SceneProbe = makeProbe(capture)
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <AgvMonitorScene mapDescriptor={seed.descriptor} />
        <SceneProbe />
      </StrictMode>,
    )
    await flush()

    expect(capture.current).not.toBeNull()
    const pose = computeOverviewPose(seed.sceneBounds, capture.current!.fov)
    expect(capture.current!.position.x).toBeCloseTo(pose.position.x, 4)
    expect(capture.current!.position.y).toBeCloseTo(pose.position.y, 4)
    expect(capture.current!.position.z).toBeCloseTo(pose.position.z, 4)
    renderer.unmount()
  })

  it('跟随桥接：车队双击请求经组合层转交相机，逐帧对齐车辆世界位姿', async () => {
    const seed = buildSeedDescriptor()
    const position = { x: 1.5, y: 2, theta: 0, localizationScore: 0.9 }
    const vehicle = snapshotOf(
      {
        agvKey: 'v-1',
        agvName: '桥接车',
        agvPosition: position,
        agvDimension: {
          length: 1.8,
          width: 0.7,
          loadLength: 1.8,
          loadWidth: 0.7,
          centerOffset: 0.25,
        },
        connectionState: 'ONLINE',
        vehicleProcStatus: 'IDLE',
      },
      seed.mapId,
    )
    const source = makeFakeSource([
      {
        type: 'snapshot',
        schemaVersion: 'test/1',
        mapId: seed.mapId,
        sequence: 1,
        receivedAt: 1_000,
        vehicles: [vehicle],
      },
    ])
    const capture: { current: THREE.PerspectiveCamera | null } = { current: null }
    const SceneProbe = makeProbe(capture)
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <AgvMonitorScene
          mapDescriptor={seed.descriptor}
          vehicleSource={source}
          worldTransform={seed.worldTransform}
        />
        <SceneProbe />
      </StrictMode>,
    )
    await flush()
    await advance(renderer, 2)
    const camera = capture.current!

    // 双击跟随请求：经 fleet 组 onDoubleClick → 组合层命令引用 → 相机跟随。
    // 只有外壳携带 userData.batchId，以此为命中对象。
    const fleetGroup = findByName(renderer.scene, 'fleet-monitoring-feature')
    expect(fleetGroup).toHaveLength(1)
    const shell = renderer.scene.findAll(
      (node) =>
        (node.instance as unknown as { userData?: { batchId?: unknown } }).userData
          ?.batchId === 0,
    )
    expect(shell).toHaveLength(1)
    await renderer.fireEvent(fleetGroup[0], 'doubleClick', {
      instanceId: 0,
      object: shell[0].instance,
      nativeEvent: { clientX: 10, clientY: 10 },
    } as unknown as Record<string, unknown>)
    await advance(renderer, 2)

    // 跟随点 = 车体中心（§2.5：参考点沿车头轴平移 centerOffset，theta=0 → +x）
    const pose = seed.worldTransform.toWorldXZ(
      vehicle.position.x + vehicle.dimension.centerOffset,
      vehicle.position.y,
    )
    const overviewPose = computeOverviewPose(seed.sceneBounds, camera.fov)
    // 进入跟随时注视点 = 包围盒世界中心（origin），偏移 = 取景机位自身：
    // 相机位姿 = 车体中心 + 取景机位相对原点的偏移
    expect(camera.position.x).toBeCloseTo(pose.x + overviewPose.position.x, 3)
    expect(camera.position.z).toBeCloseTo(pose.z + overviewPose.position.z, 3)
    expect(camera.position.y).toBeCloseTo(overviewPose.position.y, 5)

    // 车辆移动 → 下一帧相机平移同一位移（相对偏移保持）
    position.x = 5.5
    source.emit({
      type: 'update',
      schemaVersion: 'test/1',
      mapId: seed.mapId,
      sequence: 2,
      receivedAt: 2_000,
      vehicle: { ...vehicle, position: { ...vehicle.position, x: 5.5 } },
    })
    await advance(renderer, 2)
    const movedPose = seed.worldTransform.toWorldXZ(
      5.5 + vehicle.dimension.centerOffset,
      vehicle.position.y,
    )
    expect(camera.position.x - movedPose.x).toBeCloseTo(overviewPose.position.x, 3)
    expect(camera.position.z - movedPose.z).toBeCloseTo(overviewPose.position.z, 3)
    // 车辆移动后相机随之平移（不再是旧位姿）
    expect(camera.position.x).not.toBeCloseTo(pose.x + overviewPose.position.x, 1)
    renderer.unmount()
  })

  it('质量能力接线（TASK-014）：等级跃迁经组合层映射为阴影/装饰/脉冲/标签开关', async () => {
    const seed = buildSeedDescriptor()
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <AgvMonitorScene
          mapDescriptor={seed.descriptor}
          worldTransform={seed.worldTransform}
        />
      </StrictMode>,
    )
    try {
      await flush()
      // 0 级：动态阴影开启、阴影分辨率取默认 2048、脉冲开启
      const lightAt = () =>
        findByName(renderer.scene, 'map-directional-light')[0]!
          .instance as unknown as THREE.DirectionalLight
      expect(lightAt().castShadow).toBe(true)
      expect(lightAt().shadow.mapSize.x).toBe(2048)

      // 2 级：阴影 2048→1024，动态阴影仍开启；灯光换代后场景唯一
      act(() => {
        useRenderQualityStore.getState().setQualityLevel(2)
      })
      await flush()
      expect(findByName(renderer.scene, 'map-directional-light')).toHaveLength(1)
      expect(lightAt().shadow.mapSize.x).toBe(1024)
      expect(lightAt().castShadow).toBe(true)

      // 3 级：关闭动态阴影与交通锁脉冲（脉冲开关经帧同步写入 uniforms）
      act(() => {
        useRenderQualityStore.getState().setQualityLevel(3)
      })
      await flush()
      await advance(renderer, 1)
      expect(lightAt().castShadow).toBe(false)
      const traffic = findByName(renderer.scene, 'traffic-locks')[0]!
        .instance as unknown as THREE.Mesh
      const uniforms = (traffic.material as THREE.MeshBasicMaterial).userData
        .uniforms as { uLockPulseEnabled: { value: number } }
      expect(uniforms.uLockPulseEnabled.value).toBe(0)
    } finally {
      useRenderQualityStore.getState().setQualityLevel(0)
      renderer.unmount()
    }
  })
})

/* ==== appInteractive 启动阶段合成（TASK-017，SPEC §10.3 阶段 6） ==== */

describe('AgvMonitorScene 启动阶段合成（TASK-017）', () => {
  it('地图视图 + 首批实例 + 相机命令三者齐备后上报 appInteractive 恰好一次', async () => {
    const seed = buildSeedDescriptor()
    const records: DiagnosticRecord[] = []
    const diagnostics = createDiagnosticsReporter({
      sink: (record) => void records.push(record),
      now: () => 0,
      sampleWindowMs: 0,
    })
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <AgvMonitorScene
          mapDescriptor={seed.descriptor}
          worldTransform={seed.worldTransform}
          vehicleSource={makeFakeSource([])}
          diagnostics={diagnostics}
          startedAt={1000}
        />
      </StrictMode>,
    )
    try {
      await advance(renderer)
      const stages = records.filter(
        (record) => record.code === 'BOOTSTRAP_STAGE_APP_INTERACTIVE',
      )
      expect(stages).toHaveLength(1)
      expect(stages[0]).toMatchObject({
        level: 'info',
        context: { stage: 'appInteractive' },
      })
      // 耗时口径：now - startedAt（时钟由诊断通道注入，now=0 → 起点相对值）
      expect(typeof stages[0]!.context.durationMs).toBe('number')
      // 后续帧与重渲染不重复上报（会话级一次性）
      await advance(renderer)
      expect(
        records.filter((record) => record.code === 'BOOTSTRAP_STAGE_APP_INTERACTIVE'),
      ).toHaveLength(1)
    } finally {
      renderer.unmount()
    }
  })

  it('缺任一信号（无数据源 = 无实例）不上报 appInteractive', async () => {
    const seed = buildSeedDescriptor()
    const records: DiagnosticRecord[] = []
    const diagnostics = createDiagnosticsReporter({
      sink: (record) => void records.push(record),
      now: () => 0,
      sampleWindowMs: 0,
    })
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <AgvMonitorScene
          mapDescriptor={seed.descriptor}
          worldTransform={null}
          diagnostics={diagnostics}
        />
      </StrictMode>,
    )
    try {
      await advance(renderer)
      expect(
        records.filter((record) => record.code === 'BOOTSTRAP_STAGE_APP_INTERACTIVE'),
      ).toHaveLength(0)
    } finally {
      renderer.unmount()
    }
  })
})
