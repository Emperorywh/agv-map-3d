/**
 * 领域稳定错误码体系（SPEC §3.3、§11）。
 *
 * 每个错误对象携带：
 * - code：稳定错误码（如 MAP_NODE_TYPE_INVALID），跨版本不变，供页面/日志识别
 * - fieldPath：字段路径（如 nodes[17].type），定位首个非法输入
 * - message：可展示的简体中文摘要
 *
 * 上层按错误类名（name）映射 §11 的页面行为；解码器不得忽略坏记录继续，
 * 也不得把未知值降级转换为其他合法类型。
 */

export interface FactoryMapErrorOptions {
  /** 字段路径，如 nodes[17].type、edges[3].cx、data.currentMapInfoVersion.mapJson */
  readonly fieldPath?: string
  /** 原始底层错误（如网络/解析异常） */
  readonly cause?: unknown
}

/** 全部领域错误的公共基类；code 与 fieldPath 不可变 */
export class FactoryMapError extends Error {
  readonly code: string
  readonly fieldPath: string | undefined

  constructor(name: string, code: string, summary: string, options?: FactoryMapErrorOptions) {
    super(summary)
    this.name = name
    this.code = code
    this.fieldPath = options?.fieldPath
    if (options?.cause !== undefined) {
      this.cause = options.cause
    }
  }
}

/** 网络失败、15 秒超时、请求被意外中断（§11） */
export class MapNetworkError extends FactoryMapError {
  constructor(code: string, summary: string, options?: FactoryMapErrorOptions) {
    super('MapNetworkError', code, summary, options)
  }
}

/** HTTP 非 2xx（§11） */
export class MapHttpError extends FactoryMapError {
  constructor(code: string, summary: string, options?: FactoryMapErrorOptions) {
    super('MapHttpError', code, summary, options)
  }
}

/** 非法 UTF-8 或 JSON 语法错误（§11） */
export class MapParseError extends FactoryMapError {
  constructor(code: string, summary: string, options?: FactoryMapErrorOptions) {
    super('MapParseError', code, summary, options)
  }
}

/** code 非 200、信封或 mapJson 缺失（§3.1、§11） */
export class MapEnvelopeError extends FactoryMapError {
  constructor(code: string, summary: string, options?: FactoryMapErrorOptions) {
    super('MapEnvelopeError', code, summary, options)
  }
}

export interface MapValidationErrorOptions extends FactoryMapErrorOptions {
  /** 本次校验发现的错误总数（字段级错误批量收集时为实际数量；单发错误为 1，§11） */
  readonly totalCount?: number
}

/** §3.3 任一数据不变量失败 */
export class MapValidationError extends FactoryMapError {
  readonly totalCount: number

  constructor(code: string, summary: string, options?: MapValidationErrorOptions) {
    super('MapValidationError', code, summary, options)
    this.totalCount = options?.totalCount ?? 1
  }

  /** 返回携带错误总数的新实例（字段级错误收集完成后由解码器抛出首个错误） */
  withTotalCount(totalCount: number): MapValidationError {
    return new MapValidationError(this.code, this.message, {
      fieldPath: this.fieldPath,
      totalCount,
    })
  }
}

export interface MapCapacityErrorOptions extends FactoryMapErrorOptions {
  /** 实际值（§11：页面显示实际值与上限） */
  readonly actual?: number
  /** 上限值 */
  readonly limit?: number
}

/** payload 超 20MiB、元素总数超 20000 或地图范围超 220m（§3.3、§11） */
export class MapCapacityError extends FactoryMapError {
  readonly actual: number | undefined
  readonly limit: number | undefined

  constructor(code: string, summary: string, options?: MapCapacityErrorOptions) {
    super('MapCapacityError', code, summary, options)
    this.actual = options?.actual
    this.limit = options?.limit
  }
}

/** 自适应细分、条带或实例数据无法产生有限结果（§7.1、§11） */
export class MapGeometryError extends FactoryMapError {
  constructor(code: string, summary: string, options?: FactoryMapErrorOptions) {
    super('MapGeometryError', code, summary, options)
  }
}

/** Worker 崩溃或主线程绑定资源失败（§11） */
export class SceneBuildError extends FactoryMapError {
  constructor(code: string, summary: string, options?: FactoryMapErrorOptions) {
    super('SceneBuildError', code, summary, options)
  }
}

/** WebGL2/context 初始化失败或 context lost（§11） */
export class WebGLUnavailableError extends FactoryMapError {
  constructor(code: string, summary: string, options?: FactoryMapErrorOptions) {
    super('WebGLUnavailableError', code, summary, options)
  }
}
