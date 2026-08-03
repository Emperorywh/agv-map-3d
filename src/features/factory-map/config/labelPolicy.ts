/**
 * 标签系统策略常量（SPEC §13.2 / §8.3）。
 * 距离单位为米；各类别迟滞为「进入距离 ≤ ENTER、退出距离 > EXIT」。
 */

/** 普通节点标签进入距离 */
export const NODE_ENTER = 40

/** 普通节点标签退出距离 */
export const NODE_EXIT = 44

/** 站点（work/charge/park）标签进入距离 */
export const STATION_ENTER = 90

/** 站点（work/charge/park）标签退出距离 */
export const STATION_EXIT = 95

/** 路径标签进入距离 */
export const PATH_LABEL_ENTER = 25

/** 路径标签退出距离 */
export const PATH_LABEL_EXIT = 28

/** 同屏标签 DOM 全局硬上限（§8.1） */
export const LABEL_MAX_COUNT = 300

/** 相机位置变化达到该值时重算标签候选（米） */
export const LABEL_CAMERA_POS_DELTA = 0.25

/** 相机朝向变化达到该值时重算标签候选（度） */
export const LABEL_CAMERA_ANGLE_DELTA_DEG = 0.25

/** 相机阻尼移动期间标签重算最大频率（Hz） */
export const LABEL_RECALC_MAX_HZ = 10

/** 站点类别保留名额（防止高密度站点饥饿其他类别） */
export const LABEL_RESERVED_STATION = 120

/** 普通节点类别保留名额 */
export const LABEL_RESERVED_NODE = 120

/** 路径类别保留名额 */
export const LABEL_RESERVED_PATH = 60

/** 标签锚点高度（§8.2），同时用作遮挡射线终点高度（§8.3） */
export const LABEL_ANCHOR_Y = 0.5
