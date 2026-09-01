/**
 * Mock 运动模型的速度裁决（SPEC §9.2；TASK-008）。
 *
 * 职责：实现「目标速度 0.5～1.5m/s 采样，再受当前边 maxFreeSpeed/maxLoadSpeed
 *       限制」的两级速度规则，并给出沿边推进距离的纯计算。位置与朝向的
 *       几何落点由弧长表承担，本模块只裁决「这一步走多远」。
 * 边界：纯函数模块——速度裁决不携带状态；载荷（loaded）由调用方（内核）
 *       按车辆状态传入；不接触地图遍历、电量或事件语义。
 * 关键不变量：
 * 1. 目标速度恒落在 [MOCK_SPEED_MIN_MPS, MOCK_SPEED_MAX_MPS] 闭区间内；
 * 2. 限速只在字段为正有限数值时生效：null（缺失）或非法值一律视为不限速，
 *   绝不把缺失限速当成 0 速或回退猜测值；
 * 3. 实际速度 = min(目标速度, 当前边适用限速)，永不为负。
 */
import type { MapEdge } from '@/features/map-visualization'
import type { MockPrng } from './prng'

/** 车辆目标速度采样下限（米/秒，SPEC §9.2） */
export const MOCK_SPEED_MIN_MPS = 0.5

/** 车辆目标速度采样上限（米/秒，SPEC §9.2） */
export const MOCK_SPEED_MAX_MPS = 1.5

/** 从 [0.5, 1.5] 均匀采样车辆目标速度（米/秒） */
export function sampleTargetSpeed(prng: MockPrng): number {
  return MOCK_SPEED_MIN_MPS + prng() * (MOCK_SPEED_MAX_MPS - MOCK_SPEED_MIN_MPS)
}

/**
 * 读取当前边对这辆车的适用限速（米/秒）：载荷时用 maxLoadSpeed，空载时用
 * maxFreeSpeed；字段缺失（null）或非法（非有限、≤0）返回 null 表示不限速。
 */
export function resolveEdgeSpeedLimit(edge: MapEdge, loaded: boolean): number | null {
  const raw = loaded ? edge.maxLoadSpeed : edge.maxFreeSpeed
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw
  }
  return null
}

/**
 * 合成实际行驶速度：目标速度被当前边限速钳制（取更小者）；无限速时直接
 * 使用目标速度。目标速度非法时按区间下限处理（防御式，正常采样不会发生）。
 */
export function resolveCruiseSpeed(targetSpeed: number, limit: number | null): number {
  const target = Number.isFinite(targetSpeed)
    ? Math.min(Math.max(targetSpeed, MOCK_SPEED_MIN_MPS), MOCK_SPEED_MAX_MPS)
    : MOCK_SPEED_MIN_MPS
  if (limit === null) {
    return target
  }
  return Math.min(target, limit)
}
