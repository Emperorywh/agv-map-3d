/**
 * domain 层：纯 TS 领域逻辑（types / coordinates / normalize / corridors /
 * graph / bezier / simulator），不 import three / react / config（SPEC §12）。
 * z 轴翻转、校准与角度换算只允许出现在 coordinates.ts 一个模块。
 * corridors / graph / simulator 由 TASK-003 / TASK-010 起实现。
 */
export * from './types'
export * from './polyline'
export * from './coordinates'
export * from './bezier'
export * from './normalize'
