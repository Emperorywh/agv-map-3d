/**
 * shared/spatial 公开入口（SPEC §12.2）。
 *
 * 职责：导出业务无关的二维仿射变换与世界坐标映射能力，供 app 组合层与各
 *       Feature 复用（map-visualization 直接使用；fleet-monitoring 的坐标
 *       转换按架构由 app 注入同一实现）。
 * 边界：本目录不得出现任何 AGV 业务词汇；不提供跨 shared 子目录聚合。
 * 关键不变量：仿射顺序与方向符号是全局唯一合同（见各实现文件头部）。
 */
export {
  createPlaneTransform,
  IDENTITY_AFFINE,
} from './affine'
export type { AffineParams, PlanePoint, PlaneTransform } from './affine'
export { createWorldTransform } from './worldTransform'
export type { WorldPoint, WorldTransform } from './worldTransform'
