/*
 * [夹具·负例] Feature 反向依赖 app。
 * 预期：触发 no-feature-to-app-import。
 */
import { entry } from '../../app/entry'

export const reverse = entry
