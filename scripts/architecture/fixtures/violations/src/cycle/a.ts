/**
 * [夹具·负例] 循环依赖 a -> b -> a。预期：触发 no-circular。
 */
import { b } from './b'

export const a = b
