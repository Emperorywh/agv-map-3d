/**
 * 色彩规范（SPEC §5.1 Schematic 示意风）的唯一存放处，禁止在组件中散落硬编码。
 * 视觉层级（SPEC §5.1）：建筑低饱和浅灰 / 米白哑光不抢戏；地图元素高饱和
 * + 轻微 emissive，视觉层级最高；地坪中性深灰，与通道色带拉开对比。
 * AGV 六状态色与本体分段色按 SPEC §7.1 / §7.3 定义（AgvLayer 消费）。
 */

/** 建筑：低饱和、浅灰 / 米白、哑光，不抢戏 */
export const buildingColors = {
  /** 地坪：中性深灰，与通道色带拉开对比 */
  floor: '#3a3d42',
  /** 地坪网格刻线：略浅于地坪的刻痕色 */
  floorGrid: '#484d55',
  wall: '#d8d5cc',
  column: '#cfccc2',
  roof: '#e4e1d8',
  /** 天窗带：浅蓝透光感（SPEC §5.3 发光材质模拟透光） */
  skylight: '#a8c8dc',
} as const

/** 内部元素（SPEC §5.3）：低饱和哑光，不抢戏 */
export const interiorColors = {
  /** 货架排：低饱和钢蓝 */
  shelf: '#7e8fa3',
  /** 工作台排：暖灰 */
  workbench: '#9a917f',
  /** 吊灯发光体：暖白 */
  chandelier: '#fff3d6',
  /** 充电桩程序化占位体（glTF 缺失 / 失败降级）：机身 / 屏幕 */
  chargingPile: '#b8bcc2',
  chargingPileScreen: '#1a242e',
  /** 卷帘门门框程序化占位体（glTF 缺失 / 失败降级） */
  doorFrame: '#c9cdd4',
  /** 卷帘门扇板（固定关闭）：面板 / 横肋 */
  rollerDoorPanel: '#8d939c',
  rollerDoorRib: '#7c828b',
} as const

/** 地面标线（SPEC §5.3）：浅色标线 + 区域色块（与节点同色系、半透明色洗） */
export const markingColors = {
  /** 通道两侧边缘线 */
  laneLine: '#d8d5c8',
  /** 卷帘门内侧斑马线 */
  zebra: '#e8e6da',
  /** 充电位色块（与 nodeCharge 同色系） */
  chargeArea: '#34c6e0',
  /** 装卸区色块（与 nodeWork 同色系） */
  loadingArea: '#ff7847',
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

/** AGV 状态色（SPEC §7.1 状态集合；顶部状态色环实例色，AgvLayer 消费） */
export const agvStatusColors = {
  idle: '#8a939b',
  toPick: '#3fa7ff',
  hauling: '#ffb13d',
  toCharge: '#c96bff',
  charging: '#41d97e',
  loading: '#ff6b81',
} as const

/**
 * 拾取高亮色（SPEC §8.2）：选中描边色环 / 实例 emissive 提亮 / 走廊高亮覆盖
 * 与悬停弱高亮共用同一高亮色（悬停以更低电平 / 不透明度表达弱化）。
 * 亮琥珀金——与通道绿 / 单向蓝 / 倒车橙、六状态色均拉开对比。
 */
export const highlightColors = {
  /** 选中 / 悬停高亮统一色 */
  highlight: '#ffd94d',
} as const

/**
 * AGV 本体分段色（SPEC §7.3 风格化小车，顶点色分色；状态表达全部交给
 * 顶部色环实例色 agvStatusColors，本体保持中性读车形）
 */
export const agvBodyColors = {
  /** 底盘：深 slate（与深色地坪拉开但不抢状态色环） */
  chassis: '#4c5563',
  /** 顶盖：亮灰白（衬托顶部状态色环） */
  cover: '#dfe4ea',
  /** 方向楔形：琥珀强调（车头方向指示） */
  wedge: '#ffcf5c',
  /** 前灯：暖白 */
  headlight: '#fff6d8',
} as const

/** 场景环境色 */
export const sceneColors = {
  /** 画布背景：深色（同时作为 React 挂载前 body 底色，见 main.tsx） */
  background: '#14161a',
  /** 半球光天光 / 地面反射色（SPEC §5.3 光照基调） */
  hemisphereSky: '#cfd4dc',
  hemisphereGround: '#20232a',
} as const

/** DOM UI 色彩（加载进度 / 错误页 / 提示页 / 统计与开关面板等 Canvas 外界面） */
export const uiColors = {
  textPrimary: '#e8eaee',
  textSecondary: '#9aa2ab',
  /** 进度条 / 主按钮强调色（面板激活态同色系） */
  accent: '#3fa7ff',
  danger: '#ff5c5c',
  panelBackground: '#1c1f24',
  progressTrack: '#2c3036',
  /** 面板行悬停底色（略亮于面板底；经 CSS var 注入 hover 规则） */
  rowHover: '#262b33',
  /** 面板行激活底色（当前跟随 AGV 行 / 当前开关态；配合 accent 文字） */
  rowActive: '#22354d',
} as const
