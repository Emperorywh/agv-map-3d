/**
 * 色彩规范（SPEC §5.1 Schematic 示意风）的唯一存放处，禁止在组件中散落硬编码。
 * 本文件为骨架：先给出占位场景与后续地图 / 建筑 / AGV 所需的基础色板，
 * 随后续任务落地按需扩展。
 */

/** 建筑：低饱和、浅灰 / 米白、哑光，不抢戏 */
export const buildingColors = {
  /** 地坪：中性深灰，与通道色带拉开对比 */
  floor: '#3a3d42',
  wall: '#d8d5cc',
  column: '#cfccc2',
  roof: '#e4e1d8',
} as const

/** 地图元素：高饱和 + 轻微 emissive，视觉层级最高 */
export const mapColors = {
  /** 普通走廊 ribbon 底色 */
  corridor: '#2f9e6e',
  /** 单向走廊 */
  corridorOneWay: '#2f7fbf',
  /** 倒车方向标识（虚线边缘 / 异色） */
  corridorBack: '#e0a13a',
  /** 单向箭头（浅色，与单向底色拉开对比） */
  corridorArrow: '#cfe4ff',
  node: '#7d8891',
  nodeWork: '#ff7847',
  /** work 方形台底色（中性灰，衬托高饱和图标色块） */
  nodeWorkBase: '#5a5f68',
  nodeCharge: '#34c6e0',
  nodePark: '#9d8cff',
  /** 标签文字（图集绘制色，深色场景上高对比浅色） */
  labelText: '#eef1f5',
} as const

/** AGV 状态色（SPEC §7.1 状态集合） */
export const agvStatusColors = {
  idle: '#8a939b',
  toPick: '#3fa7ff',
  hauling: '#ffb13d',
  toCharge: '#c96bff',
  charging: '#41d97e',
  loading: '#ff6b81',
} as const

/** 场景环境色 */
export const sceneColors = {
  /** 画布背景：深色 */
  background: '#14161a',
  /** 占位网格刻线 */
  gridLine: '#2c3036',
  /** 半球光天光 / 地面反射色（SPEC §5.3 光照基调，TASK-008 统一校准） */
  hemisphereSky: '#cfd4dc',
  hemisphereGround: '#20232a',
} as const

/** DOM UI 色彩（加载进度 / 错误页 / 提示页等 Canvas 外界面） */
export const uiColors = {
  textPrimary: '#e8eaee',
  textSecondary: '#9aa2ab',
  /** 进度条 / 主按钮强调色 */
  accent: '#3fa7ff',
  danger: '#ff5c5c',
  panelBackground: '#1c1f24',
  progressTrack: '#2c3036',
} as const
