/**
 * 地图输入容量与数值上限（SPEC §3.3）。
 * 超出上限一律返回 MapCapacityError / MapValidationError，不截断、不降级。
 */

/** UTF-8 payload 字节上限：20MiB（§3.1） */
export const MAX_MAP_BYTES = 20 * 1024 * 1024

/** 地图 bbox 宽度/深度上限（米）；加 margin 后 4:3 画幅 fit 距离仍不超过 ORBIT_MAX_DIST=350m */
export const MAX_MAP_EXTENT = 220

/** nodes + edges 元素总数上限 */
export const MAX_MAP_ELEMENTS = 20_000

/** 坐标绝对值上限（米）：避免 float32 顶点在远离原点处出现毫米级量化 */
export const MAX_MAP_COORDINATE_ABS = 1_000

/** 路径几何弧长下限（米）：低于该值返回 MapValidationError，不静默跳过 */
export const MIN_PATH_ARC_LENGTH = 0.01
