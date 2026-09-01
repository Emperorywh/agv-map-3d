/**
 * 纯对象校验原语（业务无关，SPEC §12.1 shared 边界）。
 *
 * 职责：判断值是否为「JSON 反序列化意义上的普通对象」，即可安全进行
 *       键枚举与严格白名单字段校验的对象。
 * 边界：不识别类实例、Date、Map 等宿主对象；运行时配置与协议消息均来自
 *       JSON.parse，本原语只服务该场景。
 * 关键不变量：数组与 null 必须返回 false，避免调用方把数组当对象逐字段校验。
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
