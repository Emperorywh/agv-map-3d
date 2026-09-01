/*
 * [夹具·正例] app 只通过公开入口导入 Feature。
 * 预期：不触发任何规则。
 */
import { alphaPublic } from '../features/alpha/index'

export const entry = alphaPublic
