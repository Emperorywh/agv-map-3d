/**
 * §11 错误矩阵 → 页面展示视图模型（纯函数，无 React/DOM 依赖）。
 *
 * 输入为统一 error 状态携带的 §11 领域错误，输出 PageStateView 直接渲染的
 * 只读视图模型：分类标题、稳定错误码、中文摘要、明细行与动作按钮。
 *
 * 逐类展示内容（SPEC §11 错误表）：
 * - MapNetworkError：错误码 + 摘要
 * - MapHttpError：HTTP 状态（摘要内）+ 移除 query/hash 的请求 URL（fieldPath）
 * - MapParseError：解析错误码；摘要不包含原始响应内容（由 Worker 构造保证）
 * - MapEnvelopeError：错误码 + 字段路径
 * - MapValidationError：首个错误路径 + 摘要 + 错误总数
 * - MapCapacityError：实际值与上限
 * - MapGeometryError：边 id（fieldPath 与摘要内）+ 错误原因（摘要）
 * - SceneBuildError：提示不自动重试，重试时创建新 Worker
 * - WebGLUnavailableError：硬件/浏览器不支持提示；动作为「刷新页面」
 *
 * 动作规则：仅 WebGLUnavailableError 使用「刷新页面」（context lost 后不自动
 * 恢复旧场景，§11）；其余八类均为「重新加载」（每次点击只启动一个新请求，
 * loading/preparing 中禁用——禁用态由 PageStateView 按页面状态实施）。
 */

import {
  MapCapacityError,
  MapEnvelopeError,
  MapGeometryError,
  MapHttpError,
  MapNetworkError,
  MapParseError,
  MapValidationError,
  SceneBuildError,
  WebGLUnavailableError,
} from '../domain/errors'
import type { FactoryMapError } from '../domain/errors'

/** 错误明细行（字段路径/请求地址/实际值与上限等，无对应数据时该行不存在） */
export interface FactoryMapErrorDetail {
  readonly label: string
  readonly value: string
}

/** 动作按钮：retry=重新加载（状态机 retry）；reloadPage=刷新页面（整页刷新） */
export interface FactoryMapErrorAction {
  readonly kind: 'retry' | 'reloadPage'
  readonly label: string
}

export interface FactoryMapErrorViewModel {
  /** 错误分类标题（简体中文） */
  readonly title: string
  /** 稳定错误码（如 MAP_NODE_TYPE_INVALID） */
  readonly code: string
  /** 可展示的简体中文摘要 */
  readonly summary: string
  /** 明细行：HTTP URL、字段路径、错误总数、实际值/上限、附加提示 */
  readonly details: readonly FactoryMapErrorDetail[]
  readonly action: FactoryMapErrorAction
}

const RETRY_ACTION: FactoryMapErrorAction = { kind: 'retry', label: '重新加载' }
const RELOAD_PAGE_ACTION: FactoryMapErrorAction = { kind: 'reloadPage', label: '刷新页面' }

/** 可选字段路径行（MapHttpError 的请求 URL 也由 fieldPath 承载，label 由调用方指定） */
function fieldPathDetail(label: string, fieldPath: string | undefined): FactoryMapErrorDetail[] {
  return fieldPath === undefined ? [] : [{ label, value: fieldPath }]
}

/** 可选数值行（MapCapacityError 的 actual/limit 按 §11 展示实际值与上限） */
function numberDetail(label: string, value: number | undefined): FactoryMapErrorDetail[] {
  return value === undefined ? [] : [{ label, value: String(value) }]
}

/** §11 错误矩阵逐类映射；九类之外的 FactoryMapError 按「错误码 + 摘要 + 重新加载」展示 */
export function buildFactoryMapErrorViewModel(error: FactoryMapError): FactoryMapErrorViewModel {
  const base = { code: error.code, summary: error.message }

  if (error instanceof MapNetworkError) {
    return { ...base, title: '网络请求失败', details: [], action: RETRY_ACTION }
  }
  if (error instanceof MapHttpError) {
    // §11：HTTP 状态在摘要中（HTTP <status>（<url>）），URL 已移除 query/hash（fieldPath）
    return {
      ...base,
      title: '服务器响应错误',
      details: fieldPathDetail('请求地址', error.fieldPath),
      action: RETRY_ACTION,
    }
  }
  if (error instanceof MapParseError) {
    return { ...base, title: '地图数据解析失败', details: [], action: RETRY_ACTION }
  }
  if (error instanceof MapEnvelopeError) {
    return {
      ...base,
      title: '地图数据信封错误',
      details: fieldPathDetail('字段路径', error.fieldPath),
      action: RETRY_ACTION,
    }
  }
  if (error instanceof MapValidationError) {
    return {
      ...base,
      title: '地图数据校验失败',
      details: [
        ...fieldPathDetail('首个错误路径', error.fieldPath),
        { label: '错误总数', value: String(error.totalCount) },
      ],
      action: RETRY_ACTION,
    }
  }
  if (error instanceof MapCapacityError) {
    return {
      ...base,
      title: '地图数据超出容量上限',
      details: [
        ...numberDetail('实际值', error.actual),
        ...numberDetail('上限', error.limit),
      ],
      action: RETRY_ACTION,
    }
  }
  if (error instanceof MapGeometryError) {
    // §11：边 id 由 fieldPath（edges[].id=<edgeId>）与摘要共同承载，摘要含错误原因
    return {
      ...base,
      title: '地图几何构建失败',
      details: fieldPathDetail('出错路径', error.fieldPath),
      action: RETRY_ACTION,
    }
  }
  if (error instanceof SceneBuildError) {
    return {
      ...base,
      title: '三维场景构建失败',
      details: [{ label: '提示', value: '场景构建已终止，不会自动重试；点击「重新加载」将创建新的构建 Worker' }],
      action: RETRY_ACTION,
    }
  }
  if (error instanceof WebGLUnavailableError) {
    return {
      ...base,
      title: '无法初始化三维渲染',
      details: [{ label: '提示', value: '当前硬件或浏览器不支持 WebGL2，或渲染上下文已丢失；请更换环境后刷新页面' }],
      action: RELOAD_PAGE_ACTION,
    }
  }
  return { ...base, title: '地图加载失败', details: [], action: RETRY_ACTION }
}
