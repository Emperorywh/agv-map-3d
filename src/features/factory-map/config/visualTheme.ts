/**
 * v1 固定配色（明亮工业写实单主题）。
 * 颜色只存在于本文件（SPEC §13.4），数值与 §6.8 环境配色表、§7 地图渲染一致；
 * 业务阈值、几何尺寸、相机参数和性能参数不得放入本文件。
 */

/** 厂房地坪（中灰混凝土，须与正向路径拉开对比） */
export const FACTORY_FLOOR_COLOR = '#A9A6A0'

/** 地坪分缝 */
export const FLOOR_JOINT_COLOR = '#7F7C76'

/** 墙板 */
export const WALL_PANEL_COLOR = '#E9E7E2'

/** 墙柱分格 */
export const WALL_COLUMN_COLOR = '#8A94A0'

/** 窗玻璃（§6.8；材质 opacity 等参数由渲染层按 §6.3 固定） */
export const WINDOW_GLASS_COLOR = '#A8CCE8'

/** 桁架钢 */
export const TRUSS_STEEL_COLOR = '#5D6873'

/** 室外地坪（园区水泥色） */
export const OUTDOOR_GROUND_COLOR = '#ACA79B'

/** 雾/天际（与 Sky 地平线接近的浅蓝灰） */
export const FOG_COLOR = '#D8E0E8'

/** 平行光（太阳）色（§6.6 灯光表） */
export const SUN_LIGHT_COLOR = '#FFF6E8'

/** 半球光天空色（§6.6 灯光表） */
export const HEMISPHERE_SKY_COLOR = '#DCEAF7'

/** 半球光地面色（§6.6 灯光表） */
export const HEMISPHERE_GROUND_COLOR = '#B8B2A4'

/** 正向路径漆带（亮灰白漆） */
export const PATH_FORWARD_COLOR = '#C9CAC6'

/** 反向路径漆带（红色语义） */
export const PATH_BACKWARD_COLOR = '#E57373'

/** 正向方向箭头（与路径同语义、加深） */
export const CHEVRON_FORWARD_COLOR = '#83847F'

/** 反向方向箭头（与路径同语义、加深） */
export const CHEVRON_BACKWARD_COLOR = '#C05454'

/** 普通节点圆点 */
export const NODE_DOT_COLOR = '#78909C'

/** 工作站圆环（蓝） */
export const STATION_WORK_COLOR = '#2196F3'

/** 充电点圆环（绿） */
export const STATION_CHARGE_COLOR = '#8BC34A'

/** 停车点圆环（红） */
export const STATION_PARK_COLOR = '#F44336'
