/*
 * 交通锁聚合与几何构建测试（TASK-012 / SPEC §5.3）。
 *
 * 职责：锁定 100ms 合并窗口、规范化哈希签名重建判据、locked 红 / applying
 *       黄顶点色、索引三角化结构与资源释放幂等。
 */
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  createPlaneTransform,
  createWorldTransform,
  IDENTITY_AFFINE,
  type WorldTransform,
} from '@/shared/spatial'
import { createFleetRuntime, type FleetRuntime } from '../model/createFleetRuntime'
import { createTrafficLocksResources } from '../scene/trafficGeometry'
import { snapshotEvent, snapshotOf, updateEvent } from './testVehicles'

const world = (): WorldTransform =>
  createWorldTransform(createPlaneTransform(IDENTITY_AFFINE), { x: 0, y: 0 })

/** 合法矩形（8 数值） */
const RECT_A = [10, 10, 12, 10, 10, 11, 12, 11]
const RECT_B = [20, 10, 22, 10, 20, 11, 22, 11]

function vehicle(agvKey: string, locked: unknown[], applying: unknown[]) {
  return snapshotOf({
    agvKey,
    agvPosition: { x: 0, y: 0, theta: 0, localizationScore: 0.9 },
    connectionState: 'ONLINE',
    vehicleProcStatus: 'TRAFFIC',
    trafficShapeResources: { lockedRectangles: locked, applyingRectangles: applying },
  })
}

function apply(runtime: FleetRuntime, vehicles: ReturnType<typeof vehicle>[], receivedAt: number) {
  runtime.applyEvent(snapshotEvent(vehicles, receivedAt, receivedAt))
}

describe('交通锁聚合（100ms 合并窗口与哈希重建判据）', () => {
  it('首次 sync 立即重建：几何顶点/索引数量正确，网格可见', () => {
    const runtime = createFleetRuntime()
    apply(runtime, [vehicle('v1', [RECT_A], [])], 1000)
    const resources = createTrafficLocksResources()
    try {
      const rebuilt = resources.sync(runtime.entities(), world(), 5000)
      expect(rebuilt).toBe(true)
      expect(resources.mesh.visible).toBe(true)
      const geometry = resources.mesh.geometry
      expect(geometry.getAttribute('position').count).toBe(4)
      expect(geometry.getIndex()!.count).toBe(6)
    } finally {
      resources.dispose()
    }
  })

  it('同几何重复推送（哈希不变）不重建；几何变化才重建（2Hz 合并语义）', () => {
    const runtime = createFleetRuntime()
    const wt = world()
    apply(runtime, [vehicle('v1', [RECT_A], [])], 1000)
    const resources = createTrafficLocksResources()
    try {
      expect(resources.sync(runtime.entities(), wt, 5_000)).toBe(true)
      // 窗口内（<100ms）的调用直接跳过
      expect(resources.sync(runtime.entities(), wt, 5_050)).toBe(false)
      // 窗口外但哈希未变：不重建
      expect(resources.sync(runtime.entities(), wt, 5_200)).toBe(false)
      // 几何变化（新增矩形）：重建一次
      apply(runtime, [vehicle('v1', [RECT_A], [RECT_B])], 5_300)
      expect(resources.sync(runtime.entities(), wt, 5_400)).toBe(true)
      expect(resources.mesh.geometry.getAttribute('position').count).toBe(8)
      // 再回到同几何：签名变化后稳定
      expect(resources.sync(runtime.entities(), wt, 5_600)).toBe(false)
    } finally {
      resources.dispose()
    }
  })

  it('几何未变的乱序/引用变化推送（update 事件）不触发重建', () => {
    const runtime = createFleetRuntime()
    const wt = world()
    apply(runtime, [vehicle('v1', [RECT_A], [])], 1000)
    const resources = createTrafficLocksResources()
    try {
      expect(resources.sync(runtime.entities(), wt, 5_000)).toBe(true)
      // update 事件产生新快照对象，但矩形几何相同（仅位置字段变化）
      runtime.applyEvent(
        updateEvent(
          snapshotOf({
            agvKey: 'v1',
            agvPosition: { x: 0.5, y: 0.5, theta: 0.1, localizationScore: 0.9 },
            connectionState: 'ONLINE',
            vehicleProcStatus: 'TRAFFIC',
            trafficShapeResources: { lockedRectangles: [RECT_A], applyingRectangles: [] },
          }),
          1_100,
          2,
        ),
      )
      expect(resources.sync(runtime.entities(), wt, 5_200)).toBe(false)
    } finally {
      resources.dispose()
    }
  })

  it('窗口内多条更新合并为一次结算（100ms 窗口语义）', () => {
    const runtime = createFleetRuntime()
    const wt = world()
    const resources = createTrafficLocksResources()
    try {
      // 0ms 首次结算（空 → 无几何）
      expect(resources.sync(runtime.entities(), wt, 0)).toBe(true)
      expect(resources.mesh.visible).toBe(false)
      // 10ms 与 50ms 的更新都落在窗口内，不结算
      apply(runtime, [vehicle('v1', [RECT_A], [])], 10)
      expect(resources.sync(runtime.entities(), wt, 10)).toBe(false)
      apply(runtime, [vehicle('v1', [RECT_A], [RECT_B])], 50)
      expect(resources.sync(runtime.entities(), wt, 50)).toBe(false)
      // 101ms 窗口边界：一次结算体现最终状态（两个矩形）
      expect(resources.sync(runtime.entities(), wt, 101)).toBe(true)
      expect(resources.mesh.geometry.getAttribute('position').count).toBe(8)
    } finally {
      resources.dispose()
    }
  })

  it('全部矩形删除后几何清空、网格隐藏；签名稳定后不再重建', () => {
    const runtime = createFleetRuntime()
    const wt = world()
    apply(runtime, [vehicle('v1', [RECT_A], [])], 1000)
    const resources = createTrafficLocksResources()
    try {
      expect(resources.sync(runtime.entities(), wt, 5_000)).toBe(true)
      apply(runtime, [], 5_100)
      expect(resources.sync(runtime.entities(), wt, 5_200)).toBe(true)
      expect(resources.mesh.visible).toBe(false)
      expect(resources.sync(runtime.entities(), wt, 5_400)).toBe(false)
    } finally {
      resources.dispose()
    }
  })

  it('世界变换换代立即强制重建（不受合并窗口限制）', () => {
    const runtime = createFleetRuntime()
    apply(runtime, [vehicle('v1', [RECT_A], [])], 1000)
    const resources = createTrafficLocksResources()
    try {
      const first = world()
      expect(resources.sync(runtime.entities(), first, 5_000)).toBe(true)
      const next = world()
      expect(resources.sync(runtime.entities(), next, 5_010)).toBe(true)
      const position = resources.mesh.geometry.getAttribute('position')
      expect(position.getY(0)).toBeCloseTo(0.02, 6)
    } finally {
      resources.dispose()
    }
  })
})

describe('交通锁几何表达（locked 红 / applying 黄 / 索引三角化）', () => {
  it('locked 顶点色为红、applying 顶点色为黄；坐标经统一世界变换', () => {
    const runtime = createFleetRuntime()
    apply(runtime, [vehicle('v1', [RECT_A], [RECT_B])], 1000)
    const resources = createTrafficLocksResources()
    try {
      resources.sync(runtime.entities(), world(), 5_000)
      const geometry = resources.mesh.geometry
      const position = geometry.getAttribute('position')
      const color = geometry.getAttribute('color')
      const locked = new THREE.Color('#ff2d2d')
      const applying = new THREE.Color('#ffd21e')
      // 前 4 顶点 = locked（红），后 4 顶点 = applying（黄）；缓冲为
      // Float32，与双精度 Color 常量按浮点容差比对
      expect(position.getX(0)).toBeCloseTo(10, 6)
      expect(position.getZ(0)).toBeCloseTo(10, 6)
      for (let i = 0; i < 4; i += 1) {
        expect(color.getX(i)).toBeCloseTo(locked.r, 6)
        expect(color.getY(i)).toBeCloseTo(locked.g, 6)
        expect(color.getZ(i)).toBeCloseTo(locked.b, 6)
      }
      for (let i = 4; i < 8; i += 1) {
        expect(color.getX(i)).toBeCloseTo(applying.r, 6)
        expect(color.getY(i)).toBeCloseTo(applying.g, 6)
        expect(color.getZ(i)).toBeCloseTo(applying.b, 6)
      }
      // 索引三角化：凸四边形固定 (0,1,2)(0,2,3)
      const index = geometry.getIndex()!.array as Uint16Array
      expect(Array.from(index.slice(0, 6))).toEqual([0, 1, 2, 0, 2, 3])
      expect(Array.from(index.slice(6, 12))).toEqual([4, 5, 6, 4, 6, 7])
    } finally {
      resources.dispose()
    }
  })

  it('无效矩形不进入几何（逐项跳过）；有效矩形照常渲染', () => {
    const runtime = createFleetRuntime()
    apply(
      runtime,
      [vehicle('v1', [[0, 0, NaN, 0, 2, 2, 0, 2], RECT_A], [])],
      1000,
    )
    const resources = createTrafficLocksResources()
    try {
      resources.sync(runtime.entities(), world(), 5_000)
      expect(resources.mesh.visible).toBe(true)
      expect(resources.mesh.geometry.getAttribute('position').count).toBe(4)
    } finally {
      resources.dispose()
    }
  })
})

describe('交通锁资源生命周期', () => {
  it('dispose 幂等且释放当前几何', () => {
    const runtime = createFleetRuntime()
    apply(runtime, [vehicle('v1', [RECT_A], [])], 1000)
    const resources = createTrafficLocksResources()
    resources.sync(runtime.entities(), world(), 5_000)
    const geometry = resources.mesh.geometry
    resources.dispose()
    expect(geometry.attributes).toBeDefined()
    expect(() => resources.dispose()).not.toThrow()
    expect(resources.sync(runtime.entities(), world(), 6_000)).toBe(false)
  })
})
