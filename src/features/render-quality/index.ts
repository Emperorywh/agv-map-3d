/**
 * render-quality Feature 公开入口（SPEC §12.2～§12.4；TASK-014）。
 *
 * 职责：向 app 组合层暴露最小稳定合同：Canvas 内质量控制器根组件、质量等级
 *       与能力映射的纯函数合同（等级→能力开关、DPR 上限、车队规模→目标帧
 *       率），以及当前质量等级的只读视图（React 与非 React 两个消费面）。
 * 边界：外部模块只允许从这里导入本 Feature；内部 store、迟滞状态机实例与
 *       帧采样路径一律不外露。map-visualization / fleet-monitoring 与本
 *       Feature 互不导入（SPEC §12.4），能力开关由 app 组合层映射后经各
 *       Feature 的公开 props 传入。
 * 关键不变量：质量等级是本 Feature 唯一的运行时输出；任何等级的能力映射都
 *       不包含隐藏车辆、物理路径、主状态或 L1/L2 告警环的开关（SPEC §6.5）。
 */
export { RenderQualityFeature } from './components/RenderQualityFeature'
export type { RenderQualityFeatureProps } from './components/RenderQualityFeature'
export {
  capabilitiesForLevel,
  createQualityPolicy,
  effectiveDprFor,
  QUALITY_LEVEL_MAX,
  QUALITY_LEVEL_MIN,
  OVERSHOOT_RATIO,
  OVERSHOOT_SUSTAIN_MS,
  DOWNGRADE_COOLDOWN_MS,
  UNDERSHOOT_RATIO,
  UNDERSHOOT_SUSTAIN_MS,
  UPGRADE_COOLDOWN_MS,
  TARGET_FPS_VEHICLE_THRESHOLD,
  TARGET_FPS_SMALL_FLEET,
  TARGET_FPS_LARGE_FLEET,
  targetFpsForVehicleCount,
} from './model/qualityPolicy'
export type {
  CreateQualityPolicyOptions,
  QualityCapabilities,
  QualityCapabilityBase,
  QualityLevel,
  QualityPolicy,
  QualityPolicyDecision,
} from './model/qualityPolicy'
export { useQualityLevel, subscribeQualityLevel } from './hooks/useQualityLevel'
export { QUALITY_LEVEL_CHANGED_CODE } from './hooks/useAdaptiveQuality'
