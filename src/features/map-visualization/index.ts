/**
 * map-visualization Feature 公开入口（SPEC §12.2～§12.4；TASK-003/004）。
 *
 * 职责：向 app 组合层与后续 Feature（mock-simulation、camera-navigation、
 *       fleet-monitoring 的注入方）暴露最小稳定合同：地图加载服务、校验与
 *       建模入口（供跨 Feature 测试构建只读夹具模型）、全部只读类型、
 *       BEZIER 统一采样原语（mock-simulation 弧长表必须复用同一离散化口径），
 *       以及 TASK-004 的场景公开根组件与其描述符/视图类型。
 * 边界：只允许外部从这里导入本 Feature；内部文件（model/services/scene/
 *       components/hooks 细分模块）不对 Feature 外暴露。
 * 关键不变量：MapModel 与 WorldTransform 一经产出即冻结；消费方不得假设
 *       其内容会随事件更新（地图恢复时由 app/hook 原子替换整个视图）。
 */
export { loadMap, fetchMapJson, buildMapFromJson } from './services/loadMap'
export type {
  LoadMapOptions,
  LoadMapResult,
  FetchedMapResource,
  BuildMapFromJsonOptions,
} from './services/loadMap'
export { createMapModel } from './model/createMapModel'
export type {
  CreateMapModelOptions,
  CreateMapModelResult,
} from './model/createMapModel'
export { deriveNodeVisualRole } from './model/visualRoles'
export {
  computeComponentBounds,
  pickFocusBounds,
} from './model/componentBounds'
export type { FocusBounds } from './model/componentBounds'
export { validateMap } from './model/validateMap'
export {
  BEZIER_SAMPLE_SEGMENTS,
  sampleCubicBezier,
} from './model/edgeGeometry'
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
  NodeVisualRole,
  RawMapElement,
  RawMapJson,
  SceneBounds,
  ValidatedMapData,
} from './model/types'
export { MapVisualizationFeature } from './components/MapVisualizationFeature'
export type { MapVisualizationFeatureProps } from './components/MapVisualizationFeature'
export { DEFAULT_SHADOW_MAP_SIZE } from './scene/mapAppearance'
export { useMapVisualization } from './hooks/useMapVisualization'
export type {
  MapView,
  MapViewDescriptor,
  MapViewSeed,
} from './hooks/useMapVisualization'
export type { MapGeometry, PhysicalPath } from './scene/buildMapGeometry'
