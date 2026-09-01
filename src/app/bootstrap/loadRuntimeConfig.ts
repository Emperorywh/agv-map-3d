/**
 * 运行时配置读取与严格校验（SPEC §10.1；TASK-002）。
 *
 * 职责：从与 index.html 同部署根目录的 config.json 读取公开运行参数，
 *       逐字段严格校验后返回深度冻结的 RuntimeConfig；任何失败都以携带
 *       稳定错误码的 StructuredError 抛出，由启动编排层统一上报诊断。
 * 边界：只负责配置本体——不发起地图或数据源连接、不解析地图业务内容、
 *       不渲染任何 DOM、不读取 VITE_*（后者只允许开发默认值）。
 * 关键不变量：
 * 1. 配置 URL 一律以 document.baseURI（或注入 baseUrl）解析，因此同一构建
 *    产物天然支持根路径与子路径部署，无需重新构建；
 * 2. 校验是严格白名单：未知字段（含疑似密钥/令牌字段）直接拒绝，保证敏感
 *    凭据无法借配置文件进入前端；
 * 3. wsUrl 策略：dataSource='ws' 必须提供 wsUrl；HTTPS 页面只允许 wss: 或
 *    同源 https 安全代理地址，明文 ws:/http: 一律拒绝；
 * 4. 请求使用 no-cache：配置变更必须即时生效（缓存策略由静态服务器配合）；
 * 5. 取消（AbortError）原样向上抛出，不包装成配置错误。
 */
import { isFiniteNumber, isPlainObject } from '@/shared/validation'
import { describeError, isAbortError, StructuredError } from '@/shared/diagnostics'

/** 数据源形态：Mock 仿真（TASK-009）或真实 WebSocket（TASK-007） */
export type ConfigDataSource = 'mock' | 'ws'

/** 渲染器运行参数（质量策略在 render-quality Feature 内展开） */
export interface RendererConfig {
  maxDpr: number
  shadowMapSize: number
}

/** 统一二维仿射变换参数（业务语义解释归 TASK-003 的统一坐标） */
export interface CoordinateTransformConfig {
  scale: number
  rotation: number
  mirrorY: boolean
  translateX: number
  translateY: number
}

/** 校验后的运行时配置（深度冻结，禁止原地修改） */
export interface RuntimeConfig {
  dataSource: ConfigDataSource
  mapUrl: string
  wsUrl: string | null
  maxVehicles: number
  staleAfterMs: number
  renderer: RendererConfig
  coordinateTransform: CoordinateTransformConfig
}

/** 配置错误稳定代码（跨模块合同，调用方可按码分支处理） */
export type RuntimeConfigErrorCode =
  | 'CONFIG_FETCH_FAILED'
  | 'CONFIG_HTTP_STATUS'
  | 'CONFIG_JSON_PARSE'
  | 'CONFIG_FIELD'
  | 'CONFIG_UNKNOWN_FIELD'
  | 'CONFIG_WS_REQUIRED'
  | 'CONFIG_WS_INSECURE'

/** 与 index.html 同部署根目录的配置文件名（SPEC §10.1） */
export const DEFAULT_CONFIG_PATH = 'config.json'

/** 顶层字段白名单：未知字段一律拒绝，凭据无法借此进入配置 */
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'dataSource',
  'mapUrl',
  'wsUrl',
  'maxVehicles',
  'staleAfterMs',
  'renderer',
  'coordinateTransform',
])

const RENDERER_KEYS: ReadonlySet<string> = new Set(['maxDpr', 'shadowMapSize'])

const TRANSFORM_KEYS: ReadonlySet<string> = new Set([
  'scale',
  'rotation',
  'mirrorY',
  'translateX',
  'translateY',
])

const MAX_INT_31 = 2147483647

/** 将任意值收敛为可安全进入诊断上下文的短文本 */
function describeActual(actual: unknown): string {
  if (typeof actual === 'string') {
    return actual.slice(0, 120)
  }
  try {
    return JSON.stringify(actual)?.slice(0, 200) ?? String(actual)
  } catch {
    return String(actual)
  }
}

function fieldError(field: string, expected: string, actual: unknown): StructuredError {
  return new StructuredError({
    code: 'CONFIG_FIELD',
    message: `运行时配置字段 ${field} 非法：期望 ${expected}`,
    context: { field, expected, actual: describeActual(actual) },
  })
}

function configError(code: RuntimeConfigErrorCode, message: string, context: Record<string, unknown>): StructuredError {
  return new StructuredError({ code, message, context })
}

/** 深度冻结配置对象，保证运行期不可变 */
function deepFreeze<T>(value: T): T {
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key])
    }
    Object.freeze(value)
  }
  return value
}

/** 拒绝白名单之外的任何字段（含嵌套对象） */
function rejectUnknownKeys(
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw configError(
        'CONFIG_UNKNOWN_FIELD',
        `运行时配置出现未知字段 ${prefix}${key}；配置为公开白名单，禁止携带密钥、令牌等额外字段`,
        { field: `${prefix}${key}` },
      )
    }
  }
}

/** 校验非空字符串字段 */
function requireNonEmptyString(raw: Record<string, unknown>, field: string): string {
  const value = raw[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw fieldError(field, '非空字符串', value)
  }
  return value
}

/**
 * 校验 mapUrl：必须能以 baseUrl 解析，且最终协议为 http(s) 或相对路径。
 * 保留原始字符串返回；具体解析加载由地图 Feature 完成。
 */
function validateMapUrl(raw: Record<string, unknown>, baseUrl: string): string {
  const value = requireNonEmptyString(raw, 'mapUrl')
  let resolved: URL
  try {
    resolved = new URL(value, baseUrl)
  } catch {
    throw fieldError('mapUrl', '可解析的相对或 http(s) URL', value)
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw fieldError('mapUrl', '相对路径或 http(s) URL', value)
  }
  return value
}

/**
 * 校验 wsUrl 策略（SPEC §10.1）：
 * - dataSource='ws' 且 wsUrl 为 null → CONFIG_WS_REQUIRED；
 * - 合法形态为 ws://、wss:// 或相对地址；绝对 http(s) 仅允许「同源 https 代理」；
 * - HTTPS 页面上明文 ws: → CONFIG_WS_INSECURE。
 */
function validateWsUrl(raw: Record<string, unknown>, dataSource: ConfigDataSource, baseUrl: string): string | null {
  const value = raw.wsUrl
  if (value === null || value === undefined) {
    if (dataSource === 'ws') {
      throw configError('CONFIG_WS_REQUIRED', 'dataSource=ws 时必须提供 wsUrl', {
        field: 'wsUrl',
        dataSource,
      })
    }
    return null
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw fieldError('wsUrl', 'null 或非空字符串', value)
  }
  let resolved: URL
  try {
    resolved = new URL(value, baseUrl)
  } catch {
    throw fieldError('wsUrl', 'ws://、wss:// 或可解析的相对代理路径', value)
  }
  const page = new URL(baseUrl)
  if (resolved.protocol !== 'ws:' && resolved.protocol !== 'wss:') {
    // 非 ws/wss 绝对地址：仅同源 https 视为同源安全代理（SPEC §10.1）
    if (resolved.protocol === 'https:' && resolved.origin === page.origin) {
      return value
    }
    throw fieldError('wsUrl', 'ws://、wss:// 或同源 https 代理路径', value)
  }
  if (page.protocol === 'https:' && resolved.protocol === 'ws:') {
    throw configError('CONFIG_WS_INSECURE', 'HTTPS 页面禁止明文 ws: 连接，只允许 wss: 或同源安全代理', {
      field: 'wsUrl',
      resolved: resolved.href,
    })
  }
  return value
}

/** 校验有限正数值字段 */
function requirePositiveFinite(raw: Record<string, unknown>, key: string, field: string = key): number {
  const value = raw[key]
  if (!isFiniteNumber(value) || value <= 0) {
    throw fieldError(field, '正有限数值', value)
  }
  return value
}

/** 校验 ≥1 的整数（32 位安全范围内） */
function requirePositiveInteger(raw: Record<string, unknown>, key: string, field: string = key): number {
  const value = raw[key]
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 1 || value > MAX_INT_31) {
    throw fieldError(field, '≥1 且 ≤2147483647 的整数', value)
  }
  return value
}

/** 校验任意有限数值字段 */
function requireFinite(raw: Record<string, unknown>, key: string, field: string = key): number {
  const value = raw[key]
  if (!isFiniteNumber(value)) {
    throw fieldError(field, '有限数值', value)
  }
  return value
}

/** 校验布尔字段 */
function requireBoolean(raw: Record<string, unknown>, key: string, field: string = key): boolean {
  const value = raw[key]
  if (typeof value !== 'boolean') {
    throw fieldError(field, '布尔值', value)
  }
  return value
}

/**
 * 对已解析的 JSON 做严格白名单校验（纯函数，可独立单测）。
 * 校验失败按字段抛出携带稳定错误码的 StructuredError。
 */
export function validateRuntimeConfig(raw: unknown, baseUrl: string): RuntimeConfig {
  if (!isPlainObject(raw)) {
    throw fieldError('(root)', 'JSON 对象', raw)
  }
  rejectUnknownKeys(raw, TOP_LEVEL_KEYS, '')

  const dataSourceValue = raw.dataSource
  if (dataSourceValue !== 'mock' && dataSourceValue !== 'ws') {
    throw fieldError('dataSource', "'mock' 或 'ws'", dataSourceValue)
  }
  const dataSource: ConfigDataSource = dataSourceValue

  const mapUrl = validateMapUrl(raw, baseUrl)
  const wsUrl = validateWsUrl(raw, dataSource, baseUrl)
  const maxVehicles = requirePositiveInteger(raw, 'maxVehicles')
  const staleAfterMs = requirePositiveFinite(raw, 'staleAfterMs')

  const rendererRaw = raw.renderer
  if (!isPlainObject(rendererRaw)) {
    throw fieldError('renderer', '对象', rendererRaw)
  }
  rejectUnknownKeys(rendererRaw, RENDERER_KEYS, 'renderer.')
  const renderer: RendererConfig = {
    maxDpr: requirePositiveFinite(rendererRaw, 'maxDpr', 'renderer.maxDpr'),
    shadowMapSize: requirePositiveInteger(rendererRaw, 'shadowMapSize', 'renderer.shadowMapSize'),
  }

  const transformRaw = raw.coordinateTransform
  if (!isPlainObject(transformRaw)) {
    throw fieldError('coordinateTransform', '对象', transformRaw)
  }
  rejectUnknownKeys(transformRaw, TRANSFORM_KEYS, 'coordinateTransform.')
  const coordinateTransform: CoordinateTransformConfig = {
    scale: requirePositiveFinite(transformRaw, 'scale', 'coordinateTransform.scale'),
    rotation: requireFinite(transformRaw, 'rotation', 'coordinateTransform.rotation'),
    mirrorY: requireBoolean(transformRaw, 'mirrorY', 'coordinateTransform.mirrorY'),
    translateX: requireFinite(transformRaw, 'translateX', 'coordinateTransform.translateX'),
    translateY: requireFinite(transformRaw, 'translateY', 'coordinateTransform.translateY'),
  }

  return deepFreeze({
    dataSource,
    mapUrl,
    wsUrl,
    maxVehicles,
    staleAfterMs,
    renderer,
    coordinateTransform,
  })
}

export interface LoadRuntimeConfigOptions {
  /** 取消信号：中止后以 AbortError 拒绝，不产生配置错误 */
  signal?: AbortSignal
  /** fetch 注入点；默认全局 fetch，测试用桩替换 */
  fetchImpl?: typeof fetch
  /** 配置解析基准 URL；默认 document.baseURI，天然支持子路径部署 */
  baseUrl?: string
  /** 配置文件路径；默认 'config.json'（相对 baseUrl） */
  configPath?: string
}

/** 解析后的配置资源地址（供启动编排与测试断言） */
export interface ResolvedConfigUrl {
  href: string
}

/**
 * 读取并校验运行时配置。
 * 网络/HTTP/JSON/字段失败分别抛出 CONFIG_FETCH_FAILED / CONFIG_HTTP_STATUS /
 * CONFIG_JSON_PARSE / CONFIG_FIELD 等稳定代码；取消原样抛出 AbortError。
 */
export async function loadRuntimeConfig(
  options: LoadRuntimeConfigOptions = {},
): Promise<{ config: RuntimeConfig } & ResolvedConfigUrl> {
  const baseUrl = options.baseUrl ?? document.baseURI
  const configUrl = new URL(options.configPath ?? DEFAULT_CONFIG_PATH, baseUrl)
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))

  let response: Response
  try {
    // no-cache：配置必须每次向服务器确认新鲜度（SPEC §10.2）
    response = await fetchImpl(configUrl.href, {
      signal: options.signal,
      cache: 'no-cache',
    })
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    throw configError(
      'CONFIG_FETCH_FAILED',
      `读取运行时配置失败：${describeError(error)}`,
      { configUrl: configUrl.href },
    )
  }

  if (!response.ok) {
    throw configError('CONFIG_HTTP_STATUS', `运行时配置请求失败：HTTP ${response.status}`, {
      configUrl: configUrl.href,
      status: response.status,
    })
  }

  let text: string
  try {
    text = await response.text()
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    throw configError('CONFIG_FETCH_FAILED', `读取运行时配置响应失败：${describeError(error)}`, {
      configUrl: configUrl.href,
    })
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw configError('CONFIG_JSON_PARSE', `运行时配置不是合法 JSON：${describeError(error)}`, {
      configUrl: configUrl.href,
    })
  }

  return { config: validateRuntimeConfig(raw, baseUrl), href: configUrl.href }
}
