/**
 * 车辆快照、事件与派生状态类型（SPEC §2.4～§2.6、§3.1、§12.2；TASK-006）。
 *
 * 职责：声明车辆域的规范化数据合同——经 validateVehicle 校验后的不可变
 *       VehicleSnapshot、实体键 (mapId, agvKey) 的唯一编码、五个正交派生维度
 *       （connectivity/freshness/operation/loadState/alerts）与
 *       primaryDisplayState 投影类型。
 * 边界：只声明数据合同与常量，不含解析、校验或派生逻辑；不依赖 React、
 *       Three.js 或任何数据源实现。原始负载字段一律以 unknown 进入本模块
 *       定义的 Raw 形态之外的世界（由 validateVehicle 裁决）。
 * 关键不变量：
 * 1. 实体键恒为 (mapId, agvKey) 的无歧义编码：agvKey 是不透明字符串，全链路
 *    禁止转数字；不同地图的同一 agvKey 必然得到不同实体键；
 * 2. VehicleSnapshot 一经创建即冻结：字段 readonly、对象 Object.isFrozen，
 *    高频事件只产生新快照替换，绝不原地修改已发布的快照；
 * 3. 原始信息不丢失：未知枚举字符串、未知结构的故障条目与交通四边形原样
 *    保留在快照中；数值类字段无法安全解析时以 null 表达「未知」，绝不伪造
 *    正常值（SPEC §11.3 不默认伪装成正常）；
 * 4. 非法位置/尺寸不抛弃整车：positionValid/dimensionValid=false 保留实体并
 *    传播 INVALID_DATA 告警（SPEC §11.8），由渲染层跳过车体；只有无法确定
 *    agvKey 的负载才被整车拒绝。
 */

/** 实体键 (mapId, agvKey) 的字符串编码前缀分隔符 */
const ENTITY_KEY_SEPARATOR = ':'

/**
 * 构造实体键：(mapId, agvKey) 的无歧义编码。
 * 采用「长度前缀」编码（`${mapId.length}:${mapId}${agvKey}`），在两个组成部分
 * 都是不透明字符串（可含任意字符）时仍保证不同二元组得到不同键。
 */
export function createVehicleEntityKey(mapId: string, agvKey: string): string {
  return `${mapId.length}${ENTITY_KEY_SEPARATOR}${mapId}${agvKey}`
}

/** 车辆位置与朝向（世界坐标米；theta 弧度，0 指向 +x） */
export interface VehiclePosition {
  readonly x: number
  readonly y: number
  readonly theta: number
  /** 定位置信度；缺失或非有限时为 null（UNKNOWN，不伪装正常，SPEC §11.3） */
  readonly localizationScore: number | null
}

/** 车体尺寸（米）；非法时整体回退为通用默认值并置 dimensionValid=false */
export interface VehicleDimension {
  readonly length: number
  readonly width: number
  readonly loadLength: number
  readonly loadWidth: number
  /** 沿车头轴的几何中心偏移（米，≥0） */
  readonly centerOffset: number
}

/** 非法尺寸回退的通用默认值（与当前夹具同量级；渲染层使用，SPEC §5.2） */
export const DEFAULT_VEHICLE_DIMENSION: VehicleDimension = {
  length: 1.8,
  width: 0.7,
  loadLength: 1.8,
  loadWidth: 0.7,
  centerOffset: 0.25,
}

/** 电量状态；数值无法安全解析时为 null（UNKNOWN） */
export interface VehicleBattery {
  readonly batteryCharge: number | null
  readonly batteryHealth: number | null
  readonly batteryVoltage: number | null
  readonly charging: boolean
}

/** 速度快照：仅保留原值供诊断，不用于推算位置（SPEC §2.4） */
export interface VehicleVelocity {
  readonly vx: number | null
  readonly vy: number | null
  readonly omega: number | null
}

/** 交通资源原始四边形（结构未知条目原样保留；规范化属 TASK-012） */
export interface RawTrafficResources {
  readonly lockedRectangles: readonly unknown[]
  readonly applyingRectangles: readonly unknown[]
}

/**
 * 经校验的车辆快照（不可变）。
 * 原始负载中允许缺失/非法的字段以 null 或 valid 标志表达，未知枚举原样保留。
 */
export interface VehicleSnapshot {
  readonly entityKey: string
  readonly mapId: string
  /** 不透明字符串；原始为有限数字时被 String 化，绝不转回数字 */
  readonly agvKey: string
  /** 显示名；缺失时回退为 agvKey */
  readonly agvName: string
  /** 原始车型枚举值（含义未知，不做业务解释，SPEC §2.4/R2） */
  readonly rawType: unknown
  readonly position: VehiclePosition
  /** x/y/theta 均为有限数值才为 true；false 时渲染层不得放置车体 */
  readonly positionValid: boolean
  readonly dimension: VehicleDimension
  /** false 表示原始尺寸缺失或非法，dimension 为通用默认值（SPEC §5.2） */
  readonly dimensionValid: boolean
  readonly battery: VehicleBattery
  readonly velocity: VehicleVelocity
  /** loaded 原始值；非布尔时为 null（loadState UNKNOWN） */
  readonly loaded: boolean | null
  readonly paused: boolean
  /** 原始状态枚举字符串；缺失或非字符串时为 null（未知枚举不猜测） */
  readonly connectionState: string | null
  readonly dispatchState: string | null
  readonly orderState: string | null
  readonly vehicleProcStatus: string | null
  /** 原始故障条目（结构未知，原样保留，SPEC R3） */
  readonly rawErrorEntries: readonly unknown[]
  readonly trafficShapeResources: RawTrafficResources | null
  /** 服务端时间戳，仅用于数据诊断；新鲜度一律使用本地单调接收时钟 */
  readonly serverTime: number | null
}

/* ==================== 正交派生维度（SPEC §2.6） ==================== */

/**
 * 连接中断单独保留，区别于主动离线与无法识别的连接信息。
 * 渲染层据此显示独立状态色，同时继续保留数据过期的最高优先级。
 */
export type VehicleConnectivity = 'ONLINE' | 'OFFLINE' | 'CONNECTION_BROKEN' | 'UNKNOWN'

export type VehicleFreshness = 'FRESH' | 'STALE'

export type VehicleOperation =
  | 'FAULT'
  /**
   * 在线、避障与抱闸均为独立业务状态。
   * 不能合并为空闲、交管或暂停，否则大灯与标签会丢失状态差异。
   */
  | 'ONLINE'
  | 'AVOIDING'
  | 'BRAKED'
  | 'PAUSED'
  | 'CHARGING'
  | 'TRAFFIC_WAIT'
  | 'EXECUTING'
  | 'IDLE'
  | 'UNKNOWN'

export type VehicleLoadState = 'LOADED' | 'EMPTY' | 'UNKNOWN'

export type VehicleAlertType =
  | 'LOW_BATTERY'
  | 'CRITICAL_BATTERY'
  | 'LOW_LOCALIZATION'
  | 'INVALID_DATA'

export interface VehicleAlert {
  readonly type: VehicleAlertType
}

/**
 * 主状态优先显示数据过期，其次区分连接中断和离线，最后显示新鲜业务状态。
 * 原有 DISCONNECTED 继续承载离线或未知连接，避免改变既有协议兜底。
 */
export type VehiclePrimaryDisplayState = 'STALE' | 'DISCONNECTED' | 'CONNECTION_BROKEN' | VehicleOperation

/** 主状态 + 副徽标（STALE/断连时保留最后已知业务状态） */
export interface VehicleDisplayState {
  readonly primary: VehiclePrimaryDisplayState
  /** 最后已知业务操作状态；primary 为业务状态本身或业务状态 UNKNOWN 时为 null */
  readonly secondary: VehicleOperation | null
}

/** 从快照静态派生的正交维度（freshness 由运行时按单调时钟另行维护） */
export interface StaticVehicleState {
  readonly connectivity: VehicleConnectivity
  readonly operation: VehicleOperation
  readonly loadState: VehicleLoadState
  readonly alerts: readonly VehicleAlert[]
}
