/*
 * 车辆光环图层测试（TASK-012 / SPEC §7.3、§11.6、§11.8）。
 *
 * 职责：以 @react-three/test-renderer 验证分层光环的场景语义——选中/L1/L2
 *       从内到外可同时存在、条件恢复下一帧移除、STALE 升级 L2、非法坐标不
 *       放置环、删除清场与每批次 1 网格的 Draw Call 预算。挂载方式与
 *       FleetMonitoringFeature 同构（VehicleInstances 分配槽位 + VehicleRings
 *       共享同一运行时与槽位表），并经测试持有的运行时直接驱动事件。
 */
import { StrictMode } from 'react'
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ReactThreeTestRenderer from '@react-three/test-renderer'
import * as THREE from 'three'
import {
  createPlaneTransform,
  createWorldTransform,
  IDENTITY_AFFINE,
  type WorldTransform,
} from '@/shared/spatial'
import { createFleetRuntime, type FleetRuntime } from '../model/createFleetRuntime'
import { createInstanceSlotTable, type InstanceSlotTable } from '../model/instanceSlots'
import { useFleetMonitoringStore } from '../model/fleetMonitoringStore'
import { VehicleInstances } from '../components/VehicleInstances'
import { VehicleRings } from '../components/VehicleRings'
import { createVehicleResources, type VehicleResources } from '../scene/createVehicleGeometry'
import { createRingResources, type RingResources } from '../scene/vehicleRings'
import {
  LABEL_BORDER_L1_COLOR,
  LABEL_BORDER_L2_COLOR,
  RING_LAYER_RADII_M,
} from '../scene/fleetAppearance'
import { removeEvent, snapshotEvent, snapshotOf, updateEvent } from './testVehicles'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type TestRenderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>

function makeWorld(): WorldTransform {
  return createWorldTransform(createPlaneTransform(IDENTITY_AFFINE), { x: 100, y: 50 })
}

function snap(agvKey: string, overrides: Record<string, unknown> = {}) {
  return snapshotOf({
    agvKey,
    agvName: `名称-${agvKey}`,
    agvPosition: { x: 100, y: 50, theta: 0, localizationScore: 0.9 },
    agvDimension: { length: 1.8, width: 0.7, loadLength: 1.8, loadWidth: 0.7, centerOffset: 0.25 },
    connectionState: 'ONLINE',
    vehicleProcStatus: 'IDLE',
    ...overrides,
  })
}

async function advance(renderer: TestRenderer, frames = 1, delta = 1 / 60): Promise<void> {
  await act(async () => {
    renderer.advanceFrames(frames, delta)
  })
}

function toThree(node: { instance: THREE.Object3D }): THREE.Object3D {
  return node.instance
}

function findMesh(renderer: TestRenderer, name: string): THREE.InstancedMesh {
  const found = renderer.scene.findAll((node) => toThree(node).name === name)
  expect(found).toHaveLength(1)
  return toThree(found[0]) as THREE.InstancedMesh
}

/** 读取 (车辆槽位, 层序) 实例的矩阵缩放 x（0 ≈ 隐藏，正值 = 层半径） */
function ringScaleX(mesh: THREE.InstancedMesh, slot: number, layer: number): number {
  return mesh.instanceMatrix.array[(slot * 3 + layer) * 16] as number
}

/** 读取 (车辆槽位, 层序) 实例的颜色（Float32） */
function ringColor(
  mesh: THREE.InstancedMesh,
  slot: number,
  layer: number,
): [number, number, number] {
  const base = (slot * 3 + layer) * 3
  const array = mesh.instanceColor!.array as Float32Array
  return [array[base], array[base + 1], array[base + 2]]
}

/** 与 Feature 同构的最小组合：车体图层分配槽位，光环图层共享消费 */
function RingHarness({
  runtime,
  table,
  world,
  resources,
  ringResources,
}: {
  runtime: FleetRuntime
  table: InstanceSlotTable
  world: WorldTransform
  resources: VehicleResources
  ringResources: RingResources
}) {
  return (
    <>
      <VehicleInstances
        runtime={runtime}
        worldTransform={world}
        resources={resources}
        table={table}
        batchCount={1}
      />
      <VehicleRings
        runtime={runtime}
        worldTransform={world}
        table={table}
        batchCount={1}
        resources={ringResources}
      />
    </>
  )
}

describe('车辆光环图层（TASK-012）', () => {
  let renderer: TestRenderer | null = null
  let runtime: FleetRuntime
  let table: InstanceSlotTable
  let resources: VehicleResources
  let ringResources: RingResources

  const mount = async (strict = false): Promise<void> => {
    runtime = createFleetRuntime()
    table = createInstanceSlotTable()
    resources = createVehicleResources()
    ringResources = createRingResources()
    const tree = (
      <RingHarness
        runtime={runtime}
        table={table}
        world={makeWorld()}
        resources={resources}
        ringResources={ringResources}
      />
    )
    renderer = await ReactThreeTestRenderer.create(
      strict ? <StrictMode>{tree}</StrictMode> : tree,
    )
    await act(async () => {})
  }

  beforeEach(() => {
    renderer = null
    useFleetMonitoringStore.setState({ selectedKey: null, activeAlertKeys: new Set() })
  })

  afterEach(async () => {
    if (renderer !== null) {
      await act(async () => {
        await renderer!.unmount()
      })
      renderer = null
    }
    resources?.dispose()
    ringResources?.dispose()
    useFleetMonitoringStore.setState({ selectedKey: null, activeAlertKeys: new Set() })
  })

  it('FAULT 车下一帧出现 L2 红环；选中/L1 实例保持隐藏', async () => {
    await mount()
    runtime.applyEvent(
      snapshotEvent([snap('fault', { errorEntryList: [{ code: 'E1' }] })], 1_000),
    )
    await advance(renderer!, 2)

    const mesh = findMesh(renderer!, 'fleet-rings-b0')
    // 车辆槽位 0：L2 层（序 2）激活，选中（0）/L1（1）隐藏
    expect(ringScaleX(mesh, 0, 2)).toBeGreaterThan(0)
    expect(ringScaleX(mesh, 0, 0)).toBe(0)
    expect(ringScaleX(mesh, 0, 1)).toBe(0)
    expect(mesh.count).toBe(3) // 仅 L2 活跃：实例 2 为最大活跃序 → count 3
    // L2 层颜色 = 标签边框红（Float32 容差）
    const red = new THREE.Color(LABEL_BORDER_L2_COLOR)
    const [r, g, b] = ringColor(mesh, 0, 2)
    expect(r).toBeCloseTo(red.r, 6)
    expect(g).toBeCloseTo(red.g, 6)
    expect(b).toBeCloseTo(red.b, 6)
  })

  it('选中 + L1 + L2 可同时存在，实例半径从内到外单调递增且层色正确', async () => {
    await mount()
    const snapshot = snap('multi', {
      errorEntryList: [{ code: 'E1' }],
      batteryState: { batteryCharge: 20, batteryHealth: 100, batteryVoltage: 220, charging: false },
      agvPosition: { x: 100, y: 50, theta: 0, localizationScore: 0.4 },
    })
    runtime.applyEvent(snapshotEvent([snapshot], 1_000))
    useFleetMonitoringStore.getState().select(snapshot.entityKey)
    await advance(renderer!, 2)

    const mesh = findMesh(renderer!, 'fleet-rings-b0')
    const selected = ringScaleX(mesh, 0, 0)
    const l1 = ringScaleX(mesh, 0, 1)
    const l2 = ringScaleX(mesh, 0, 2)
    // 从内到外：选中 < L1 < L2（基准车 max(1.8,0.7)/1.8 = 1，缩放即层半径）
    expect(selected).toBeCloseTo(RING_LAYER_RADII_M[0], 6)
    expect(l1).toBeCloseTo(RING_LAYER_RADII_M[1], 6)
    expect(l2).toBeCloseTo(RING_LAYER_RADII_M[2], 6)
    // 层色：选中白（基色白材质默认）、L1 黄、L2 红
    const yellow = new THREE.Color(LABEL_BORDER_L1_COLOR)
    const [lr, lg, lb] = ringColor(mesh, 0, 1)
    expect(lr).toBeCloseTo(yellow.r, 6)
    expect(lg).toBeCloseTo(yellow.g, 6)
    expect(lb).toBeCloseTo(yellow.b, 6)
  })

  it('条件恢复下一帧移除：故障修复与取消选中当帧生效', async () => {
    await mount()
    const before = snap('recover', { errorEntryList: [{ code: 'E1' }] })
    runtime.applyEvent(snapshotEvent([before], 1_000))
    useFleetMonitoringStore.getState().select(before.entityKey)
    await advance(renderer!, 2)
    let mesh = findMesh(renderer!, 'fleet-rings-b0')
    expect(ringScaleX(mesh, 0, 0)).toBeGreaterThan(0)
    expect(ringScaleX(mesh, 0, 2)).toBeGreaterThan(0)

    // 修复故障 + 取消选中 → 下一帧全部移除
    runtime.applyEvent(updateEvent(snap('recover', { errorEntryList: [] }), 2_000, 2))
    useFleetMonitoringStore.getState().select(null)
    await advance(renderer!, 1)
    mesh = findMesh(renderer!, 'fleet-rings-b0')
    expect(ringScaleX(mesh, 0, 0)).toBe(0)
    expect(ringScaleX(mesh, 0, 2)).toBe(0)
    expect(mesh.count).toBe(0)
  })

  it('10s STALE 跃迁后出现 L2 红环（冻结数据按告警表达）', async () => {
    await mount()
    runtime.applyEvent(snapshotEvent([snap('stale')], 1_000))
    await advance(renderer!, 2)
    let mesh = findMesh(renderer!, 'fleet-rings-b0')
    expect(ringScaleX(mesh, 0, 2)).toBe(0)

    runtime.tick(11_000) // 超过默认 10s 阈值 → STALE → primary STALE → L2
    await advance(renderer!, 1)
    mesh = findMesh(renderer!, 'fleet-rings-b0')
    expect(ringScaleX(mesh, 0, 2)).toBeGreaterThan(0)
  })

  it('非法坐标车辆不放置车体也不放置任何环（SPEC §7.3）', async () => {
    await mount()
    runtime.applyEvent(
      snapshotEvent([
        snap('invalid', {
          errorEntryList: [{ code: 'E1' }],
          agvPosition: { x: Number.NaN, y: Number.NaN, theta: 0, localizationScore: 1 },
        }),
      ], 1_000),
    )
    await advance(renderer!, 2)
    const mesh = findMesh(renderer!, 'fleet-rings-b0')
    expect(ringScaleX(mesh, 0, 2)).toBe(0)
    expect(mesh.count).toBe(0)
  })

  it('删除车辆立即清场：实例零缩放、count 收缩为 0', async () => {
    await mount()
    const snapshot = snap('gone', { errorEntryList: [{ code: 'E1' }] })
    runtime.applyEvent(snapshotEvent([snapshot], 1_000))
    await advance(renderer!, 2)
    let mesh = findMesh(renderer!, 'fleet-rings-b0')
    expect(ringScaleX(mesh, 0, 2)).toBeGreaterThan(0)

    runtime.applyEvent(removeEvent(snapshot.mapId, snapshot.agvKey, 2_000))
    await advance(renderer!, 1)
    mesh = findMesh(renderer!, 'fleet-rings-b0')
    expect(ringScaleX(mesh, 0, 2)).toBe(0)
    expect(mesh.count).toBe(0)
  })

  it('每批次恒 1 个光环网格（车辆相关预算 7+2+1），StrictMode 双挂载不重复', async () => {
    await mount(true)
    expect(
      renderer!.scene.findAll((node) => toThree(node).name === 'fleet-rings-b0'),
    ).toHaveLength(1)
    expect(
      renderer!.scene.findAll((node) => toThree(node).name.startsWith('fleet-rings-')),
    ).toHaveLength(1)
  })
})
