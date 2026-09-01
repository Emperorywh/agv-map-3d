/**
 * shared/validation 公开入口（SPEC §12.2）。
 *
 * 职责：集中导出业务无关的校验原语，供 app 与各 Feature 按子目录导入。
 * 边界：本目录只允许无业务语义的原语；出现 AGV 词汇即违反 shared 边界。
 * 关键不变量：不提供跨 shared 子目录聚合的根 barrel，消费方必须按子目录导入。
 */
export { isFiniteNumber } from './finiteNumber'
export { isPlainObject } from './plainObject'
