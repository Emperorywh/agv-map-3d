/**
 * 相机与 OrbitControls 固定参数（SPEC §13.3 / §9）。
 * 角度单位为度，距离单位为米。
 */

/** PerspectiveCamera 视场角 */
export const CAMERA_FOV = 46

/** 相机近裁剪面 */
export const CAMERA_NEAR = 0.1

/** 相机远裁剪面 */
export const CAMERA_FAR = 2000

/** 初始机位三维视锥 fit 距离余量（§9.1） */
export const CAMERA_FIT_MARGIN = 1.15

/** OrbitControls 最小漫游距离 */
export const ORBIT_MIN_DIST = 3

/** OrbitControls 最大漫游距离 */
export const ORBIT_MAX_DIST = 350

/** OrbitControls 最小极角（允许接近正俯视） */
export const ORBIT_MIN_POLAR_DEG = 5

/** OrbitControls 最大极角（防止视线钻到地面以下） */
export const ORBIT_MAX_POLAR_DEG = 80

/** OrbitControls 阻尼系数（enableDamping=true） */
export const ORBIT_DAMPING_FACTOR = 0.08

/** target XZ 夹取范围：厂房内边界外扩量，Y 恒为 0（§9.2） */
export const ORBIT_TARGET_CLAMP_MARGIN = 20
