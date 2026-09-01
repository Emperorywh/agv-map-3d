/**
 * map-visualization Feature 公开入口（SPEC §12.2～§12.4；TASK-003）。
 *
 * 职责：向 app 组合层与后续 Feature（mock-simulation、camera-navigation、
 *       fleet-monitoring 的注入方）暴露最小稳定合同：地图加载服务、校验与
 *       建模入口（供跨 Feature 测试构建只读夹具模型）以及全部只读类型。
 * 边界：只允许外部从这里导入本 Feature；内部文件（model/services 细分模块）
 *       不对 Feature 外暴露。渲染组件与几何构建属 TASK-004/005，暂未提供。
 * 关键不变量：MapModel 与 WorldTransform 一经产出即冻结；消费方不得假设
 *       其内容会随事件更新（地图恢复时由 app 原子替换整个模型）。
 */
export { loadMap } from './services/loadMap'
export type { LoadMapOptions, LoadMapResult } from './services/loadMap'
export { createMapModel } from './model/createMapModel'
export type {
  CreateMapModelOptions,
  CreateMapModelResult,
} from './model/createMapModel'
export { validateMap } from './model/validateMap'
export { BEZIER_SAMPLE_SEGMENTS } from './model/edgeGeometry'
export { KNOWN_NODE_TYPES } from './model/types'
export type {
  EdgeType,
  MapAnomaly,
  MapAnomalyCode,
  MapComponent,
  MapEdge,
  MapGroup,
  MapModel,
  MapNode,
  NodeCategory,
  RawMapElement,
  RawMapJson,
  SceneBounds,
  ValidatedMapData,
} from './model/types'
