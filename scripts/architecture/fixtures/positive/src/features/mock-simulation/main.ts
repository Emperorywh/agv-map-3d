/*
 * [夹具·正例] adapter 类 Feature 的内部文件互相导入（同 Feature 相对路径）。
 * 预期：adapter-*-public-entry-only 对自身目录豁免，不触发任何规则。
 */
import { helperValue } from './helper'

export const mockInternal = helperValue
