// Canvas 内的 Feature 组合根（SPEC §12.3）。
// 职责：作为场景子树的唯一挂载点，后续 Task 在此以显式 props 组合
// map-visualization、fleet-monitoring、camera-navigation 等 Feature 根组件。
// 关键不变量：本组件只做组合；不解析协议、不发起网络请求、不读取运行时配置。
// TASK-001 阶段场景为空：仅保留具名根组作为组合锚点，不创建任何业务 3D 对象。
export function AgvMonitorScene() {
  return <group name="agv-monitor-scene" />
}
