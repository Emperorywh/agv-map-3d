/*
 * validateVehicle 单车隔离校验测试（TASK-006 / C3、§11.3、§11.8）。
 *
 * 覆盖：合法归一化、agvKey 字符串保持与数字字符串化、整车拒绝原因、
 *       非法位置/尺寸的 valid 标志与默认值回退、未知枚举原样保留、
 *       缺失数值置 null（不伪装正常）、原始条目保真、快照冻结。
 */
import { describe, expect, it } from 'vitest'
import { validateVehicle } from '../model/validateVehicle'
import { DEFAULT_VEHICLE_DIMENSION, createVehicleEntityKey } from '../model/types'
import { makeRawVehicle } from './testVehicles'

describe('validateVehicle 合法归一化', () => {
  it('合法负载得到冻结快照：字段、实体键与 mapId 补全正确', () => {
    const raw = makeRawVehicle()
    const result = validateVehicle(raw, 'map-a')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const snapshot = result.snapshot
    expect(snapshot.entityKey).toBe(createVehicleEntityKey('map-a', 'agv-001'))
    expect(snapshot.mapId).toBe('map-a')
    expect(snapshot.agvKey).toBe('agv-001')
    expect(snapshot.agvName).toBe('测试车 001')
    expect(snapshot.position).toEqual({
      x: 100,
      y: 50,
      theta: 0,
      localizationScore: 0.9,
    })
    expect(snapshot.positionValid).toBe(true)
    expect(snapshot.dimension).toEqual({
      length: 1.8,
      width: 0.7,
      loadLength: 1.8,
      loadWidth: 0.7,
      centerOffset: 0.25,
    })
    expect(snapshot.dimensionValid).toBe(true)
    expect(snapshot.battery.charging).toBe(false)
    expect(snapshot.loaded).toBe(false)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.rawErrorEntries)).toBe(true)
  })

  it('agvKey 是字符串时原样保留（19 位大数不丢精度）', () => {
    const result = validateVehicle(makeRawVehicle({ agvKey: '2092065442896957450' }), 'm')
    expect(result.ok && result.snapshot.agvKey).toBe('2092065442896957450')
  })

  it('agvKey 为有限数字时字符串化，绝不转回数字', () => {
    const result = validateVehicle(makeRawVehicle({ agvKey: 12345 }), 'm')
    expect(result.ok && result.snapshot.agvKey).toBe('12345')
    expect(typeof (result.ok && result.snapshot.agvKey)).toBe('string')
  })
})

describe('validateVehicle 整车拒绝', () => {
  const cases: readonly { name: string; raw: unknown; reason: string }[] = [
    { name: '非对象：null', raw: null, reason: 'VEHICLE_NOT_AN_OBJECT' },
    { name: '非对象：数组', raw: [1, 2], reason: 'VEHICLE_NOT_AN_OBJECT' },
    { name: '非对象：数字', raw: 42, reason: 'VEHICLE_NOT_AN_OBJECT' },
    { name: 'agvKey 缺失', raw: makeRawVehicle({ agvKey: undefined }), reason: 'AGV_KEY_MISSING' },
    { name: 'agvKey 空字符串', raw: makeRawVehicle({ agvKey: '' }), reason: 'AGV_KEY_INVALID' },
    { name: 'agvKey 为对象', raw: makeRawVehicle({ agvKey: { id: 1 } }), reason: 'AGV_KEY_MISSING' },
    { name: 'agvKey 为 NaN', raw: makeRawVehicle({ agvKey: Number.NaN }), reason: 'AGV_KEY_MISSING' },
  ]
  for (const c of cases) {
    it(`整车拒绝：${c.name}，不产生实体`, () => {
      const result = validateVehicle(c.raw, 'm')
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe(c.reason)
    })
  }
})

describe('validateVehicle 字段级隔离（§11.8）', () => {
  it('x 非有限 → positionValid=false，坐标占位但保留其他字段', () => {
    const result = validateVehicle(
      makeRawVehicle({ agvPosition: { x: Number.NaN, y: 4, theta: 0, localizationScore: 1 } }),
      'm',
    )
    expect(result.ok && result.snapshot.positionValid).toBe(false)
    if (!result.ok) return
    expect(result.snapshot.position.y).toBe(4)
  })

  it('theta 缺失 → positionValid=false（位姿不完整不得渲染车体）', () => {
    const result = validateVehicle(
      makeRawVehicle({ agvPosition: { x: 1, y: 2, localizationScore: 1 } }),
      'm',
    )
    expect(result.ok && result.snapshot.positionValid).toBe(false)
  })

  it('localizationScore 缺失 → null（UNKNOWN，不伪装正常）', () => {
    const result = validateVehicle(
      makeRawVehicle({ agvPosition: { x: 1, y: 2, theta: 0 } }),
      'm',
    )
    if (!result.ok) return expect.fail()
    expect(result.snapshot.position.localizationScore).toBeNull()
  })

  it('尺寸缺失 → 通用默认值 + dimensionValid=false', () => {
    const result = validateVehicle(makeRawVehicle({ agvDimension: undefined }), 'm')
    if (!result.ok) return expect.fail()
    expect(result.snapshot.dimension).toEqual(DEFAULT_VEHICLE_DIMENSION)
    expect(result.snapshot.dimensionValid).toBe(false)
  })

  it('尺寸含非正数/非有限值 → 默认值 + dimensionValid=false；centerOffset=0 合法', () => {
    for (const bad of [
      { length: 0, width: 0.7, loadLength: 1.8, loadWidth: 0.7, centerOffset: 0.25 },
      { length: 1.8, width: -1, loadLength: 1.8, loadWidth: 0.7, centerOffset: 0.25 },
      { length: 1.8, width: 0.7, loadLength: Number.POSITIVE_INFINITY, loadWidth: 0.7, centerOffset: 0.25 },
      { length: 1.8, width: 0.7, loadLength: 1.8, loadWidth: 0.7, centerOffset: -0.1 },
    ]) {
      const result = validateVehicle(makeRawVehicle({ agvDimension: bad }), 'm')
      expect(result.ok && result.snapshot.dimensionValid).toBe(false)
    }
    const zeroOffset = validateVehicle(
      makeRawVehicle({
        agvDimension: { length: 1, width: 1, loadLength: 1, loadWidth: 1, centerOffset: 0 },
      }),
      'm',
    )
    expect(zeroOffset.ok && zeroOffset.snapshot.dimensionValid).toBe(true)
  })

  it('未知枚举原样保留：connectionState/procStatus/orderState/dispatchState 非字符串置 null', () => {
    const result = validateVehicle(
      makeRawVehicle({
        connectionState: 'HIBERNATING',
        vehicleProcStatus: 'PATROLLING',
        orderState: 7,
        dispatchState: null,
      }),
      'm',
    )
    if (!result.ok) return expect.fail()
    expect(result.snapshot.connectionState).toBe('HIBERNATING')
    expect(result.snapshot.vehicleProcStatus).toBe('PATROLLING')
    expect(result.snapshot.orderState).toBeNull()
    expect(result.snapshot.dispatchState).toBeNull()
  })

  it('loaded 非布尔 → null；charging 非布尔 → false；paused 非布尔 → false', () => {
    const result = validateVehicle(
      makeRawVehicle({ loaded: 'yes', batteryState: { charging: 1 } }),
      'm',
    )
    if (!result.ok) return expect.fail()
    expect(result.snapshot.loaded).toBeNull()
    expect(result.snapshot.battery.charging).toBe(false)
    expect(result.snapshot.paused).toBe(false)
  })

  it('电量数值非法 → null；速度非有限分量 → null；createTime 非法 → null', () => {
    const result = validateVehicle(
      makeRawVehicle({
        batteryState: { batteryCharge: 'low', batteryVoltage: Number.NaN },
        velocity: { vx: Number.POSITIVE_INFINITY, vy: 0.5, omega: 'x' },
        createTime: 'yesterday',
      }),
      'm',
    )
    if (!result.ok) return expect.fail()
    expect(result.snapshot.battery.batteryCharge).toBeNull()
    expect(result.snapshot.battery.batteryVoltage).toBeNull()
    expect(result.snapshot.velocity).toEqual({ vx: null, vy: 0.5, omega: null })
    expect(result.snapshot.serverTime).toBeNull()
  })

  it('原始故障条目与交通四边形原样保留（未知结构不做解释）', () => {
    const errors = [{ code: 'E-01' }, 'malformed', 42]
    const locked = [[200.28, 4.2, 202.1, 4.2, 200.28, 4.92, 202.1, 4.92]]
    const result = validateVehicle(
      makeRawVehicle({
        errorEntryList: errors,
        trafficShapeResources: { lockedRectangles: locked, applyingRectangles: 'garbage' },
      }),
      'm',
    )
    if (!result.ok) return expect.fail()
    expect(result.snapshot.rawErrorEntries).toEqual(errors)
    expect(result.snapshot.trafficShapeResources?.lockedRectangles).toEqual(locked)
    expect(result.snapshot.trafficShapeResources?.applyingRectangles).toEqual([])
    expect(result.snapshot.rawType).toBe(1)
  })
})
