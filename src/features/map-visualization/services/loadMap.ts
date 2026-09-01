/**
 * 地图资源读取（SPEC §10.2、§10.3、§11.10；TASK-003）。
 *
 * 职责：以运行时 mapUrl 拉取地图 JSON，依次完成「URL 解析 → 网络读取 →
 *       HTTP 状态 → JSON 解析 → 字段与引用校验 → 索引建模」，返回只读
 *       MapModel、世界变换与逐项异常记录。
 * 边界：只负责地图资源这一条加载链路；不解析车辆数据、不建立数据源连接、
 *       不渲染任何 DOM、不内置重试（恢复生命周期归 TASK-004 的地图 Hook）。
 * 关键不变量：
 * 1. mapUrl 与 config.json 一样以 document.baseURI（或注入 baseUrl）解析，
 *    因此同一构建产物在根路径与子路径部署下读取同一相对地址；
 * 2. 每种失败都有稳定错误码：MAP_URL_INVALID / MAP_FETCH_FAILED /
 *    MAP_HTTP_STATUS / MAP_JSON_PARSE / MAP_ROOT_INVALID，取消（AbortError）
 *    原样上抛，不包装、不上报为地图错误；
 * 3. 请求不强制绕过缓存：map.json 由静态服务器按版本化缓存策略控制
 *    （config.json 才要求 no-cache），前端不静默绕过跨域或缓存语义；
 * 4. 校验异常（anomalies）只随结果返回，由调用方统一写入诊断通道；
 *    建模本身不因 warn 级异常失败。
 */
import { StructuredError, describeError, isAbortError } from '@/shared/diagnostics'
import type { AffineParams, WorldTransform } from '@/shared/spatial'
import { validateMap } from '../model/validateMap'
import { createMapModel } from '../model/createMapModel'
import type { MapAnomaly, MapModel } from '../model/types'

export interface LoadMapOptions {
  /** 已校验的运行时 mapUrl（相对或绝对 http(s) 地址） */
  mapUrl: string
  /** 运行时二维仿射参数；缺省为恒等变换 */
  coordinateTransform?: AffineParams
  /** 取消信号：中止后以 AbortError 拒绝 */
  signal?: AbortSignal
  /** fetch 注入点；默认全局 fetch，测试用桩替换 */
  fetchImpl?: typeof fetch
  /** 解析基准 URL；默认 document.baseURI，天然支持子路径部署 */
  baseUrl?: string
}

export interface LoadMapResult {
  readonly mapModel: MapModel
  readonly worldTransform: WorldTransform
  /** 实际使用的地图资源 URL（根路径与子路径部署下不同） */
  readonly url: string
  /** 逐项隔离产生的数据异常（不含致命错误；由调用方上报诊断） */
  readonly anomalies: readonly MapAnomaly[]
}

function mapError(code: string, message: string, context: Record<string, unknown>): StructuredError {
  return new StructuredError({ code, message, context })
}

export async function loadMap(options: LoadMapOptions): Promise<LoadMapResult> {
  const baseUrl = options.baseUrl ?? document.baseURI
  let mapUrl: URL
  try {
    mapUrl = new URL(options.mapUrl, baseUrl)
  } catch {
    throw mapError('MAP_URL_INVALID', `mapUrl 无法以部署基准地址解析：${options.mapUrl}`, {
      mapUrl: options.mapUrl,
      baseUrl,
    })
  }
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))

  let response: Response
  try {
    response = await fetchImpl(mapUrl.href, { signal: options.signal })
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    throw mapError('MAP_FETCH_FAILED', `读取地图资源失败：${describeError(error)}`, {
      mapUrl: mapUrl.href,
    })
  }

  if (!response.ok) {
    throw mapError('MAP_HTTP_STATUS', `地图资源请求失败：HTTP ${response.status}`, {
      mapUrl: mapUrl.href,
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
    throw mapError('MAP_FETCH_FAILED', `读取地图响应失败：${describeError(error)}`, {
      mapUrl: mapUrl.href,
    })
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw mapError('MAP_JSON_PARSE', `地图资源不是合法 JSON：${describeError(error)}`, {
      mapUrl: mapUrl.href,
    })
  }

  // 根结构致命错误（MAP_ROOT_INVALID）原样上抛；逐项异常随结果返回
  const validated = validateMap(raw)
  const { mapModel, worldTransform } = createMapModel(validated, {
    coordinateTransform: options.coordinateTransform,
  })

  return {
    mapModel,
    worldTransform,
    url: mapUrl.href,
    anomalies: validated.anomalies,
  }
}
