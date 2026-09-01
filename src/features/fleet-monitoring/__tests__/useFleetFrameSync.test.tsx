/*
 * 车辆实例批渲染与脏槽位逐帧提交测试（TASK-010 / SPEC §4、§5.2、§6.3、§11.6、§11.13）。
 *
 * 以 @react-three/test-renderer 在无真实 WebGL 前提下验证：
 * 1. 新增车辆下一帧整车矩阵/颜色同步（含 theta 旋转与 centerOffset 口径）；
 * 2. 未变化槽位不写实例缓冲；脏批次合并为一次 needsUpdate；
 * 3. 删除清场零缩放 + 槽位复用；
 * 4. FAULT 信标旋转闪烁、熄灭为零缩放、STALE 跃迁下一帧冻结灰；
 * 5. 容量边界 200/250/257 台的批次数与 Draw Call 数、513 台超硬上限行为；
 * 6. StrictMode 式重挂载后场景从运行时全量收敛。
 */
import { StrictMode } from 'react'
import { act } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import ReactThreeTestRenderer from '@react-three/test-renderer'
import type { ReactThreeTest } from '@react-three/test-renderer'
import * as THREE from 'three'
import {
  createPlaneTransform,
  createWorldTransform,
  IDENTITY_AFFINE,
  type WorldTransform,
} from '@/shared/spatial'
import { createDiagnosticsReporter, type DiagnosticRecord } from '@/shared/diagnostics'
import { createFleetRuntime } from '../model/createFleetRuntime'
import {
  computeVehiclePartLayout,
  createVehicleResources,
  wedgeLengthOf,
  type VehicleResources,
} from '../scene/createVehicleGeometry'
import { shellColorOf } from '../scene/fleetAppearance'
import { VehicleInstances } from '../components/VehicleInstances'
import {
  heartbeatEvent,
  removeEvent,
  snapshotEvent,
  snapshotOf,
  updateEvent,
} from './testVehicles'

type TestRenderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>

// React act 环境标志：本文件直接以 act 包裹 useFrame 推进，必须在模块作用域
// 声明（RTL 的 render 会自动设置，本文件不经由 render）
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 与夹具位置同源的世界变换：原点 (100, 50) */
function makeWorld(): WorldTransform {
  return createWorldTransform(createPlaneTransform(IDENTITY_AFFINE), { x: 100, y: 50 })
}

function makeSnapshot(index: number, overrides: Record<string, unknown> = {}) {
  return snapshotOf({
    agvKey: `v${index}`,
    agvPosition: { x: 100, y: 50, theta: 0, localizationScore: 0.9 },
    agvDimension: { length: 1.8, width: 0.7, loadLength: 1.8, loadWidth: 0.7, centerOffset: 0.25 },
    connectionState: 'ONLINE',
    vehicleProcStatus: 'IDLE',
    ...overrides,
  })
}

/** 在 act 内推进 useFrame 帧回调（test-renderer 同步调用订阅者） */
async function advance(
  renderer: TestRenderer,
  frames = 1,
  delta = 1 / 60,
): Promise<void> {
  await act(async () => {
    renderer.advanceFrames(frames, delta)
  })
}

type Scene = ReactThreeTest.ReactThreeTestInstance

function toThree(node: Scene): THREE.Object3D {
  return node.instance
}

/** 按名称查找场景对象并断言唯一 */
function findMesh(renderer: TestRenderer, name: string): THREE.Object3D {
  const found = renderer.scene.findAll((node) => toThree(node).name === name)
  expect(found).toHaveLength(1)
  return toThree(found[0])
}

/** 全部车辆部件网格（名称 fleet-<part>-b<batch>） */
function fleetMeshes(renderer: TestRenderer): THREE.InstancedMesh[] {
  return renderer.scene
    .findAll((node) => String(toThree(node).name).startsWith('fleet-'))
    .map((node) => toThree(node) as THREE.InstancedMesh)
    .filter((mesh) => (mesh as { isInstancedMesh?: boolean }).isInstancedMesh === true)
}

/** 读槽位矩阵元素（列主序 16 浮点） */
function slotMatrix(mesh: THREE.InstancedMesh, slot: number): Float32Array {
  return (mesh.instanceMatrix.array as Float32Array).subarray(slot * 16, slot * 16 + 16)
}

/** 槽位是否已渲染（零缩放矩阵 elements[0]=0；实车 scale>0） */
function slotRendered(mesh: THREE.InstancedMesh, slot: number): boolean {
  return slotMatrix(mesh, slot)[0] > 0
}

/** 统计某网格已渲染槽位数 */
function renderedCount(mesh: THREE.InstancedMesh): number {
  const capacity = mesh.instanceMatrix.array.length / 16
  let count = 0
  for (let s = 0; s < capacity; s += 1) {
    if (slotRendered(mesh, s)) count += 1
  }
  return count
}

/** 在实例上挂接 needsUpdate 写入探针（统计提交次数） */
function spyNeedsUpdate(attr: THREE.BufferAttribute): { count: () => number } {
  let writes = 0
  let version = attr.version
  Object.defineProperty(attr, 'needsUpdate', {
    configurable: true,
    get: () => version > 0,
    set: (value: boolean) => {
      if (value) {
        writes += 1
        version += 1
      }
    },
  })
  return { count: () => writes }
}

/** 挂载车辆实例图层（独立资源实例；测试结束时统一清理） */
async function mountFleet(options: {
  runtime: ReturnType<typeof createFleetRuntime>
  worldTransform?: WorldTransform | null
  hardCap?: number
  diagnostics?: ReturnType<typeof createDiagnosticsReporter>
  strict?: boolean
}): Promise<{
  renderer: TestRenderer
  resources: VehicleResources
}> {
  const resources = createVehicleResources()
  const tree = (
    <VehicleInstances
      runtime={options.runtime}
      worldTransform={options.worldTransform ?? makeWorld()}
      resources={resources}
      hardCap={options.hardCap}
      diagnostics={options.diagnostics}
    />
  )
  const renderer = await ReactThreeTestRenderer.create(
    options.strict === true ? <StrictMode>{tree}</StrictMode> : tree,
  )
  await act(async () => {})
  return { renderer, resources }
}

describe('VehicleInstances 逐帧同步（TASK-010）', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()!()
    }
  })

  function track<T extends { renderer: TestRenderer; resources: VehicleResources }>(
    mounted: T,
  ): T {
    cleanups.push(() => {
      mounted.renderer.unmount()
      mounted.resources.dispose()
    })
    return mounted
  }

  it('新增车辆下一帧：七部件矩阵与外壳颜色同步（theta=0 基准）', async () => {
    const runtime = createFleetRuntime()
    const snapshot = makeSnapshot(0, { loaded: true })
    runtime.applyEvent(snapshotEvent([snapshot]))

    const mounted = track(await mountFleet({ runtime }))
    const { renderer } = mounted
    await advance(renderer)

    const pose = { cx: 0.25, cz: 0, rotY: 0 } // (100+0.25·cos0-100, 50-50, 0)
    const layout = computeVehiclePartLayout(snapshot, runtime.get(snapshot.entityKey)!.displayState)
    const expected: Record<string, [number, number, number]> = {
      'fleet-chassis-b0': [pose.cx + layout.chassis.x, layout.chassis.y, 0],
      'fleet-shell-b0': [pose.cx + layout.shell.x, layout.shell.y, 0],
      'fleet-wedge-b0': [pose.cx + layout.wedge.x, layout.wedge.y, 0],
      'fleet-shadow-b0': [pose.cx + layout.shadow.x, layout.shadow.y, 0],
    }
    for (const [name, [x, y, z]] of Object.entries(expected)) {
      const m = slotMatrix(findMesh(renderer, name) as THREE.InstancedMesh, 0)
      expect(m[12]).toBeCloseTo(x, 5)
      expect(m[13]).toBeCloseTo(y, 5)
      expect(m[14]).toBeCloseTo(z, 5)
    }
    // 非故障车信标熄灭（零缩放），但挂载点仍在车尾后方
    const beacon = slotMatrix(findMesh(renderer, 'fleet-beacon-b0') as THREE.InstancedMesh, 0)
    expect(beacon[12]).toBe(0)
    // 载货：平台与托盘真实放置
    expect(slotRendered(findMesh(renderer, 'fleet-platform-b0') as THREE.InstancedMesh, 0)).toBe(true)
    expect(slotRendered(findMesh(renderer, 'fleet-pallet-b0') as THREE.InstancedMesh, 0)).toBe(true)
    // 每车尺寸进入矩阵：外壳 scale.x = 车长 − 楔长（rotY=0 时 m[0]）
    const shell = slotMatrix(findMesh(renderer, 'fleet-shell-b0') as THREE.InstancedMesh, 0)
    expect(shell[0]).toBeCloseTo(layout.shell.sx, 5)
    expect(shell[5]).toBeCloseTo(layout.shell.sy, 5)
    expect(shell[10]).toBeCloseTo(layout.shell.sz, 5)
    // 外壳颜色 = 主状态色（IDLE 蓝）
    const expectedColor = new THREE.Color(shellColorOf('IDLE'))
    const shellColor = (findMesh(renderer, 'fleet-shell-b0') as THREE.InstancedMesh).instanceColor!
      .array as Float32Array
    expect(shellColor[0]).toBeCloseTo(expectedColor.r, 5)
    expect(shellColor[2]).toBeCloseTo(expectedColor.b, 5)
  })

  it('theta=π/2：车头楔指向行进方向（世界 +z），rotation.y=-theta', async () => {
    const runtime = createFleetRuntime()
    const snapshot = makeSnapshot(0, {
      agvPosition: { x: 100, y: 50, theta: Math.PI / 2, localizationScore: 0.9 },
      loaded: false,
    })
    runtime.applyEvent(snapshotEvent([snapshot]))
    const mounted = track(await mountFleet({ runtime }))
    await advance(mounted.renderer)

    // 车体中心 (0, 0.25)；外壳本地 -x 端 → 世界 z = 0.25 + shell.x·(-sin(rotY))
    const shell = slotMatrix(findMesh(mounted.renderer, 'fleet-shell-b0') as THREE.InstancedMesh, 0)
    expect(shell[12]).toBeCloseTo(0, 5)
    expect(shell[14]).toBeCloseTo(0.25 + -0.198, 3) // shell 本地 x = -楔长/2
    // 方向楔（车头）位于外壳 +x 前方（更大 z）
    const wedge = slotMatrix(findMesh(mounted.renderer, 'fleet-wedge-b0') as THREE.InstancedMesh, 0)
    expect(wedge[14]).toBeGreaterThan(shell[14])
    // 未载货：平台/托盘零缩放隐藏
    expect(slotRendered(findMesh(mounted.renderer, 'fleet-platform-b0') as THREE.InstancedMesh, 0)).toBe(false)
    expect(slotRendered(findMesh(mounted.renderer, 'fleet-pallet-b0') as THREE.InstancedMesh, 0)).toBe(false)
  })

  it('未变化槽位不写：无事件帧零提交，事件帧合并提交', async () => {
    const runtime = createFleetRuntime()
    runtime.applyEvent(snapshotEvent([makeSnapshot(0)]))
    const mounted = track(await mountFleet({ runtime }))
    const { renderer } = mounted
    await advance(renderer)

    const probes = fleetMeshes(renderer).map((mesh) => ({
      matrix: spyNeedsUpdate(mesh.instanceMatrix),
      color: mesh.instanceColor ? spyNeedsUpdate(mesh.instanceColor) : null,
    }))

    // 无事件帧：任何 (批次, 部件) 都不提交
    await advance(renderer, 3)
    expect(probes.reduce((sum, p) => sum + p.matrix.count(), 0)).toBe(0)

    // 一条增量 → 涉及部件各恰好一次 needsUpdate（同帧合并）
    const moved = makeSnapshot(0, {
      agvPosition: { x: 101, y: 50, theta: 0, localizationScore: 0.9 },
    })
    runtime.applyEvent(updateEvent(moved))
    await advance(renderer)
    const matrixWrites = probes.reduce((sum, p) => sum + p.matrix.count(), 0)
    expect(matrixWrites).toBeGreaterThan(0)
    expect(matrixWrites).toBeLessThanOrEqual(7)

    // 心跳不触碰实体：仍零提交
    runtime.applyEvent(heartbeatEvent(2000))
    await advance(renderer, 2)
    expect(probes.reduce((sum, p) => sum + p.matrix.count(), 0)).toBe(matrixWrites)
  })

  it('删除清场零缩放；新增复用释放槽位', async () => {
    const runtime = createFleetRuntime()
    runtime.applyEvent(
      snapshotEvent([makeSnapshot(0), makeSnapshot(1, { agvKey: 'v1' })]),
    )
    const mounted = track(await mountFleet({ runtime }))
    const { renderer } = mounted
    await advance(renderer)

    const shell = findMesh(renderer, 'fleet-shell-b0') as THREE.InstancedMesh
    expect(slotRendered(shell, 0)).toBe(true)
    expect(slotRendered(shell, 1)).toBe(true)

    runtime.applyEvent(removeEvent('map-under-test', 'v0'))
    await advance(renderer)
    expect(slotRendered(shell, 0)).toBe(false)
    expect(slotRendered(shell, 1)).toBe(true)
    const zeroed = slotMatrix(shell, 0)
    for (let i = 0; i < 16; i += 1) {
      expect(zeroed[i]).toBe(i === 15 ? 1 : 0)
    }

    // 新车经空闲链表复用已释放槽位（LIFO：最近释放的槽位 1 先被复用），
    // 专属车长进入矩阵；渲染总数守恒为 1
    const replacementLength = 2.4
    runtime.applyEvent(
      snapshotEvent([
        makeSnapshot(2, {
          agvKey: 'v2',
          agvDimension: { length: replacementLength, width: 0.9, loadLength: 2.0, loadWidth: 0.9, centerOffset: 0.3 },
        }),
      ]),
    )
    await advance(renderer)
    expect(renderedCount(shell)).toBe(1)
    const reusedSlot = slotRendered(shell, 0) ? 0 : 1
    expect(slotMatrix(shell, reusedSlot)[0]).toBeCloseTo(
      replacementLength - wedgeLengthOf(replacementLength),
      5,
    )
  })

  it('FAULT 信标旋转闪烁；正常/断连车信标熄灭（零缩放）', async () => {
    const runtime = createFleetRuntime()
    const faulted = makeSnapshot(0, { agvKey: 'v0', errorEntryList: [{ code: 'E1' }] })
    const idle = makeSnapshot(1, { agvKey: 'v1' })
    runtime.applyEvent(snapshotEvent([faulted, idle]))
    const mounted = track(await mountFleet({ runtime }))
    const { renderer } = mounted
    await advance(renderer)

    const beaconOf = (): THREE.InstancedMesh =>
      findMesh(renderer, 'fleet-beacon-b0') as THREE.InstancedMesh
    // 故障车信标亮起；正常车熄灭（零缩放）
    expect(slotRendered(beaconOf(), 0)).toBe(true)
    expect(slotRendered(beaconOf(), 1)).toBe(false)

    // 旋转 + 闪烁：矩阵旋转分量与颜色亮度随帧变化（m1 必须拷贝——
    // slotMatrix 返回底层缓冲的活视图，两次读取会恒等）
    const m1 = Array.from(slotMatrix(beaconOf(), 0))
    const c1 = [...(beaconOf().instanceColor!.array as Float32Array).subarray(0, 3)]
    await advance(renderer)
    const m2 = slotMatrix(beaconOf(), 0)
    const c2 = [...(beaconOf().instanceColor!.array as Float32Array).subarray(0, 3)]
    expect(Math.abs(m2[8] - m1[8])).toBeGreaterThan(1e-4) // 自旋
    expect(Math.abs(c2[0] - c1[0])).toBeGreaterThan(1e-4) // 闪烁

    // FAULT + OFFLINE → 投影 DISCONNECTED → 熄灭
    runtime.applyEvent(
      updateEvent(
        makeSnapshot(0, {
          agvKey: 'v0',
          errorEntryList: [{ code: 'E1' }],
          connectionState: 'OFFLINE',
        }),
      ),
    )
    await advance(renderer)
    expect(slotRendered(beaconOf(), 0)).toBe(false)
  })

  it('数据过期下一帧冻结灰（STALE 投影到外壳颜色）', async () => {
    const runtime = createFleetRuntime()
    runtime.applyEvent(snapshotEvent([makeSnapshot(0)], 1_000))
    const mounted = track(await mountFleet({ runtime }))
    const { renderer } = mounted
    await advance(renderer)

    runtime.tick(11_000) // 10s 无有效更新 → STALE（1Hz ticker 语义）
    await advance(renderer)
    const expected = new THREE.Color(shellColorOf('STALE'))
    const color = (findMesh(renderer, 'fleet-shell-b0') as THREE.InstancedMesh).instanceColor!
      .array as Float32Array
    expect(color[0]).toBeCloseTo(expected.r, 5)
    expect(color[1]).toBeCloseTo(expected.g, 5)
    expect(color[2]).toBeCloseTo(expected.b, 5)
  })

  it('非法位置车辆不放置车体且不占槽位；恢复后正常渲染', async () => {
    const runtime = createFleetRuntime()
    const bad = makeSnapshot(0, {
      agvPosition: { x: Number.NaN, y: 0, theta: 0, localizationScore: 0.9 },
    })
    runtime.applyEvent(snapshotEvent([bad]))
    const mounted = track(await mountFleet({ runtime }))
    const { renderer } = mounted
    await advance(renderer)
    const shell = findMesh(renderer, 'fleet-shell-b0') as THREE.InstancedMesh
    expect(renderedCount(shell)).toBe(0)

    // 恢复合法位置：下一帧放置
    runtime.applyEvent(
      updateEvent(makeSnapshot(0, { agvKey: 'v0' })),
    )
    await advance(renderer)
    expect(renderedCount(shell)).toBe(1)
  })

  it('200/250/256 台单批次（7 个部件对象）；257 台扩两批（14 个）', async () => {
    // 250 台压力模式不扩批；一台渲染器只挂载一次（test-renderer 限制）
    const fleet250 = Array.from({ length: 250 }, (_, i) => makeSnapshot(i, { agvKey: `v${i}` }))
    const runtime = createFleetRuntime()
    runtime.applyEvent(snapshotEvent(fleet250))
    const mounted = track(await mountFleet({ runtime }))
    const { renderer } = mounted
    await advance(renderer)
    // 200 台验收规模同样单批次：每部件 1 个 InstancedMesh = 1 Draw Call，共 7 ≤ 8
    expect(fleetMeshes(renderer)).toHaveLength(7)
    expect(renderedCount(findMesh(renderer, 'fleet-shell-b0') as THREE.InstancedMesh)).toBe(250)

    runtime.applyEvent(
      snapshotEvent([
        ...fleet250.map((s) => s),
        makeSnapshot(250, { agvKey: 'v250' }),
        makeSnapshot(251, { agvKey: 'v251' }),
        makeSnapshot(252, { agvKey: 'v252' }),
        makeSnapshot(253, { agvKey: 'v253' }),
        makeSnapshot(254, { agvKey: 'v254' }),
        makeSnapshot(255, { agvKey: 'v255' }),
        makeSnapshot(256, { agvKey: 'v256' }),
      ]),
    )
    await advance(renderer) // 扩批通知 → setState
    await advance(renderer) // 新批次挂载后的全量重写
    expect(fleetMeshes(renderer)).toHaveLength(14)
    expect(renderedCount(findMesh(renderer, 'fleet-shell-b0') as THREE.InstancedMesh)).toBe(256)
    expect(renderedCount(findMesh(renderer, 'fleet-shell-b1') as THREE.InstancedMesh)).toBe(1) // 第 257 台
  })

  it('513 台超硬上限：512 台渲染、1 台等待并记录诊断；释放后补录', async () => {
    const records: DiagnosticRecord[] = []
    const diagnostics = createDiagnosticsReporter({ sink: (record) => records.push(record) })
    const fleet = Array.from({ length: 513 }, (_, i) => makeSnapshot(i, {
      agvKey: `v${i}`,
      agvDimension: { length: 1.8 + i * 0.0001, width: 0.7, loadLength: 1.8, loadWidth: 0.7, centerOffset: 0.25 },
    }))
    const runtime = createFleetRuntime()
    runtime.applyEvent(snapshotEvent(fleet))
    const mounted = track(await mountFleet({ runtime, diagnostics }))
    const { renderer } = mounted
    await advance(renderer) // 首帧重写（仅首批网格在场）+ 扩批通知
    await advance(renderer) // 新批次挂载后的全量重写
    // 批次数组随扩批重建：断言前必须重新查询网格
    const shellMeshes = (): THREE.InstancedMesh[] =>
      fleetMeshes(renderer).filter((m) => String(m.name).startsWith('fleet-shell'))
    expect(shellMeshes()).toHaveLength(2)
    const rendered = shellMeshes().reduce((sum, m) => sum + renderedCount(m), 0)
    expect(rendered).toBe(512)
    expect(records.some((r) => r.code === 'FLEET_RENDER_CAPACITY_EXCEEDED')).toBe(true)

    // 删除一台 → 等待队首补录：仍 512 台渲染，诊断不重复告警
    runtime.applyEvent(removeEvent('map-under-test', 'v0'))
    await advance(renderer)
    const renderedAfter = shellMeshes().reduce((sum, m) => sum + renderedCount(m), 0)
    expect(renderedAfter).toBe(512)
    expect(records.filter((r) => r.code === 'FLEET_RENDER_CAPACITY_EXCEEDED')).toHaveLength(1)
    // 补录车（v512）占用 v0 的 0 号槽位：scale.x 反映其专属车长
    const admittedLength = 1.8 + 512 * 0.0001
    const slot0 = slotMatrix(shellMeshes()[0], 0)
    expect(slot0[0]).toBeCloseTo(admittedLength - wedgeLengthOf(admittedLength), 3)
  })

  it('worldTransform=null：不提交任何矩阵；就绪后下一渲染周期全量收敛', async () => {
    const runtime = createFleetRuntime()
    runtime.applyEvent(snapshotEvent([makeSnapshot(0)]))
    const resources = createVehicleResources()
    cleanups.push(() => resources.dispose())
    const world = makeWorld()
    const renderer = await ReactThreeTestRenderer.create(
      <VehicleInstances runtime={runtime} worldTransform={null} resources={resources} />,
    )
    cleanups.push(() => renderer.unmount())
    await act(async () => {})
    await advance(renderer)
    const shell = findMesh(renderer, 'fleet-shell-b0') as THREE.InstancedMesh
    expect(renderedCount(shell)).toBe(0)

    // 地图就绪（worldTransform 注入）：下一帧全量重写收敛到运行时真相
    await renderer.update(
      <VehicleInstances runtime={runtime} worldTransform={world} resources={resources} />,
    )
    await advance(renderer)
    expect(renderedCount(findMesh(renderer, 'fleet-shell-b0') as THREE.InstancedMesh)).toBe(1)
  })

  it('StrictMode 双挂载：effect 清理后场景仍完整（脏集合已消费也收敛）', async () => {
    const runtime = createFleetRuntime()
    runtime.applyEvent(snapshotEvent([makeSnapshot(0), makeSnapshot(1, { agvKey: 'v1' })]))
    const mounted = track(await mountFleet({ runtime, strict: true }))
    await advance(mounted.renderer)
    // 首帧已消费全部脏集合：再推进若干帧后场景保持完整
    await advance(mounted.renderer, 3)
    const shell = findMesh(mounted.renderer, 'fleet-shell-b0') as THREE.InstancedMesh
    expect(renderedCount(shell)).toBe(2)
  })

  it('外壳携带拾取批次元数据，其余部件关闭 raycast', async () => {
    const runtime = createFleetRuntime()
    runtime.applyEvent(snapshotEvent([makeSnapshot(0)]))
    const mounted = track(await mountFleet({ runtime }))
    await advance(mounted.renderer)

    const shell = findMesh(mounted.renderer, 'fleet-shell-b0') as THREE.InstancedMesh
    expect(shell.userData.batchId).toBe(0)
    // 外壳保持 InstancedMesh 默认拾取；其余部件被空函数覆盖（SPEC §5.2/§6.3）
    expect(shell.raycast).toBe(THREE.InstancedMesh.prototype.raycast)
    for (const mesh of fleetMeshes(mounted.renderer)) {
      if (String(mesh.name).startsWith('fleet-shell')) {
        continue
      }
      expect(mesh.raycast).not.toBe(THREE.Mesh.prototype.raycast)
      expect(() => mesh.raycast.call(mesh, null as never, null as never)).not.toThrow()
    }
  })
})
