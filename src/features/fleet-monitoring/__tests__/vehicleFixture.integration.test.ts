/*
 * 当前单车夹具（json/vehicle.json）集成测试（TASK-006 / A4、D5、§2.3）。
 *
 * 职责：从当前输入 json/vehicle.json 重新计算并锁定车辆域数据不变量；
 *       输入发生合法变化时，直接更新本文件中的期望值（不保留旧值说明）。
 * 关键不变量（当前输入）：
 * 1. agvKey 是 19 位数字字符串，必须原样保留（不得转 number 丢精度）；
 * 2. 车辆状态派生：connectionState=ONLINE、vehicleProcStatus=TRAFFIC →
 *    operation=TRAFFIC_WAIT（orderState=PROCESSING 被优先级压住，D5/D1）；
 * 3. 电量 19.57 → LOW_BATTERY（非 CRITICAL）；loaded=true → LOADED；
 * 4. 位置/尺寸合法（centerOffset=0.25），无 INVALID_DATA；
 * 5. 交通四边形 locked 1 个、applying 3 个，原样保留（规范化属 TASK-012）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveVehicleState, projectDisplayState } from '@/features/fleet-monitoring/model/deriveVehicleState'
import { validateVehicle } from '@/features/fleet-monitoring/model/validateVehicle'
import { createVehicleEntityKey } from '@/features/fleet-monitoring/model/types'
import { createFleetRuntime } from '@/features/fleet-monitoring/model/createFleetRuntime'

const VEHICLE_JSON_PATH = path.resolve(process.cwd(), 'json/vehicle.json')
const MAP_ID = 'map-under-test'

const rawVehicle: unknown = JSON.parse(readFileSync(VEHICLE_JSON_PATH, 'utf-8'))

describe('当前车辆夹具（json/vehicle.json）领域事实', () => {
  const result = validateVehicle(rawVehicle, MAP_ID)

  it('夹具校验通过，agvKey 字符串原样保留、实体键正确', () => {
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot.agvKey).toBe('2092065442896957450')
    expect(typeof result.snapshot.agvKey).toBe('string')
    expect(result.snapshot.entityKey).toBe(
      createVehicleEntityKey(MAP_ID, '2092065442896957450'),
    )
    expect(result.snapshot.agvName).toBe('压力测试1L-2092065442896957450')
  })

  it('状态派生：TRAFFIC_WAIT（D5）、LOW_BATTERY、LOADED、ONLINE', () => {
    if (!result.ok) return expect.fail()
    const state = deriveVehicleState(result.snapshot)
    expect(state.operation).toBe('TRAFFIC_WAIT')
    expect(state.connectivity).toBe('ONLINE')
    expect(state.loadState).toBe('LOADED')
    expect(state.alerts.map((alert) => alert.type)).toEqual(['LOW_BATTERY'])
  })

  it('FRESH 主状态投影为 TRAFFIC_WAIT，无副徽标', () => {
    if (!result.ok) return expect.fail()
    const state = deriveVehicleState(result.snapshot)
    expect(projectDisplayState(state, 'FRESH')).toEqual({
      primary: 'TRAFFIC_WAIT',
      secondary: null,
    })
  })

  it('位置与尺寸合法：centerOffset=0.25、无 INVALID_DATA、电量字段保留', () => {
    if (!result.ok) return expect.fail()
    expect(result.snapshot.positionValid).toBe(true)
    expect(result.snapshot.dimensionValid).toBe(true)
    expect(result.snapshot.dimension.centerOffset).toBe(0.25)
    expect(result.snapshot.position).toEqual({
      x: 203.2397,
      y: 4.5589,
      theta: 3.1416,
      localizationScore: 1,
    })
    expect(result.snapshot.battery.batteryCharge).toBeCloseTo(19.57, 6)
    expect(result.snapshot.battery.charging).toBe(false)
    expect(result.snapshot.paused).toBe(false)
    expect(result.snapshot.rawErrorEntries).toEqual([])
  })

  it('交通四边形原样保留：locked 1 个、applying 3 个（TASK-012 规范化）', () => {
    if (!result.ok) return expect.fail()
    expect(result.snapshot.trafficShapeResources?.lockedRectangles).toHaveLength(1)
    expect(result.snapshot.trafficShapeResources?.applyingRectangles).toHaveLength(3)
  })

  it('夹具经运行时归并后 FRESH，10s 无更新跃迁 STALE 且主状态冻结', () => {
    if (!result.ok) return expect.fail()
    const runtime = createFleetRuntime({ staleAfterMs: 10_000 })
    runtime.applyEvent({
      type: 'snapshot',
      schemaVersion: 'fixture/1',
      mapId: MAP_ID,
      sequence: 1,
      receivedAt: 0,
      vehicles: [result.snapshot],
    })
    const key = result.snapshot.entityKey
    expect(runtime.get(key)?.freshness).toBe('FRESH')
    runtime.tick(10_000)
    const entity = runtime.get(key)
    expect(entity?.freshness).toBe('STALE')
    expect(entity?.displayState.primary).toBe('STALE')
    // 冻结灰下保留最后已知业务状态作为副徽标（TRAFFIC_WAIT）
    expect(entity?.displayState.secondary).toBe('TRAFFIC_WAIT')
  })
})
