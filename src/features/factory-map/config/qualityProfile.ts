/**
 * 渲染质量与资源预算固定参数（SPEC §13.3 / §6.6 / §10.1）。
 */

/** 材质环境反射强度固定值（窗玻璃以外的材质） */
export const ENV_MAP_INTENSITY = 0.5

/** 窗玻璃材质环境反射强度（§6.6） */
export const GLASS_ENV_MAP_INTENSITY = 0.6

/** 雾起始距离（米） */
export const FOG_NEAR = 250

/** 雾终止距离（米） */
export const FOG_FAR = 1200

/** WebGL 实际渲染像素硬上限（§6.6 dpr 公式、§10.1） */
export const MAX_RENDER_PIXELS = 8_294_400

/** 单张方向光阴影贴图边长（§10.1） */
export const SHADOW_MAP_SIZE = 4096
