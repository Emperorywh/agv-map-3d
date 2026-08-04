/**
 * LabelLayer 帧驱动（createLabelLayerDriver）单元测试
 *（SPEC §5.2、§8.3、§10.1：位姿超阈值才重算、差分 attach/detach 仅变化项）。
 *
 * 驱动为无 React 纯逻辑，node 环境直接验证：
 * - 首帧重算并 attach 选中标签（元数据引用零拷贝传递）；
 * - 亚阈值位姿变化不重算（adapter 无任何调用）；
 * - 显著移动后重算：差分只 detach/attach 变化项，保留项不重复 attach（不清空重建）；
 * - 选中集合不变的重算（forceRecalc）差分为空；
 * - renderLabels 委托 adapter.render（§8.1 WebGL 完成后每帧一次）。
 *
 * React 壳（Canvas 内 useFrame 接管渲染、adapter 生命周期接线）无法在 node
 * 环境验证（vitest 固定 node、R3F Canvas 需 WebGL2），由 §15.2 浏览器测试与
 * 手动验收覆盖。
 */

import { Object3D, PerspectiveCamera } from 'three'
import { describe, expect, it, vi } from 'vitest'

import type { LabelCategory, LabelMetadataDto } from '../../../application/factorySceneModel'
import { LABEL_ANCHOR_Y, LABEL_MAX_COUNT } from '../../../config/labelPolicy'
import type { Css2dLabelRendererAdapter } from './Css2dLabelRendererAdapter'
import { createLabelLayerDriver } from './LabelLayer'
import {
  createLabelRecalcScheduler,
  createVisibleLabelSelector,
} from './selectVisibleLabels'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function makeLabel(id: string, category: LabelCategory, x: number, z: number): LabelMetadataDto {
  return { id, category, text: `标签${id}`, worldPosition: [x, LABEL_ANCHOR_Y, z] }
}

interface MockAdapter {
  readonly adapter: Css2dLabelRendererAdapter
  readonly attached: Map<string, LabelMetadataDto>
  readonly attachCalls: string[]
  readonly detachCalls: string[]
  readonly renderCalls: number[]
}

function makeMockAdapter(): MockAdapter {
  const attached = new Map<string, LabelMetadataDto>()
  const attachCalls: string[] = []
  const detachCalls: string[] = []
  const renderCalls: number[] = []
  const adapter: Css2dLabelRendererAdapter = {
    mount: vi.fn(),
    attach: (label: LabelMetadataDto) => {
      attached.set(label.id, label)
      attachCalls.push(label.id)
      return true
    },
    detach: (id: string) => {
      attached.delete(id)
      detachCalls.push(id)
    },
    render: () => {
      renderCalls.push(1)
    },
    dispose: vi.fn(),
    get container() {
      return null
    },
    get attachedCount() {
      return attached.size
    },
    get pooledCount() {
      return attached.size
    },
  }
  return { adapter, attached, attachCalls, detachCalls, renderCalls }
}

interface DriverHarness {
  readonly mock: MockAdapter
  readonly camera: PerspectiveCamera
  readonly scene: Object3D
  readonly driver: ReturnType<typeof createLabelLayerDriver>
  readonly scheduler: ReturnType<typeof createLabelRecalcScheduler>
  setTime(time: number): void
}

function makeHarness(labels: readonly LabelMetadataDto[]): DriverHarness {
  const mock = makeMockAdapter()
  const scene = new Object3D()
  const camera = new PerspectiveCamera(46, 16 / 9, 0.1, 2000)
  camera.position.set(0, 0.5, 0)
  camera.up.set(0, 1, 0)
  camera.lookAt(0, 0.5, -100)
  let time = 0
  const scheduler = createLabelRecalcScheduler({ now: () => time })
  const selector = createVisibleLabelSelector({ occluders: [] })
  const driver = createLabelLayerDriver({
    adapter: mock.adapter,
    selector,
    scheduler,
    scene,
    camera,
    labels,
  })
  return {
    mock,
    camera,
    scene,
    driver,
    scheduler,
    setTime: (value: number) => {
      time = value
    },
  }
}

// ---------------------------------------------------------------------------
// §5.2/§8.3 帧驱动
// ---------------------------------------------------------------------------

describe('createLabelLayerDriver（§5.2/§8.3）', () => {
  it('首帧重算：进入距离档的标签被 attach，距离外不 attach；元数据零拷贝引用传递', () => {
    const near = makeLabel('node:a', 'node', 0, -10)
    const far = makeLabel('node:b', 'node', 0, -100)
    const { mock, driver } = makeHarness([near, far])

    driver.onFrame()
    expect(mock.attachCalls).toEqual(['node:a'])
    expect(mock.attached.get('node:a')).toBe(near) // 同一元数据引用，不复制
    expect(mock.attached.size).toBe(1)
  })

  it('亚阈值位姿变化不重算：adapter 无任何 attach/detach', () => {
    const near = makeLabel('node:a', 'node', 0, -10)
    const harness = makeHarness([near])
    harness.driver.onFrame()
    expect(harness.mock.attached.size).toBe(1)

    harness.setTime(1000)
    harness.camera.position.set(0.1, 0.5, 0) // 位移 0.1m < 0.25m
    harness.driver.onFrame()
    expect(harness.mock.attachCalls).toEqual(['node:a'])
    expect(harness.mock.detachCalls).toEqual([])
  })

  it('显著移动后重算：差分只 detach/attach 变化项，保留项不重复 attach', () => {
    const labelA = makeLabel('node:a', 'node', 0, -10)
    const labelC = makeLabel('node:c', 'node', 80, -10)
    const harness = makeHarness([labelA, labelC])

    // 机位 1：a 进入（10m ≤ 40），c 在距离档外（≈80.6m > 40）
    harness.driver.onFrame()
    expect(harness.mock.attachCalls).toEqual(['node:a'])

    // 机位 2：显著移动（80m ≥ 0.25m，时间越过 10Hz 间隔）
    harness.setTime(1000)
    harness.camera.position.set(80, 0.5, 0)
    harness.camera.lookAt(80, 0.5, -100)
    harness.driver.onFrame()

    // a 退出（80.6m > 44 迟滞退出）、c 进入（10m ≤ 40）：各仅一项变化
    expect(harness.mock.detachCalls).toEqual(['node:a'])
    expect(harness.mock.attachCalls).toEqual(['node:a', 'node:c'])
    expect(harness.mock.attached.size).toBe(1)
    expect(harness.mock.attached.get('node:c')).toBe(labelC)
  })

  it('选中集合不变的重算（forceRecalc）：差分为空，不清空重建 DOM', () => {
    const near = makeLabel('node:a', 'node', 0, -10)
    const harness = makeHarness([near])
    harness.driver.onFrame()
    expect(harness.mock.attachCalls).toEqual(['node:a'])

    // viewport 变化等强制重算：选中集合不变 → 差分零项
    harness.setTime(2000)
    harness.scheduler.forceRecalc()
    harness.driver.onFrame()
    expect(harness.mock.attachCalls).toEqual(['node:a'])
    expect(harness.mock.detachCalls).toEqual([])
    expect(harness.mock.attached.size).toBe(1)
  })

  it('renderLabels 委托 adapter.render（每实际重绘帧 WebGL 完成后一次）', () => {
    const harness = makeHarness([])
    harness.driver.renderLabels()
    harness.driver.renderLabels()
    expect(harness.mock.renderCalls.length).toBe(2)
  })

  it('全局上限：选中集合差分缓冲按 LABEL_MAX_COUNT 预分配（§10.1）', () => {
    expect(LABEL_MAX_COUNT).toBe(300)
    // 301 个全部在距离档内的候选：重算后 attach 数 ≤ 300
    const labels: LabelMetadataDto[] = []
    for (let i = 0; i < 301; i += 1) {
      labels.push(makeLabel(`node:s${i}`, 'station', (i % 20) - 10, -20 - Math.floor(i / 20) * 4))
    }
    const harness = makeHarness(labels)
    harness.driver.onFrame()
    expect(harness.mock.attached.size).toBeLessThanOrEqual(LABEL_MAX_COUNT)
    expect(harness.mock.attachCalls.length).toBeLessThanOrEqual(LABEL_MAX_COUNT)
  })
})
