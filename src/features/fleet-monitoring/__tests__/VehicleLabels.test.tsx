/*
 * 车辆标签图层测试（TASK-011 / SPEC §5.1、§6.4、§7.2、§7.3）。
 *
 * 以 @react-three/test-renderer 在无真实 WebGL 前提下验证（图集工厂注入假
 * 实现，单元账本与 UV 查表走生产代码）：
 * 1. 快照下一帧标签可见：矩阵锚点/尺寸、名称进图集、底色/电量/芯片/UV 属性；
 * 2. 电量与状态变化不重绘名称纹理（图集零重绘、零上载）；
 * 3. 名称变化只重绘目标单元；STALE 副徽标保留最后业务状态；
 * 4. 删除清场零缩放 + 图集单元回收 + 槽位复用；
 * 5. LOD 分级（相机机位 → 独立投影换算 → 档位断言）与远景重点 20 上限、
 *    选中车在远景始终可见；
 * 6. 每批次恒 2 个标签 Draw Call（网格数）、批次扩容网格数翻倍；
 * 7. 图集不可用整层降级 + 结构化诊断；StrictMode 双挂载资源对称释放。
 */
import { StrictMode } from 'react'
import { act } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import ReactThreeTestRenderer from '@react-three/test-renderer'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import {
  createPlaneTransform,
  createWorldTransform,
  IDENTITY_AFFINE,
  type WorldTransform,
} from '@/shared/spatial'
import { createDiagnosticsReporter, type DiagnosticRecord } from '@/shared/diagnostics'
import { createFleetRuntime, type FleetRuntime } from '../model/createFleetRuntime'
import { createInstanceSlotTable, type InstanceSlotTable } from '../model/instanceSlots'
import { useFleetMonitoringStore } from '../model/fleetMonitoringStore'
import {
  createLabelCellBook,
  labelCellUv,
  badgeChipUv,
  LABEL_ATLAS_CELLS,
  type VehicleBadgeAtlas,
  type VehicleLabelAtlas,
} from '../scene/labelAtlas'
import { LABEL_ANCHOR_Y_M, LABEL_FULL_MIN_PX, LABEL_HEIGHT_M, LABEL_NAME_MIN_PX, LABEL_WIDTH_M, shellColorOf } from '../scene/fleetAppearance'
import { labelLevelForPixels } from '../scene/labelLod'
import { VehicleLabels } from '../components/VehicleLabels'
import { FleetMonitoringFeature } from '../components/FleetMonitoringFeature'
import { FleetRuntimeProvider } from '../components/FleetRuntimeProvider'
import { snapshotEvent, snapshotOf, updateEvent, removeEvent } from './testVehicles'

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

function findMeshes(renderer: TestRenderer, prefix: string): THREE.InstancedMesh[] {
  return renderer.scene
    .findAll((node) => String(toThree(node).name).startsWith(prefix))
    .map((node) => toThree(node) as THREE.InstancedMesh)
}

/** 读标签网格的实例属性数组 */
function attrOf(mesh: THREE.InstancedMesh, name: string): Float32Array {
  return (mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute)
    .array as Float32Array
}

/** 槽位是否可见（零缩放矩阵 elements[0]=0；可见 scale>0） */
function slotShown(mesh: THREE.InstancedMesh, slot: number): boolean {
  return (mesh.instanceMatrix.array as Float32Array)[slot * 16] > 0
}

function shownCount(mesh: THREE.InstancedMesh): number {
  let count = 0
  for (let s = 0; s < LABEL_ATLAS_CELLS; s += 1) {
    if (slotShown(mesh, s)) count += 1
  }
  return count
}

/** 独立投影换算：车长线段沿相机右轴的屏幕像素长度（与实现互为交叉验证） */
function projectedPx(
  camera: THREE.PerspectiveCamera,
  viewportWidth: number,
  x: number,
  y: number,
  z: number,
  lengthM: number,
): number {
  camera.updateMatrixWorld(true)
  const a = new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse)
  const b = a.clone()
  b.x += lengthM
  a.applyMatrix4(camera.projectionMatrix)
  b.applyMatrix4(camera.projectionMatrix)
  return Math.abs(b.x - a.x) * 0.5 * viewportWidth
}

/* ==================== 假图集工厂（账本与 UV 走生产代码） ==================== */

interface FakeLabelAtlas {
  atlas: VehicleLabelAtlas
  painted: [number, string | null][]
  uploads: () => number
  isDisposed: () => boolean
}

function makeFakeLabelAtlas(): FakeLabelAtlas {
  const painted: [number, string | null][] = []
  let uploads = 0
  let disposed = false
  const book = createLabelCellBook(LABEL_ATLAS_CELLS, (slot, text) => {
    painted.push([slot, text])
  })
  const texture = new THREE.Texture()
  const atlas: VehicleLabelAtlas = {
    texture,
    book,
    cellUv: (slot) => labelCellUv(slot),
    flush() {
      if (book.flushDirty() > 0) {
        uploads += 1
      }
    },
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      book.dispose()
    },
  }
  return { atlas, painted, uploads: () => uploads, isDisposed: () => disposed }
}

function makeFakeBadgeAtlas(): { atlas: VehicleBadgeAtlas; isDisposed: () => boolean } {
  let disposed = false
  return {
    atlas: {
      texture: new THREE.Texture(),
      dispose() {
        disposed = true
      },
    },
    isDisposed: () => disposed,
  }
}

/** 相机与视口探针：LOD 用例以独立投影换算交叉验证档位 */
let probeCamera: THREE.PerspectiveCamera | null = null
let probeViewportWidth = 0

function CameraProbe(): null {
  const camera = useThree((state) => state.camera)
  const size = useThree((state) => state.size)
  probeCamera = camera as THREE.PerspectiveCamera
  probeViewportWidth = size.width
  return null
}

/** 挂载标签图层（假图集；槽位由测试显式 acquire 模拟车体层行为） */
async function mountLabels(options: {
  runtime: FleetRuntime
  table: InstanceSlotTable
  batchCount?: number
  worldTransform?: WorldTransform | null
  strict?: boolean
  breakBadgeAtlas?: boolean
  importantLabelsOnly?: boolean
}): Promise<{
  renderer: TestRenderer
  fakes: FakeLabelAtlas[]
  badgeDisposed: () => boolean
  records: DiagnosticRecord[]
}> {
  const fakes: FakeLabelAtlas[] = []
  const badge = makeFakeBadgeAtlas()
  const records: DiagnosticRecord[] = []
  const diagnostics = createDiagnosticsReporter({ sink: (record) => records.push(record) })
  const tree = (
    <>
      <CameraProbe />
      <VehicleLabels
        runtime={options.runtime}
        worldTransform={options.worldTransform === undefined ? makeWorld() : options.worldTransform}
        table={options.table}
        batchCount={options.batchCount ?? 1}
        importantLabelsOnly={options.importantLabelsOnly}
        createLabelAtlas={() => {
          const fake = makeFakeLabelAtlas()
          fakes.push(fake)
          return fake.atlas
        }}
        createBadgeAtlas={
          options.breakBadgeAtlas === true
            ? () => {
                throw new Error('badge unavailable')
              }
            : () => badge.atlas
        }
        diagnostics={diagnostics}
      />
    </>
  )
  const renderer = await ReactThreeTestRenderer.create(
    options.strict === true ? <StrictMode>{tree}</StrictMode> : tree,
  )
  await act(async () => {})
  return { renderer, fakes, badgeDisposed: () => badge.isDisposed(), records }
}

describe('VehicleLabels 逐帧同步（TASK-011）', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    // 卸载必须逐个 await：悬浮的 unmount promise 会与下一个用例的 create
    // 交错（React 并发渲染），造成跨用例污染
    while (cleanups.length > 0) {
      await cleanups.pop()!()
    }
    useFleetMonitoringStore.setState({ selectedKey: null })
  })

  function track<T>(mounted: T): T {
    cleanups.push(() => {
      const renderer = (mounted as { renderer: TestRenderer }).renderer
      return Promise.resolve(renderer.unmount())
    })
    return mounted
  }

  it('快照下一帧标签可见：锚点/尺寸矩阵、名称进图集、底色/芯片/UV 属性同步', async () => {
    const runtime = createFleetRuntime()
    const snapshot = snap('v0')
    runtime.applyEvent(snapshotEvent([snapshot]))
    const table = createInstanceSlotTable()
    const mounted = track(await mountLabels({ runtime, table }))
    const { renderer, fakes } = mounted
    table.acquire(snapshot.entityKey)
    await advance(renderer)

    const bg = findMesh(renderer, 'fleet-label-bg-b0')
    const text = findMesh(renderer, 'fleet-label-text-b0')
    // 标签锚点：车体中心上方（theta=0 → cx=0.25, cz=0；y=锚点高度）
    const bgMatrix = (bg.instanceMatrix.array as Float32Array).subarray(0, 16)
    expect(bgMatrix[12]).toBeCloseTo(0.25, 5)
    expect(bgMatrix[13]).toBeCloseTo(LABEL_ANCHOR_Y_M, 5)
    expect(bgMatrix[14]).toBeCloseTo(0, 5)
    // 名称单元 4:1 宽高比进入矩阵 scale（列主序 m[0]）
    expect(bgMatrix[0]).toBeCloseTo(LABEL_WIDTH_M, 5)
    expect(bgMatrix[5]).toBeCloseTo(LABEL_HEIGHT_M, 5)
    // 两层网格矩阵一致（可见性一体）
    const textMatrix = (text.instanceMatrix.array as Float32Array).subarray(0, 16)
    expect(Array.from(textMatrix)).toEqual(Array.from(bgMatrix))

    // 名称写入 0 号图集单元（槽位即单元）
    expect(fakes[0].painted).toEqual([[0, '名称-v0']])
    const nameUv = attrOf(text, 'aNameUv').subarray(0, 4)
    const cell = labelCellUv(0)
    expect(nameUv[0]).toBeCloseTo(cell.u0, 12)
    expect(nameUv[1]).toBeCloseTo(cell.v0, 12)
    expect(nameUv[2]).toBeCloseTo(cell.u1, 12)
    expect(nameUv[3]).toBeCloseTo(cell.v1, 12)

    // 默认机位（近景）下投影 ≥20px → 完整档；底色 = IDLE 业务蓝
    const level = attrOf(bg, 'aLevel')[0]
    const expectedLevel = labelLevelForPixels(
      projectedPx(probeCamera!, probeViewportWidth, 0.25, LABEL_ANCHOR_Y_M, 0, 1.8),
    )
    expect(level).toBe(expectedLevel)
    expect(level).toBe(2)
    const stateColor = attrOf(bg, 'aStateColor').subarray(0, 3)
    const expectedColor = new THREE.Color(shellColorOf('IDLE'))
    expect(stateColor[0]).toBeCloseTo(expectedColor.r, 5)
    expect(stateColor[2]).toBeCloseTo(expectedColor.b, 5)
    // FRESH IDLE：芯片 = 业务主状态，无告警、未选中
    const chipUv = attrOf(bg, 'aChipUv').subarray(0, 4)
    expect(Array.from(chipUv)).toEqual(Array.from(badgeChipUv('IDLE')))
    const overlay = attrOf(bg, 'aOverlay').subarray(0, 2)
    expect(overlay[0]).toBe(0)
    expect(overlay[1]).toBe(0)
  })

  it('电量/状态变化只写实例属性：名称纹理零重绘、图集零上载', async () => {
    const runtime = createFleetRuntime()
    const snapshot = snap('v0', { batteryState: { batteryCharge: 80, batteryHealth: 100, batteryVoltage: 220, charging: false } })
    runtime.applyEvent(snapshotEvent([snapshot]))
    const table = createInstanceSlotTable()
    const mounted = track(await mountLabels({ runtime, table }))
    const { renderer, fakes } = mounted
    table.acquire(snapshot.entityKey)
    await advance(renderer)
    expect(fakes[0].painted).toHaveLength(1)
    const uploadsBefore = fakes[0].uploads()

    // 同名 + 电量/过程状态变化：aCharge/aStateColor/aChipUv 更新，图集不动
    runtime.applyEvent(
      updateEvent(
        snap('v0', {
          batteryState: { batteryCharge: 42, batteryHealth: 100, batteryVoltage: 220, charging: false },
          vehicleProcStatus: 'TRAFFIC',
        }),
        2_000,
      ),
    )
    await advance(renderer)

    expect(fakes[0].painted).toHaveLength(1) // 名称纹理零重绘
    expect(fakes[0].uploads()).toBe(uploadsBefore) // 零上载
    const bg = findMesh(renderer, 'fleet-label-bg-b0')
    expect(attrOf(bg, 'aCharge')[0]).toBeCloseTo(0.42, 5)
    const stateColor = attrOf(bg, 'aStateColor').subarray(0, 3)
    const trafficColor = new THREE.Color(shellColorOf('TRAFFIC_WAIT'))
    expect(stateColor[0]).toBeCloseTo(trafficColor.r, 5)
    expect(Array.from(attrOf(bg, 'aChipUv').subarray(0, 4))).toEqual(
      Array.from(badgeChipUv('TRAFFIC_WAIT')),
    )
  })

  it('名称变化只重绘目标单元并触发一次图集上载', async () => {
    const runtime = createFleetRuntime()
    const v0 = snap('v0')
    const v1 = snap('v1')
    runtime.applyEvent(snapshotEvent([v0, v1]))
    const table = createInstanceSlotTable()
    const mounted = track(await mountLabels({ runtime, table }))
    const { renderer, fakes } = mounted
    table.acquire(v0.entityKey)
    table.acquire(v1.entityKey)
    await advance(renderer)
    expect(fakes[0].painted).toEqual([
      [0, '名称-v0'],
      [1, '名称-v1'],
    ])

    // 只改 v0 名称：仅重绘 0 号单元
    runtime.applyEvent(updateEvent(snap('v0', { agvName: '改名车' }), 2_000))
    await advance(renderer)
    expect(fakes[0].painted.slice(2)).toEqual([[0, '改名车']])
    expect(fakes[0].uploads()).toBe(2) // 初次建图 1 次 + 改名 1 次
  })

  it('STALE 下一帧冻结灰并保留最后业务状态副徽标（L2 告警边框）', async () => {
    const runtime = createFleetRuntime()
    const snapshot = snap('v0')
    runtime.applyEvent(snapshotEvent([snapshot], 1_000))
    const table = createInstanceSlotTable()
    const mounted = track(await mountLabels({ runtime, table }))
    const { renderer } = mounted
    table.acquire(snapshot.entityKey)
    await advance(renderer)

    runtime.tick(11_000) // 10s 无有效更新 → STALE（1Hz ticker 语义）
    await advance(renderer)

    const bg = findMesh(renderer, 'fleet-label-bg-b0')
    const staleColor = new THREE.Color(shellColorOf('STALE'))
    const stateColor = attrOf(bg, 'aStateColor').subarray(0, 3)
    expect(stateColor[0]).toBeCloseTo(staleColor.r, 5)
    // 副徽标 = 最后已知业务状态 IDLE
    expect(Array.from(attrOf(bg, 'aChipUv').subarray(0, 4))).toEqual(
      Array.from(badgeChipUv('IDLE')),
    )
    // STALE 属 L2：告警边框级为 2
    expect(attrOf(bg, 'aOverlay')[1]).toBe(2)
  })

  it('删除清场零缩放并回收图集单元；新车复用槽位后重绘同一单元', async () => {
    const runtime = createFleetRuntime()
    const v0 = snap('v0')
    const v1 = snap('v1')
    runtime.applyEvent(snapshotEvent([v0, v1]))
    const table = createInstanceSlotTable()
    const mounted = track(await mountLabels({ runtime, table }))
    const { renderer, fakes } = mounted
    table.acquire(v0.entityKey)
    table.acquire(v1.entityKey)
    await advance(renderer)
    const bg = findMesh(renderer, 'fleet-label-bg-b0')
    expect(slotShown(bg, 0)).toBe(true)
    expect(slotShown(bg, 1)).toBe(true)

    // 删除 v0：车体层（useFleetFrameSync）消费 dirty.removed 释放槽位；
    // 本测试独立于车体层，显式 release 模拟同帧时序
    runtime.applyEvent(removeEvent('map-under-test', 'v0'))
    table.release(v0.entityKey)
    await advance(renderer)
    expect(slotShown(bg, 0)).toBe(false)
    expect(fakes[0].atlas.book.textAt(0)).toBe(null)

    // 新车经槽位表空闲复用获得 0 号槽位：标签落在同一单元并重绘新名称
    const v2 = snap('v2')
    runtime.applyEvent(snapshotEvent([v1, v2], 3_000))
    const reused = table.acquire(v2.entityKey)
    expect(reused).not.toBe(null)
    await advance(renderer)
    expect(reused!.slot).toBe(0)
    expect(slotShown(bg, 0)).toBe(true)
    expect(fakes[0].atlas.book.textAt(0)).toBe('名称-v2')
    // 名称 UV 已随缓存重建指向 0 号单元
    const nameUv = attrOf(findMesh(renderer, 'fleet-label-text-b0'), 'aNameUv').subarray(0, 4)
    const cell = labelCellUv(0)
    expect(nameUv[0]).toBeCloseTo(cell.u0, 12)
  })

  it('非法位置车辆不渲染标签；恢复后下一帧出现', async () => {
    const runtime = createFleetRuntime()
    const bad = snap('v0', {
      agvPosition: { x: Number.NaN, y: 50, theta: 0, localizationScore: 0.9 },
    })
    runtime.applyEvent(snapshotEvent([bad]))
    const table = createInstanceSlotTable()
    const mounted = track(await mountLabels({ runtime, table }))
    const { renderer } = mounted
    const slot = table.acquire(bad.entityKey)
    expect(slot).not.toBe(null)
    await advance(renderer)
    const bg = findMesh(renderer, 'fleet-label-bg-b0')
    expect(slotShown(bg, slot!.slot)).toBe(false)

    runtime.applyEvent(updateEvent(snap('v0'), 2_000))
    await advance(renderer)
    expect(slotShown(bg, slot!.slot)).toBe(true)
  })

  it('LOD 分级：远距非重点隐藏，FAULT 远景以名称档保留', async () => {
    const runtime = createFleetRuntime()
    const idle = snap('v0')
    const faulted = snap('v1', { errorEntryList: [{ code: 'E1' }] })
    runtime.applyEvent(snapshotEvent([idle, faulted]))
    const table = createInstanceSlotTable()
    const mounted = track(await mountLabels({ runtime, table }))
    const { renderer } = mounted
    table.acquire(idle.entityKey)
    table.acquire(faulted.entityKey)

    // 远距机位：默认 fov 下投影 < 8px
    const camera = probeCamera!
    camera.position.set(0, 0, 400)
    camera.lookAt(0, LABEL_ANCHOR_Y_M, 0)
    await advance(renderer)

    const px = projectedPx(camera, probeViewportWidth, 0.25, LABEL_ANCHOR_Y_M, 0, 1.8)
    expect(px).toBeLessThan(8)
    const bg = findMesh(renderer, 'fleet-label-bg-b0')
    // 普通远车隐藏（矩阵零缩放 + 档位 0）
    expect(slotShown(bg, 0)).toBe(false)
    expect(attrOf(bg, 'aLevel')[0]).toBe(0)
    // FAULT 属重点车：远景以「仅名称」档保留（档位 1，矩阵非零）
    expect(slotShown(bg, 1)).toBe(true)
    expect(attrOf(bg, 'aLevel')[1]).toBe(1)

    // 拉回近景：全部恢复完整档
    camera.position.set(0, 0, 5)
    camera.lookAt(0, LABEL_ANCHOR_Y_M, 0)
    await advance(renderer)
    expect(attrOf(bg, 'aLevel')[0]).toBe(
      labelLevelForPixels(projectedPx(camera, probeViewportWidth, 0.25, LABEL_ANCHOR_Y_M, 0, 1.8)),
    )
    expect(slotShown(bg, 0)).toBe(true)
  })

  it('远景重点标签最多 20 个：同秩按槽位序截断', async () => {
    const runtime = createFleetRuntime()
    const fleet = Array.from({ length: 25 }, (_, i) =>
      snap(`v${i}`, { errorEntryList: [{ code: 'E1' }] }),
    )
    runtime.applyEvent(snapshotEvent(fleet))
    const table = createInstanceSlotTable()
    const mounted = track(await mountLabels({ runtime, table }))
    const { renderer } = mounted
    for (const vehicle of fleet) {
      table.acquire(vehicle.entityKey)
    }

    const camera = probeCamera!
    camera.position.set(0, 0, 400)
    camera.lookAt(0, LABEL_ANCHOR_Y_M, 0)
    await advance(renderer)

    const bg = findMesh(renderer, 'fleet-label-bg-b0')
    expect(px83(camera)).toBeLessThan(8)
    expect(shownCount(bg)).toBe(20)
    // 同秩（FAULT）按扁平槽位升序保留前 20 个
    for (let slot = 0; slot < 20; slot += 1) {
      expect(slotShown(bg, slot)).toBe(true)
    }
    for (let slot = 20; slot < 25; slot += 1) {
      expect(slotShown(bg, slot)).toBe(false)
    }
  })

  it('选中的远车在重点截断中始终可见（白边框）', async () => {
    const runtime = createFleetRuntime()
    const fleet = Array.from({ length: 22 }, (_, i) =>
      snap(`v${i}`, { errorEntryList: [{ code: 'E1' }] }),
    )
    runtime.applyEvent(snapshotEvent(fleet))
    const table = createInstanceSlotTable()
    const mounted = track(await mountLabels({ runtime, table }))
    const { renderer } = mounted
    for (const vehicle of fleet) {
      table.acquire(vehicle.entityKey)
    }
    // 选中最后一台（若按 FAULT 同秩截断会被挤出前 20）
    useFleetMonitoringStore.getState().select(fleet[21].entityKey)

    const camera = probeCamera!
    camera.position.set(0, 0, 400)
    camera.lookAt(0, LABEL_ANCHOR_Y_M, 0)
    await advance(renderer)

    const bg = findMesh(renderer, 'fleet-label-bg-b0')
    expect(shownCount(bg)).toBe(20)
    expect(slotShown(bg, 21)).toBe(true)
    expect(attrOf(bg, 'aOverlay')[21 * 2]).toBe(1) // 选中态实例属性
  })

  it('近景选中切换下一帧写入选中边框；取消后清除', async () => {
    const runtime = createFleetRuntime()
    const snapshot = snap('v0')
    runtime.applyEvent(snapshotEvent([snapshot]))
    const table = createInstanceSlotTable()
    const mounted = track(await mountLabels({ runtime, table }))
    const { renderer } = mounted
    table.acquire(snapshot.entityKey)
    await advance(renderer)
    const bg = findMesh(renderer, 'fleet-label-bg-b0')
    expect(attrOf(bg, 'aOverlay')[0]).toBe(0)

    useFleetMonitoringStore.getState().select(snapshot.entityKey)
    await advance(renderer)
    expect(attrOf(bg, 'aOverlay')[0]).toBe(1)

    useFleetMonitoringStore.getState().select(null)
    await advance(renderer)
    expect(attrOf(bg, 'aOverlay')[0]).toBe(0)
  })

  it('重要标签降级（importantLabelsOnly）：中距离纯名称档隐藏，重点车保留', async () => {
    const runtime = createFleetRuntime()
    const normal = snap('v0')
    const faulted = snap('v1', { errorEntryList: [{ code: 'E1' }] })
    runtime.applyEvent(snapshotEvent([normal, faulted]))
    const table = createInstanceSlotTable()
    const mounted = track(
      await mountLabels({ runtime, table, importantLabelsOnly: true }),
    )
    const { renderer } = mounted
    table.acquire(normal.entityKey)
    table.acquire(faulted.entityKey)

    // 确定性地找一个中距离机位：投影长度落在 [9, 19) px（纯名称档）
    const camera = probeCamera!
    let midZ = -1
    for (let z = 5; z <= 800; z += 1) {
      camera.position.set(0, 0, z)
      camera.lookAt(0, LABEL_ANCHOR_Y_M, 0)
      const px = projectedPx(camera, probeViewportWidth, 0.25, LABEL_ANCHOR_Y_M, 0, 1.8)
      if (px < LABEL_FULL_MIN_PX && px >= LABEL_NAME_MIN_PX + 1) {
        midZ = z
        break
      }
    }
    expect(midZ).toBeGreaterThan(0)
    await advance(renderer)

    const px = projectedPx(camera, probeViewportWidth, 0.25, LABEL_ANCHOR_Y_M, 0, 1.8)
    expect(px).toBeGreaterThanOrEqual(LABEL_NAME_MIN_PX)
    expect(px).toBeLessThan(LABEL_FULL_MIN_PX)
    const bg = findMesh(renderer, 'fleet-label-bg-b0')
    // 普通中距离车：纯名称档被抑制 → 隐藏且档位 0
    expect(slotShown(bg, 0)).toBe(false)
    expect(attrOf(bg, 'aLevel')[0]).toBe(0)
    // FAULT 重点车：中距离仍以名称档保留（重点标签不降级）
    expect(slotShown(bg, 1)).toBe(true)
    expect(attrOf(bg, 'aLevel')[1]).toBe(1)

    // 对照：默认完整 LOD 下同机位普通车显示纯名称档（对照挂载使用自己的相机）
    const baseline = await mountLabels({ runtime, table })
    probeCamera!.position.set(0, 0, midZ)
    probeCamera!.lookAt(0, LABEL_ANCHOR_Y_M, 0)
    await advance(baseline.renderer)
    const bgDefault = findMesh(baseline.renderer, 'fleet-label-bg-b0')
    expect(attrOf(bgDefault, 'aLevel')[0]).toBe(1)
    expect(slotShown(bgDefault, 0)).toBe(true)
    await baseline.renderer.unmount()
  })

  it('每批次恒 2 个标签网格（Draw Call）；batchCount=2 时为 4 个', async () => {
    const runtime = createFleetRuntime()
    const table = createInstanceSlotTable()
    const one = track(await mountLabels({ runtime, table, batchCount: 1 }))
    expect(findMeshes(one.renderer, 'fleet-label-bg-b')).toHaveLength(1)
    expect(findMeshes(one.renderer, 'fleet-label-text-b')).toHaveLength(1)
    // 卸载必须 await：悬浮的 unmount 会与下一次 create 交错（React 并发渲染）
    await one.renderer.unmount()

    const two = track(await mountLabels({ runtime, table, batchCount: 2 }))
    expect(findMeshes(two.renderer, 'fleet-label-bg-b')).toHaveLength(2)
    expect(findMeshes(two.renderer, 'fleet-label-text-b')).toHaveLength(2)
    // 每批次独立图集实例
    expect(two.fakes).toHaveLength(2)
  })

  it('图集不可用整层降级：不渲染标签组并记录结构化诊断', async () => {
    const runtime = createFleetRuntime()
    const snapshot = snap('v0')
    runtime.applyEvent(snapshotEvent([snapshot]))
    const table = createInstanceSlotTable()
    const mounted = track(await mountLabels({ runtime, table, breakBadgeAtlas: true }))
    const labels = mounted.renderer.scene.findAll(
      (node) => toThree(node).name === 'fleet-labels',
    )
    expect(labels).toHaveLength(0)
    expect(mounted.records.some((r) => r.code === 'VEHICLE_LABEL_ATLAS_FAILED')).toBe(true)
  })

  it('worldTransform=null：不提交任何标签矩阵（空槽位零缩放）', async () => {
    const runtime = createFleetRuntime()
    const snapshot = snap('v0')
    runtime.applyEvent(snapshotEvent([snapshot]))
    const table = createInstanceSlotTable()
    const mounted = track(await mountLabels({ runtime, table, worldTransform: null }))
    const slot = table.acquire(snapshot.entityKey)
    await advance(mounted.renderer)
    // 与车体图层同口径：网格对象挂载，但帧同步跳过，全部矩阵保持零缩放
    const bg = findMesh(mounted.renderer, 'fleet-label-bg-b0')
    expect(shownCount(bg)).toBe(0)
    expect(slot).not.toBe(null)
  })

  it('StrictMode 双渲染：提交代际的图集与芯片图集对称释放', async () => {
    const runtime = createFleetRuntime()
    const snapshot = snap('v0')
    runtime.applyEvent(snapshotEvent([snapshot]))
    const table = createInstanceSlotTable()
    const mounted = await mountLabels({ runtime, table, strict: true })
    await advance(mounted.renderer)
    // StrictMode 双渲染使 useMemo 图集工厂执行两次：仅提交代际被挂载并持有
    // 释放责任；被丢弃的代际从未进入渲染图（零 GPU 上传），交由 GC 回收
    expect(mounted.fakes.length).toBeGreaterThanOrEqual(1)
    // 卸载后：恰好提交代际被释放，芯片图集被释放（无 GPU 资源泄漏，F4）
    await mounted.renderer.unmount()
    const disposedCount = mounted.fakes.filter((fake) => fake.isDisposed()).length
    expect(disposedCount).toBe(1)
    expect(mounted.badgeDisposed()).toBe(true)
  })

  it('FleetMonitoringFeature 集成：无 Canvas 环境标签层降级，车体图层不受影响', async () => {
    const world = makeWorld()
    const renderer = await ReactThreeTestRenderer.create(
      <FleetRuntimeProvider source={null}>
        <FleetMonitoringFeature worldTransform={world} />
      </FleetRuntimeProvider>,
    )
    cleanups.push(() => renderer.unmount())
    await act(async () => {})
    expect(
      renderer.scene.findAll((node) => toThree(node).name === 'fleet-vehicles'),
    ).toHaveLength(1)
    expect(
      renderer.scene.findAll((node) => toThree(node).name === 'fleet-labels'),
    ).toHaveLength(0)
  })
})

/** 远景测试的固定投影换算（默认机位、车长 1.8） */
function px83(camera: THREE.PerspectiveCamera): number {
  return projectedPx(camera, probeViewportWidth, 0.25, LABEL_ANCHOR_Y_M, 0, 1.8)
}
