/*
 * 通用程序化 AGV 几何与部件布局测试（TASK-010 / SPEC §2.5、§5.2、§6.3）。
 *
 * 覆盖：centerOffset 世界位姿合成（含角度符号）、部件本地布局的每车尺寸
 * 进入矩阵、可见性与信标激活语义、方向楔 +x 朝向、信标几何形状、资源工厂
 * 创建与幂等释放。数值以当前夹具尺寸（1.8 × 0.7，centerOffset=0.25）为基准。
 */
import { describe, expect, it } from 'vitest'
import {
  createPlaneTransform,
  createWorldTransform,
  IDENTITY_AFFINE,
} from '@/shared/spatial'
import { deriveVehicleState, projectDisplayState } from '../model/deriveVehicleState'
import type { VehicleDisplayState, VehicleSnapshot } from '../model/types'
import { snapshotOf } from './testVehicles'
import {
  computeVehiclePartLayout,
  computeVehicleWorldPose,
  createVehicleResources,
  INSTANCE_COLOR_PARTS,
  VEHICLE_PART_KINDS,
} from '../scene/createVehicleGeometry'
import { WEDGE_COLOR_BRIGHTNESS } from '../scene/fleetAppearance'

/** 当前夹具尺寸（json/vehicle.json 同构） */
const FIXTURE = {
  length: 1.8,
  width: 0.7,
  loadLength: 1.8,
  loadWidth: 0.7,
  centerOffset: 0.25,
}

function fixtureSnapshot(overrides: Record<string, unknown> = {}): VehicleSnapshot {
  return snapshotOf(
    makeRaw({ agvPosition: { x: 100, y: 50, theta: 0, localizationScore: 0.9 }, ...overrides }),
  )
}

function makeRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agvKey: 'agv-001',
    agvPosition: { x: 100, y: 50, theta: 0, localizationScore: 0.9 },
    agvDimension: FIXTURE,
    connectionState: 'ONLINE',
    vehicleProcStatus: 'IDLE',
    ...overrides,
  }
}

function displayOf(snapshot: VehicleSnapshot, freshness: 'FRESH' | 'STALE' = 'FRESH'): VehicleDisplayState {
  return projectDisplayState(deriveVehicleState(snapshot), freshness)
}

describe('computeVehicleWorldPose（§2.5 坐标与车体中心）', () => {
  const world = createWorldTransform(createPlaneTransform(IDENTITY_AFFINE), { x: 100, y: 50 })

  it('theta=0：车体中心 = 参考点沿 +x 平移 centerOffset', () => {
    const pose = computeVehicleWorldPose(fixtureSnapshot(), world)
    expect(pose.cx).toBeCloseTo(0.25, 12)
    expect(pose.cz).toBeCloseTo(0, 12)
    expect(pose.rotY).toBeCloseTo(0, 12)
  })

  it('theta=π/2：偏移指向地图 +y（世界 +z），rotation.y = -theta', () => {
    const pose = computeVehicleWorldPose(
      fixtureSnapshot({ agvPosition: { x: 100, y: 50, theta: Math.PI / 2, localizationScore: 0.9 } }),
      world,
    )
    expect(pose.cx).toBeCloseTo(0, 12)
    expect(pose.cz).toBeCloseTo(0.25, 12)
    expect(pose.rotY).toBeCloseTo(-Math.PI / 2, 12)
  })

  it('原点不为零时同样成立（世界原点 = 地图 bounds 中心）', () => {
    const shifted = createWorldTransform(createPlaneTransform(IDENTITY_AFFINE), { x: 10, y: 20 })
    const pose = computeVehicleWorldPose(fixtureSnapshot(), shifted)
    expect(pose.cx).toBeCloseTo(90.25, 12)
    expect(pose.cz).toBeCloseTo(30, 12)
  })
})

describe('computeVehiclePartLayout（§5.2 部件布局）', () => {
  it('当前夹具尺寸：七部件中心与全尺寸按固定高度阶梯排布', () => {
    const snapshot = fixtureSnapshot({ loaded: true })
    const layout = computeVehiclePartLayout(snapshot, displayOf(snapshot))

    expect(layout.visible).toBe(true)
    expect(layout.loaded).toBe(true)
    // 方向楔长 = 0.22 × 1.8；外壳长 = 车长 − 楔长
    const wedgeLen = 0.396
    const shellLen = 1.8 - wedgeLen
    expect(layout.chassis).toEqual({
      x: -wedgeLen / 2, y: 0.055, z: 0, sx: 1.8, sy: 0.05, sz: 0.7,
    })
    expect(layout.shell.x).toBeCloseTo(-wedgeLen / 2, 12)
    expect(layout.shell.y).toBeCloseTo(0.16, 12)
    expect(layout.shell.sx).toBeCloseTo(shellLen, 12)
    expect(layout.shell.sy).toBeCloseTo(0.16, 12)
    expect(layout.shell.sz).toBeCloseTo(0.7 * 0.96, 12)
    // 楔贴在车头：中心位于 +x 端
    expect(layout.wedge.x).toBeCloseTo(0.9 - wedgeLen / 2, 12)
    expect(layout.wedge.sx).toBeCloseTo(wedgeLen, 12)
    // 平台/托盘用载荷尺寸（loadLength/loadWidth），托盘略小
    expect(layout.platform).toEqual({
      x: -wedgeLen / 2, y: 0.255, z: 0, sx: 1.8, sy: 0.03, sz: 0.7,
    })
    expect(layout.pallet.sx).toBeCloseTo(1.8 * 0.8, 12)
    expect(layout.pallet.sz).toBeCloseTo(0.7 * 0.8, 12)
    expect(layout.pallet.y).toBeCloseTo(0.305, 12)
    // 信标挂在车尾后方，高于载荷平台顶面
    expect(layout.beacon.x).toBeCloseTo(-0.94, 12)
    expect(layout.beacon.y).toBeGreaterThan(layout.platform.y)
    // 假阴影比车体大且贴地
    expect(layout.shadow.sx).toBeCloseTo(1.8 * 1.25, 12)
    expect(layout.shadow.sz).toBeCloseTo(0.7 * 1.7, 12)
    expect(layout.shadow.y).toBeCloseTo(0.012, 12)
  })

  it('未载货：loaded=false（平台/托盘可见性由帧同步层零缩放表达）', () => {
    const snapshot = fixtureSnapshot({ loaded: false })
    const layout = computeVehiclePartLayout(snapshot, displayOf(snapshot))
    expect(layout.loaded).toBe(false)
    // 占位矩阵仍按载荷尺寸计算（解耦可见性与布局）
    expect(layout.platform.sx).toBeCloseTo(FIXTURE.loadLength, 12)
  })

  it('非法位置或尺寸：visible=false（非法坐标不放置车体）', () => {
    const badPosition = fixtureSnapshot({
      agvPosition: { x: Number.NaN, y: 0, theta: 0, localizationScore: 0.9 },
    })
    expect(
      computeVehiclePartLayout(badPosition, displayOf(badPosition)).visible,
    ).toBe(false)

    const badDimension = fixtureSnapshot({
      agvDimension: { ...FIXTURE, length: -1 },
    })
    expect(
      computeVehiclePartLayout(badDimension, displayOf(badDimension)).visible,
    ).toBe(false)
  })

  it('信标激活当且仅当投影主状态为 FAULT；STALE/断连熄灭', () => {
    const faulted = fixtureSnapshot({ errorEntryList: [{ code: 'E1' }] })
    expect(displayOf(faulted).primary).toBe('FAULT')
    expect(computeVehiclePartLayout(faulted, displayOf(faulted)).beaconActive).toBe(true)

    // FAULT + STALE：投影主状态为 STALE → 熄灭（OFFLINE 同理）
    expect(displayOf(faulted, 'STALE').primary).toBe('STALE')
    expect(computeVehiclePartLayout(faulted, displayOf(faulted, 'STALE')).beaconActive).toBe(false)

    const offline = fixtureSnapshot({ connectionState: 'OFFLINE', errorEntryList: [{ code: 'E1' }] })
    expect(displayOf(offline).primary).toBe('DISCONNECTED')
    expect(computeVehiclePartLayout(offline, displayOf(offline)).beaconActive).toBe(false)

    const idle = fixtureSnapshot()
    expect(computeVehiclePartLayout(idle, displayOf(idle)).beaconActive).toBe(false)
  })
})

describe('createVehicleResources（几何与材质工厂）', () => {
  it('方向楔鼻尖指向本地 +x：最大 x 顶点收敛于中线', () => {
    const resources = createVehicleResources()
    try {
      const geometry = resources.wedge
      geometry.computeBoundingBox()
      const box = geometry.boundingBox!
      expect(box.max.x).toBeCloseTo(0.5, 6)
      expect(box.min.x).toBeCloseTo(-0.5, 6)
      const positions = geometry.getAttribute('position')
      for (let i = 0; i < positions.count; i += 1) {
        if (positions.getX(i) > 0.49) {
          // 鼻尖棱：z 收敛于 0（车头中线）
          expect(Math.abs(positions.getZ(i))).toBeLessThan(1e-6)
        }
      }
    } finally {
      resources.dispose()
    }
  })

  it('信标几何含 +x 扫掠叶片（旋转可见的力臂）', () => {
    const resources = createVehicleResources()
    try {
      resources.beacon.computeBoundingBox()
      const box = resources.beacon.boundingBox!
      // 叶片长度 0.16 + 穹顶半径 0.055 → 最大 x 明显大于穹顶半径
      expect(box.max.x).toBeGreaterThan(0.12)
      expect(box.min.y).toBeGreaterThanOrEqual(-0.05)
    } finally {
      resources.dispose()
    }
  })

  it('实例颜色部件为外壳/楔/信标；资源 dispose 幂等', () => {
    const resources = createVehicleResources()
    expect([...INSTANCE_COLOR_PARTS].sort()).toEqual(['beacon', 'shell', 'wedge'])
    expect(VEHICLE_PART_KINDS).toHaveLength(7)
    expect(() => {
      resources.dispose()
      resources.dispose()
    }).not.toThrow()
  })

  it('楔色亮度系数介于 0 与 1（同色系更暗，方向语义增强）', () => {
    expect(WEDGE_COLOR_BRIGHTNESS).toBeGreaterThan(0)
    expect(WEDGE_COLOR_BRIGHTNESS).toBeLessThan(1)
  })

  it('盒几何为单位尺寸（部件尺寸全部来自实例矩阵）', () => {
    const resources = createVehicleResources()
    try {
      resources.box.computeBoundingBox()
      expect(resources.box.boundingBox!.max.x).toBeCloseTo(0.5, 6)
      expect(resources.box.boundingBox!.min.y).toBeCloseTo(-0.5, 6)
      resources.shadow.computeBoundingBox()
      // 阴影为水平面片：y 方向厚度为 0
      expect(resources.shadow.boundingBox!.max.y).toBeCloseTo(0, 6)
      expect(resources.shadow.boundingBox!.min.y).toBeCloseTo(0, 6)
    } finally {
      resources.dispose()
    }
  })
})
