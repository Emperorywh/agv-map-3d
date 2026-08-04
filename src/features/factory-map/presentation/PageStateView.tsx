/**
 * PageStateView：页面状态 DOM 视图（SPEC §1.4、§5、§11）。
 *
 * - idle / loading / preparing / error 状态渲染为 Canvas 上方的普通 DOM overlay
 *   （§1.4）；ready / empty 不经过本组件（由 FactoryMapPage 渲染 FactoryScene，
 *   empty 的「暂无地图数据」由 EmptyMapOverlay 叠加）。
 * - 状态文案：idle「正在初始化…」、loading「正在加载地图数据…」（网络请求中）、
 *   preparing「正在构建三维场景…」（Worker 校验构建中，§5.1）。
 * - error 状态按 §11 错误矩阵渲染（视图模型由 errorViewModel.ts 纯函数产出）：
 *   分类标题、稳定错误码、中文摘要、明细行（HTTP 状态与净化 URL / 字段路径 /
 *   错误总数 / 实际值与上限 / 边 id / 专属提示）与动作按钮。
 * - 动作按钮（§11）：「重新加载」（八类可重试错误）每次点击只启动一个新请求；
 *   「刷新页面」（WebGLUnavailableError）整页刷新。按钮为原生 <button>，可键盘
 *   聚焦并带 :focus-visible 高亮；loading/preparing 状态禁用，避免并发隐式状态。
 */

import type { ReactElement } from 'react'

import type { FactoryMapPageState } from '../application/factoryMapPageState'
import { buildFactoryMapErrorViewModel } from './errorViewModel'
import './pageStateView.css'

/** 本组件渲染的状态子集（ready/empty 由 FactoryScene 承担） */
export type PageStateViewState = Exclude<
  FactoryMapPageState,
  { readonly status: 'ready' } | { readonly status: 'empty' }
>

export interface PageStateViewProps {
  readonly state: PageStateViewState
  /** 「重新加载」：状态机 retry（仅 error 态可用；每次只启动一个新请求） */
  readonly onRetry: () => void
  /** 「刷新页面」：WebGLUnavailableError 终态的整页刷新 */
  readonly onReloadPage: () => void
}

/** idle / loading / preparing 状态文案（§5.1 状态语义；error 不经过本映射） */
const STATUS_TEXT: Record<Exclude<PageStateViewState['status'], 'error'>, string> = {
  idle: '正在初始化…',
  loading: '正在加载地图数据…',
  preparing: '正在构建三维场景…',
}

export function PageStateView({ state, onRetry, onReloadPage }: PageStateViewProps): ReactElement {
  if (state.status !== 'error') {
    // idle / loading / preparing：状态文案 + 禁用的「重新加载」（§11：避免并发隐式状态）
    return (
      <div className="page-state-view">
        <div className="page-state-view__panel" role="status">
          <p className="page-state-view__status">{STATUS_TEXT[state.status]}</p>
          <button type="button" className="page-state-view__button" disabled onClick={onRetry}>
            重新加载
          </button>
        </div>
      </div>
    )
  }

  const view = buildFactoryMapErrorViewModel(state.error)
  const handleAction = view.action.kind === 'reloadPage' ? onReloadPage : onRetry
  return (
    <div className="page-state-view">
      <div className="page-state-view__panel page-state-view__panel--error" role="alert">
        <h1 className="page-state-view__title">{view.title}</h1>
        <p className="page-state-view__code">错误码：{view.code}</p>
        <p className="page-state-view__summary">{view.summary}</p>
        {view.details.length > 0 ? (
          <dl className="page-state-view__details">
            {view.details.map((detail) => (
              <div key={detail.label} className="page-state-view__detail-row">
                <dt className="page-state-view__detail-label">{detail.label}</dt>
                <dd className="page-state-view__detail-value">{detail.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <button type="button" className="page-state-view__button" onClick={handleAction}>
          {view.action.label}
        </button>
      </div>
    </div>
  )
}

/**
 * EmptyMapOverlay：empty 状态叠加在 FactoryScene 上方的普通 DOM overlay
 *（§5 场景架构树、§11：nodes 与 edges 同时为空 → 渲染 60×40m 空厂房并显示
 * 「暂无地图数据」）。pointer-events:none，不遮挡相机漫游。
 */
export function EmptyMapOverlay(): ReactElement {
  return (
    <div className="empty-map-overlay" role="status">
      <p className="empty-map-overlay__text">暂无地图数据</p>
    </div>
  )
}
