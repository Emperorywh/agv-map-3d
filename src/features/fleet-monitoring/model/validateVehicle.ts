/**
 * 单车隔离校验（SPEC §2.4、§5.2、§11.7、§11.8；TASK-006）。
 *
 * 职责：把任意 unknown 的单车负载裁决为不可变 VehicleSnapshot；整车无法
 *       锚定（非对象或无法确定 agvKey）时拒绝并返回稳定原因；字段级异常
 *       （非法坐标、非法尺寸、未知枚举、缺失数值）逐项降级——位置/尺寸非法
 *       置 valid 标志传播 INVALID_DATA，未知枚举原样保留，缺失数值置 null。
 * 边界：纯函数，无时钟、无 IO、无 React/Three 依赖；消息外壳与事件序号由
 *       数据源层负责，本模块只看单车负载；交通四边形只原样保留，规范化属
 *       TASK-012。
 * 关键不变量：
 * 1. 隔离不扩散：单车任何字段的异常都不影响同批其他车辆（调用方逐车调用，
 *    本函数不抛出异常，全部以结果值表达裁决）；
 * 2. agvKey 兼容字符串与有限数字（后者 String 化），其余形态整车拒绝——
 *    拒绝意味着该负载不产生任何实体，由调用方记录采样诊断；
 * 3. 成功结果的 snapshot 被 Object.freeze：任何消费方都无法原地篡改已发布
 *    的快照，高频替换只发生整对象更换；
 * 4. localizationScore / 电量数值 / 速度分量缺失或非有限时为 null（未知），
 *    不伪造默认正常值（SPEC §11.3）。
 */
import { isFiniteNumber, isPlainObject } from '@/shared/validation'
import {
  DEFAULT_VEHICLE_DIMENSION,
  createVehicleEntityKey,
  type RawTrafficResources,
  type VehicleBattery,
  type VehicleDimension,
  type VehiclePosition,
  type VehicleSnapshot,
  type VehicleVelocity,
} from './types'

/** 整车拒绝的稳定原因（采样诊断与测试断言用） */
export type VehicleInvalidReason =
  | 'VEHICLE_NOT_AN_OBJECT'
  | 'AGV_KEY_MISSING'
  | 'AGV_KEY_INVALID'

export type ValidateVehicleResult =
  | { readonly ok: true; readonly snapshot: VehicleSnapshot }
  | {
      readonly ok: false
      readonly reason: VehicleInvalidReason
      /** 能从负载中提取的 agvKey（字符串化后）；无法提取时为 null */
      readonly agvKey: string | null
    }

/**
 * 校验并归一化单车负载。
 * mapId 来自数据源绑定的地图上下文（车辆消息本身没有 mapId，SPEC §2.4）。
 */
export function validateVehicle(raw: unknown, mapId: string): ValidateVehicleResult {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: 'VEHICLE_NOT_AN_OBJECT', agvKey: null }
  }
  const agvKey = normalizeAgvKey(raw['agvKey'])
  if (agvKey === null) {
    return {
      ok: false,
      reason: typeof raw['agvKey'] === 'string' || isFiniteNumber(raw['agvKey'])
        ? 'AGV_KEY_INVALID'
        : 'AGV_KEY_MISSING',
      agvKey: null,
    }
  }

  const position = validatePosition(raw['agvPosition'])
  const dimension = validateDimension(raw['agvDimension'])

  const batteryRaw = readObject(raw['batteryState'])
  const battery: VehicleBattery = {
    batteryCharge: readFiniteOrNull(batteryRaw?.['batteryCharge']),
    batteryHealth: readFiniteOrNull(batteryRaw?.['batteryHealth']),
    batteryVoltage: readFiniteOrNull(batteryRaw?.['batteryVoltage']),
    charging: batteryRaw?.['charging'] === true,
  }

  const velocityRaw = readObject(raw['velocity'])
  const velocity: VehicleVelocity = {
    vx: readFiniteOrNull(velocityRaw?.['vx']),
    vy: readFiniteOrNull(velocityRaw?.['vy']),
    omega: readFiniteOrNull(velocityRaw?.['omega']),
  }

  const snapshot: VehicleSnapshot = {
    entityKey: createVehicleEntityKey(mapId, agvKey),
    mapId,
    agvKey,
    agvName: typeof raw['agvName'] === 'string' ? raw['agvName'] : agvKey,
    rawType: raw['type'],
    position: position.value,
    positionValid: position.valid,
    dimension: dimension.value,
    dimensionValid: dimension.valid,
    battery,
    velocity,
    loaded: typeof raw['loaded'] === 'boolean' ? raw['loaded'] : null,
    paused: raw['paused'] === true,
    connectionState: readStringOrNull(raw['connectionState']),
    dispatchState: readStringOrNull(raw['dispatchState']),
    orderState: readStringOrNull(raw['orderState']),
    vehicleProcStatus: readStringOrNull(raw['vehicleProcStatus']),
    rawErrorEntries: Array.isArray(raw['errorEntryList'])
      ? Object.freeze([...raw['errorEntryList']])
      : Object.freeze([]),
    trafficShapeResources: readTrafficResources(raw['trafficShapeResources']),
    serverTime: readFiniteOrNull(raw['createTime']),
  }
  return { ok: true, snapshot: Object.freeze(snapshot) }
}

/** agvKey 归一：字符串原样保留（非空），有限数字 String 化，其余拒绝 */
function normalizeAgvKey(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  if (isFiniteNumber(value)) {
    return String(value)
  }
  return null
}

/**
 * 位置校验：x/y/theta 全部为有限数值才有效。
 * 无效时坐标以 0 占位但 positionValid=false——渲染层据标志跳过车体与标签
 * （坐标无效的车辆无法放置车体和标签），数据仍保留供诊断。
 */
function validatePosition(
  raw: unknown,
): { value: VehiclePosition; valid: boolean } {
  const obj = readObject(raw)
  const x = obj?.['x']
  const y = obj?.['y']
  const theta = obj?.['theta']
  const valid =
    isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(theta)
  return {
    value: Object.freeze({
      x: isFiniteNumber(x) ? x : 0,
      y: isFiniteNumber(y) ? y : 0,
      theta: isFiniteNumber(theta) ? theta : 0,
      localizationScore: readFiniteOrNull(obj?.['localizationScore']),
    }),
    valid,
  }
}

/**
 * 尺寸校验：五项全部为正有限值（centerOffset 允许 0）才有效。
 * 任一项非法即整体回退通用默认值并置 dimensionValid=false，由
 * deriveVehicleState 传播 INVALID_DATA（SPEC §5.2：非法尺寸使用通用默认值）。
 */
function validateDimension(
  raw: unknown,
): { value: VehicleDimension; valid: boolean } {
  const obj = readObject(raw)
  if (obj === null) {
    return { value: DEFAULT_VEHICLE_DIMENSION, valid: false }
  }
  const candidates = [obj['length'], obj['width'], obj['loadLength'], obj['loadWidth']]
  const centerOffset = obj['centerOffset']
  const valid =
    candidates.every((value) => isFiniteNumber(value) && value > 0) &&
    isFiniteNumber(centerOffset) &&
    centerOffset >= 0
  return {
    value: valid
      ? Object.freeze({
          length: obj['length'] as number,
          width: obj['width'] as number,
          loadLength: obj['loadLength'] as number,
          loadWidth: obj['loadWidth'] as number,
          centerOffset: centerOffset as number,
        })
      : DEFAULT_VEHICLE_DIMENSION,
    valid,
  }
}

/** 交通资源原样保留：仅要求数组形态，条目不做任何解释（规范化属 TASK-012） */
function readTrafficResources(raw: unknown): RawTrafficResources | null {
  const obj = readObject(raw)
  if (obj === null) {
    return null
  }
  const locked = obj['lockedRectangles']
  const applying = obj['applyingRectangles']
  return Object.freeze({
    lockedRectangles: Object.freeze(Array.isArray(locked) ? [...locked] : []),
    applyingRectangles: Object.freeze(Array.isArray(applying) ? [...applying] : []),
  })
}

function readObject(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null
}

function readFiniteOrNull(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null
}

function readStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
