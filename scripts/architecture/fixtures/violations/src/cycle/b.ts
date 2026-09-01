/**
 * [夹具·负例] 循环依赖 b -> a -> b。预期：触发 no-circular。
 */
import { a } from './a'

export const b = a
