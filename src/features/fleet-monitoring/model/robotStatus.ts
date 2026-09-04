/**
 * 调度车辆的完整状态字典，中文值与服务端 RobotStatus 保持一致。
 * 使用常量对象兼容项目的可擦除 TypeScript 语法，同时保留枚举式访问方式。
 */
export const RobotStatus = {
  ONLINE: '在线',
  IDLE: '空闲',
  TRAFFIC: '交管',
  PROCESSING: '执行中',
  CHARGE: '充电',
  AVOID: '避障',
  ERROR: '异常',
  BRAKE: '抱闸',
  OFFLINE: '离线',
  CONNECTIONBROKEN: '连接中断',
  PAUSED: '暂停',
} as const

export type RobotStatus = typeof RobotStatus[keyof typeof RobotStatus]
export type RobotStatusKey = keyof typeof RobotStatus

/**
 * 同时识别线上英文键和业务枚举中文值，不改写快照中的原始字段。
 * 未登记的字符串继续返回未知，避免把协议扩展或脏数据误显示为正常状态。
 */
const ROBOT_STATUS_KEYS = new Map<string, RobotStatusKey>(
  Object.entries(RobotStatus).flatMap(([key, value]) => [
    [key, key as RobotStatusKey], [value, key as RobotStatusKey],
  ]),
)

export function normalizeRobotStatus(raw: string | null): RobotStatusKey | null {
  return raw === null ? null : ROBOT_STATUS_KEYS.get(raw) ?? null
}
