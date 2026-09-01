/*
 * [夹具·负例] app 深层导入 Feature 内部文件。
 * 预期：触发 app-deep-feature-import；
 * 同时作为 fleet-monitoring/reverse.ts 的反向依赖目标。
 * 通过公开入口导入 fleet-monitoring 是合法路径，不应触发任何规则。
 */
import { mapInternal } from '../features/map-visualization/internal'
import { fleetPublic } from '../features/fleet-monitoring/index'

export const entry = `${mapInternal}/${fleetPublic}`
