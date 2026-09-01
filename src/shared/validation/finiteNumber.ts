/**
 * 有限数值校验原语（业务无关，SPEC §12.1 shared 边界）。
 *
 * 职责：判断任意 unknown 值是否为可安全参与配置/几何计算的有限 number。
 * 边界：只做类型与有限性判断，不包含任何 AGV 业务语义；范围、枚举、单位等
 *       业务规则由调用方（如运行时配置校验）自行实现。
 * 关键不变量：NaN 与 ±Infinity 一律视为非法——后续坐标与矩阵运算依赖该保证。
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
