/**
 * ui 层：Canvas 外的 DOM 面板（AgvList / LayerToggles / StatsPanel /
 * DetailPanel / TopBar），只消费 domain 类型与 store，不直接 import rendering（SPEC §12）。
 * 当前含加载管线界面（SPEC §4.4 / §10）与拾取详情面板（SPEC §8.2，TASK-013）；
 * 列表 / 开关 / 统计 / 顶部栏面板由 TASK-014 实现。
 */
export { LoadingOverlay } from './LoadingOverlay'
export { ErrorScreen } from './ErrorScreen'
export { WebGLUnsupportedScreen } from './WebGLUnsupportedScreen'
export { DetailPanel } from './DetailPanel'
