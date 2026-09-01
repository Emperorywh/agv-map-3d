/*
 * [夹具·正例] mock-simulation 只通过 index.ts 导入两个宿主 Feature。
 * 预期：不触发任何规则。
 */
import { mapPublic } from '../map-visualization/index'
import { fleetPublic } from '../fleet-monitoring/index'

export const mock = `${mapPublic}/${fleetPublic}`
