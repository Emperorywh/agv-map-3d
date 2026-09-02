/*
 * 只读跟随目标适配器测试（TASK-013 / SPEC §5.5、§2.5、§12.4）。
 *
 * 职责：锁定「实体键 → 车体中心世界坐标」读取器的合同——坐标与渲染车体
 *       中心（computeVehicleWorldPose，§2.5 口径）严格一致、实体删除与非法
 *       位置返回 null（相机据此退出跟随）、事件更新后读取到最新位置。
 * 边界：纯模型测试；经生产路径 validateVehicle + createFleetRuntime 构造输入。
 */
import { describe, expect, it } from 'vitest'
import {
  createPlaneTransform,
  createWorldTransform,
  IDENTITY_AFFINE,
  type WorldTransform,
} from '@/shared/spatial'
import { createFleetRuntime } from '../model/createFleetRuntime'
import { createVehicleEntityKey } from '../model/types'
import { computeVehicleWorldPose } from '../scene/createVehicleGeometry'
import { createFollowTargetReader } from '../scene/followTarget'
import { removeEvent, snapshotEvent, snapshotOf, updateEvent } from './testVehicles'

function makeWorld(): WorldTransform {
  // 平面恒等变换 + 地图原点平移：结果可手算（世界 = 平面 + (100, 50)）
  return createWorldTransform(createPlaneTransform(IDENTITY_AFFINE), { x: 100, y: 50 })
}

function snap(agvKey: string, overrides: Record<string, unknown> = {}) {
  return snapshotOf({
    agvKey,
    agvPosition: { x: 10, y: 20, theta: 0.5, localizationScore: 0.9 },
    ...overrides,
  })
}

describe('createFollowTargetReader 只读跟随目标', () => {
  it('坐标与渲染车体中心严格一致（§2.5 centerOffset 口径）', () => {
    const runtime = createFleetRuntime()
    const vehicle = snap('agv-1')
    runtime.applyEvent(snapshotEvent([vehicle]))
    const world = makeWorld()
    const reader = createFollowTargetReader({ runtime, worldTransform: world })
    const key = createVehicleEntityKey(vehicle.mapId, 'agv-1')

    const pose = computeVehicleWorldPose(vehicle, world)
    expect(reader(key)).toEqual({ x: pose.cx, z: pose.cz })
  })

  it('事件更新后读取最新位置（逐帧即时读取，不缓存）', () => {
    const runtime = createFleetRuntime()
    const vehicle = snap('agv-1')
    runtime.applyEvent(snapshotEvent([vehicle]))
    const world = makeWorld()
    const reader = createFollowTargetReader({ runtime, worldTransform: world })
    const key = createVehicleEntityKey(vehicle.mapId, 'agv-1')

    const moved = snap('agv-1', {
      agvPosition: { x: 30, y: 44, theta: 0, localizationScore: 0.9 },
    })
    runtime.applyEvent(updateEvent(moved, 2_000))
    const pose = computeVehicleWorldPose(moved, world)
    expect(reader(key)).toEqual({ x: pose.cx, z: pose.cz })
  })

  it('实体删除返回 null（相机跟随据此退出）', () => {
    const runtime = createFleetRuntime()
    const vehicle = snap('agv-1')
    runtime.applyEvent(snapshotEvent([vehicle]))
    const reader = createFollowTargetReader({
      runtime,
      worldTransform: makeWorld(),
    })
    const key = createVehicleEntityKey(vehicle.mapId, 'agv-1')
    runtime.applyEvent(removeEvent(vehicle.mapId, 'agv-1', 2_000))
    expect(reader(key)).toBeNull()
  })

  it('非法位置（positionValid=false）返回 null，绝不抛出', () => {
    const runtime = createFleetRuntime()
    const invalid = snap('agv-1', {
      agvPosition: { x: Number.NaN, y: 20, theta: 0, localizationScore: 0.9 },
    })
    expect(invalid.positionValid).toBe(false)
    runtime.applyEvent(snapshotEvent([invalid]))
    const reader = createFollowTargetReader({
      runtime,
      worldTransform: makeWorld(),
    })
    expect(reader(createVehicleEntityKey(invalid.mapId, 'agv-1'))).toBeNull()
  })

  it('未知键返回 null', () => {
    const runtime = createFleetRuntime()
    const reader = createFollowTargetReader({
      runtime,
      worldTransform: makeWorld(),
    })
    expect(reader('map-under-test|不存在')).toBeNull()
  })
})
