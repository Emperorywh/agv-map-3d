/**
 * 场景几何与地图标线度量常量（SPEC §13.1）。
 * 除注明外单位均为米；本文件只放几何/度量固定值，颜色见 visualTheme.ts。
 */

/** 地图 bbox 四周外扩量，得到厂房内空边界（§6.1） */
export const FACTORY_MARGIN = 10

/** 围墙总高 */
export const WALL_HEIGHT = 8

/** 含檩条顶部的结构最高点，用于相机 fit 与阴影范围（§9.1） */
export const STRUCTURE_MAX_Y = 9

/** 窗带下沿高度（§6.3） */
export const WINDOW_BAND_BOTTOM = 4.0

/** 窗带上沿高度（§6.3） */
export const WINDOW_BAND_TOP = 6.5

/** 主梁间距（短跨方向，§6.4） */
export const TRUSS_SPACING = 8

/** 檩条间距（长跨方向，§6.4） */
export const PURLIN_SPACING = 4

/** 地坪分缝间距（§6.2） */
export const FLOOR_JOINT = 6

/** 程序地坪纹理固定随机种子（xorshift32，§6.2） */
export const FLOOR_TEXTURE_SEED = 0x4d415033

/** 路径漆带宽度（§7.1） */
export const PATH_WIDTH = 0.12

/** 贝塞尔自适应细分：控制多边形到弦的最大距离（§7.1） */
export const CURVE_MAX_ERROR = 0.01

/** 贝塞尔自适应细分：单段控制多边形最大长度（§7.1） */
export const CURVE_MAX_SEGMENT = 0.25

/** 路径折线 miter join 限制，超过改用 bevel（§7.1） */
export const MITER_LIMIT = 2

/** 方向箭头沿弧长的间隔（§7.2） */
export const CHEVRON_SPACING = 6

/** 路径弧长短于该值时不放方向箭头（§7.2） */
export const CHEVRON_MIN_PATH_LEN = 1.0

/** 普通节点圆点半径（§7.3） */
export const NODE_DOT_R = 0.1

/** 站点圆环外径（§7.3） */
export const STATION_RING_OUTER_R = 0.15

/** 站点圆环内径（§7.3） */
export const STATION_RING_INNER_R = 0.09
