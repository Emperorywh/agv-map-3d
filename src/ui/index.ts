/**
 * ui 层：Canvas 外的 DOM 面板（AgvList / LayerToggles / StatsPanel /
 * DetailPanel / TopBar），只消费 domain 类型与 store，不直接 import rendering（SPEC §12）。
 * 当前含加载管线界面（SPEC §4.4 / §10）；业务面板由 TASK-013 / TASK-014 起实现。
 */
export { LoadingOverlay } from './LoadingOverlay'
export { ErrorScreen } from './ErrorScreen'
export { WebGLUnsupportedScreen } from './WebGLUnsupportedScreen'
