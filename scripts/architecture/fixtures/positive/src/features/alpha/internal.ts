/*
 * [夹具·正例] Feature 内部文件依赖 shared 是合法方向。
 * 预期：不触发任何规则。
 */
import { pure } from '../../shared/pure'

export const alphaPublic = pure + 1
