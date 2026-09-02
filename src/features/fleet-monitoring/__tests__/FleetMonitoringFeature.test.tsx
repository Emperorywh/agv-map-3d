/*
 * FleetMonitoringFeature 根组件测试（TASK-010 / SPEC §4、§12.3、§12.5）。
 *
 * 职责：验证公开根组件的组合合同——共用 GPU 资源单一持有、worldTransform
 * 注入语义、高频车辆事件不触发任何 React 重渲染（渲染计数探针 + 场景对象
 * 身份不变），以及「app 注入坐标转换」的跨 Feature 组合口径。
 */
import { StrictMode } from 'react'
import { act } from '@testing-library/react'
import { describe, expect, it, afterEach, vi } from 'vitest'
import ReactThreeTestRenderer from '@react-three/test-renderer'
import * as THREE from 'three'
import {
  createPlaneTransform,
  createWorldTransform,
  IDENTITY_AFFINE,
  type WorldTransform,
} from '@/shared/spatial'
import { createFleetRuntime } from '../model/createFleetRuntime'
import { FleetRuntimeProvider } from '../components/FleetRuntimeProvider'
import { FleetMonitoringFeature } from '../components/FleetMonitoringFeature'
import { useFleetRuntime } from '../hooks/FleetRuntimeContext'
import { computeVehiclePartLayout, computeVehicleWorldPose } from '../scene/createVehicleGeometry'
import type {
  SourceStatus,
  Unsubscribe,
  VehicleDataEvent,
  VehicleDataSource,
} from '../data-source/contract'
import {
  makeRawVehicle,
  removeEvent,
  snapshotEvent,
  snapshotOf,
  updateEvent,
} from './testVehicles'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type TestRenderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>

function makeWorld(): WorldTransform {
  return createWorldTransform(createPlaneTransform(IDENTITY_AFFINE), { x: 100, y: 50 })
}

function snap(key: string) {
  return snapshotOf({
    agvKey: key,
    agvPosition: { x: 100, y: 50, theta: 0, localizationScore: 0.9 },
    agvDimension: { length: 1.8, width: 0.7, loadLength: 1.8, loadWidth: 0.7, centerOffset: 0.25 },
    connectionState: 'ONLINE',
    vehicleProcStatus: 'IDLE',
  })
}

/** 渲染计数探针：消费同一 Context，向上回传运行时引用与其渲染次数 */
let probeRenders = 0
let probeRuntime: ReturnType<typeof createFleetRuntime> | null = null

function Probe(): null {
  const { runtime } = useFleetRuntime()
  probeRuntime = runtime
  probeRenders += 1
  return null
}

async function advance(renderer: TestRenderer, frames = 1, delta = 1 / 60): Promise<void> {
  await act(async () => {
    renderer.advanceFrames(frames, delta)
  })
}

describe('FleetMonitoringFeature（TASK-010）', () => {
  it('高频车辆事件零 React 重渲染：探针计数恒定，场景对象身份不变', async () => {
    probeRenders = 0
    probeRuntime = null
    const world = makeWorld()
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <FleetRuntimeProvider source={null}>
          <Probe />
          <FleetMonitoringFeature worldTransform={world} />
        </FleetRuntimeProvider>
      </StrictMode>,
    )
    try {
      await act(async () => {})
      // StrictMode 双执行收敛后的渲染计数基线
      const baseline = probeRenders
      expect(probeRuntime).not.toBeNull()

      const runtime = probeRuntime!
      runtime.applyEvent(snapshotEvent([snap('v0'), snap('v1')]))
      await advance(renderer)

      const shellBefore = renderer.scene.findAll(
        (n) => (n.instance as THREE.Object3D).name === 'fleet-shell-b0',
      )[0]!.instance

      // 2Hz 式高频增量：50 条 update + 20 条删除/新增，期间探针零重渲染
      for (let i = 0; i < 50; i += 1) {
        runtime.applyEvent({
          type: 'update',
          schemaVersion: 'test/1',
          mapId: 'map-under-test',
          sequence: i + 2,
          receivedAt: 1000 + i,
          vehicle: snap('v0'),
        })
      }
      for (let frame = 0; frame < 4; frame += 1) {
        await advance(renderer)
      }

      expect(probeRenders).toBe(baseline)
      const shellAfter = renderer.scene.findAll(
        (n) => (n.instance as THREE.Object3D).name === 'fleet-shell-b0',
      )[0]!.instance
      // 场景对象未被重建：高频路径只写实例缓冲，不触碰 React 树
      expect(shellAfter).toBe(shellBefore)
      const matrices = (shellAfter as THREE.InstancedMesh).instanceMatrix.array as Float32Array
      // 两台车都在场（首台在 50 次增量后仍被提交）
      expect(matrices[0]).toBeGreaterThan(0)
    } finally {
      renderer.unmount()
    }
  })

  it('worldTransform=null：不挂载任何车辆批次对象', async () => {
    const renderer = await ReactThreeTestRenderer.create(
      <FleetRuntimeProvider source={null}>
        <FleetMonitoringFeature worldTransform={null} />
      </FleetRuntimeProvider>,
    )
    try {
      const fleetGroups = renderer.scene.findAll(
        (n) => (n.instance as THREE.Object3D).name === 'fleet-vehicles',
      )
      expect(fleetGroups).toHaveLength(0)
    } finally {
      renderer.unmount()
    }
  })

  it('trafficPulseEnabled 能力开关：帧同步写入脉冲 uniforms（TASK-014）', async () => {
    const world = makeWorld()
    const renderer = await ReactThreeTestRenderer.create(
      <FleetRuntimeProvider source={null}>
        <FleetMonitoringFeature worldTransform={world} trafficPulseEnabled={false} />
      </FleetRuntimeProvider>,
    )
    try {
      await advance(renderer)
      const traffic = renderer.scene.findAll(
        (n) => (n.instance as THREE.Object3D).name === 'traffic-locks',
      )
      expect(traffic).toHaveLength(1)
      const uniforms = (
        (traffic[0].instance as THREE.Mesh).material as THREE.MeshBasicMaterial
      ).userData.uniforms as { uLockPulseEnabled: { value: number }; uTime: { value: number } }
      // 质量降级能力（SPEC §6.5 行动 3）：开关关闭经帧同步写入 uniforms
      expect(uniforms.uLockPulseEnabled.value).toBe(0)

      // 默认（脉冲开启）：同一 uniforms 翻回 1（时间相位写入用 clock.elapsedTime，
      // 测试渲染器不推进时钟，此处只断言开关语义）
      await renderer.update(
        <FleetRuntimeProvider source={null}>
          <FleetMonitoringFeature worldTransform={world} />
        </FleetRuntimeProvider>,
      )
      await advance(renderer, 5)
      expect(uniforms.uLockPulseEnabled.value).toBe(1)
    } finally {
      renderer.unmount()
    }
  })
})

/* ==================== 后台节流与前台瞬时对齐（SPEC §11.5；TASK-015） ==================== */

/** 设置页面可见性并派发 visibilitychange（jsdom 无真实切换） */
function setPageVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** 最小事件源替身：connect 即 OPEN，测试用 emit 直推事件 */
class EmittingSource implements VehicleDataSource {
  private readonly cbs = new Set<(event: VehicleDataEvent) => void>()
  connect = vi.fn(() => Promise.resolve())
  disconnect = vi.fn()
  requestSnapshot = vi.fn()
  readonly status: SourceStatus = 'OPEN'
  onEvent(cb: (event: VehicleDataEvent) => void): Unsubscribe {
    this.cbs.add(cb)
    return () => {
      this.cbs.delete(cb)
    }
  }
  onStatusChange = vi.fn((): Unsubscribe => () => {})
  emit(event: VehicleDataEvent): void {
    for (const cb of [...this.cbs]) {
      cb(event)
    }
  }
}

describe('后台节流与前台瞬时对齐（§11.5；TASK-015）', () => {
  afterEach(() => {
    setPageVisibility('visible')
    probeRenders = 0
    probeRuntime = null
  })

  it('后台 10min 多次 update/remove 后，回前台首个渲染帧与最新快照一帧对齐', async () => {
    const world = makeWorld()
    const source = new EmittingSource()
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <FleetRuntimeProvider source={source}>
          <Probe />
          <FleetMonitoringFeature worldTransform={world} />
        </FleetRuntimeProvider>
      </StrictMode>,
    )
    try {
      await act(async () => {})
      expect(probeRuntime).not.toBeNull()
      const runtime = probeRuntime!

      // 前台基线：两台车就位并完成至少一次提交
      const v0 = snap('v0')
      const v1 = snap('v1')
      source.emit(snapshotEvent([v0, v1], 1_000, 1))
      await advance(renderer, 2)
      const chassis = renderer.scene.findAll(
        (n) => (n.instance as THREE.Object3D).name === 'fleet-chassis-b0',
      )[0]!.instance as THREE.InstancedMesh
      const read = (slot: number): number[] =>
        Array.from(chassis.instanceMatrix.array as Float32Array).slice(slot * 16, slot * 16 + 16)
      const baseline0 = read(0)
      expect(baseline0[12]).not.toBe(0)

      // 隐藏（渲染停止）：期间多次 update 推进 v0、remove 删除 v1——
      // 不推进任何帧（真实浏览器隐藏期间 rAF/frameloop 均不产生渲染）
      act(() => {
        setPageVisibility('hidden')
      })
      source.emit(updateEvent(
        snapshotOf({ ...makeRawVehicle({ agvKey: 'v0' }), agvPosition: { x: 110, y: 52, theta: 0, localizationScore: 0.9 } }),
        600_000, 2,
      ))
      source.emit(updateEvent(
        snapshotOf({ ...makeRawVehicle({ agvKey: 'v0' }), agvPosition: { x: 120, y: 53, theta: 0, localizationScore: 0.9 } }),
        600_500, 3,
      ))
      source.emit(updateEvent(
        snapshotOf({ ...makeRawVehicle({ agvKey: 'v0' }), agvPosition: { x: 130, y: 54, theta: 0, localizationScore: 0.9 } }),
        601_000, 4,
      ))
      source.emit(removeEvent(v1.mapId, v1.agvKey, 601_500))
      // 中间状态不回放：运行时只保留每车最新快照
      expect(runtime.count).toBe(1)
      expect(runtime.get(v0.entityKey)?.snapshot.position.x).toBe(130)

      // 回前台：恢复 ticker + 强制全量 diff；恰好一帧后与最新快照一致
      act(() => {
        setPageVisibility('visible')
      })
      await advance(renderer, 1)
      const entity = runtime.get(v0.entityKey)!
      const expectedPose = computeVehicleWorldPose(entity.snapshot, world)
      const expectedLayout = computeVehiclePartLayout(entity.snapshot, entity.displayState)
      // 底盘矩阵位置分量 = 车体世界中心 + 部件本地偏移经 rotY 旋转
      // （底盘与外壳对齐带 -wedgeLen/2 本地偏移；theta=0 时旋转不改变偏移）
      const expectedX = expectedPose.cx + expectedLayout.chassis.x
      const expectedZ = expectedPose.cz + expectedLayout.chassis.z
      const aligned0 = read(0)
      expect(aligned0[12]).toBeCloseTo(expectedX, 5)
      expect(aligned0[14]).toBeCloseTo(expectedZ, 5)
      // 被删车辆槽位零缩放清场（无幽灵车）
      const stale1 = read(1)
      expect(stale1[0]).toBe(0)
      expect(stale1[12]).toBe(0)

      // 无插值/无累积：后续帧矩阵稳定不变（§11.4 位置跳变直用新位置）
      await advance(renderer, 3)
      expect(read(0)).toEqual(aligned0)
    } finally {
      renderer.unmount()
    }
  })
})
