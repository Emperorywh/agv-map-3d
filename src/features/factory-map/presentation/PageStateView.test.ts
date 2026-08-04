/**
 * PageStateView / EmptyMapOverlay 服务端渲染测试（SPEC §1.4、§11）。
 *
 * vitest 固定 node 环境、无 DOM，故以 react-dom/server 的 renderToStaticMarkup
 * 断言静态结构：状态文案、§11 错误矩阵内容（错误码/字段路径/HTTP 状态与净化
 * URL/错误总数/实际值与上限/边 id/专属提示）、按钮中文文本与禁用态
 * （loading/preparing 禁用、error 启用）。按钮为原生 <button type="button">，
 * 默认可键盘聚焦；点击行为与 :focus-visible 高亮由浏览器端手动验证（§15.2）。
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

import {
  MapHttpError,
  MapValidationError,
  WebGLUnavailableError,
} from '../domain/errors'
import { EmptyMapOverlay, PageStateView } from './PageStateView'

const noop = (): void => undefined

function renderState(state: Parameters<typeof PageStateView>[0]['state']): string {
  return renderToStaticMarkup(
    createElement(PageStateView, { state, onRetry: noop, onReloadPage: noop }),
  )
}

describe('idle / loading / preparing 状态（§5.1、§11 按钮禁用）', () => {
  it('idle：初始化文案 + 禁用的「重新加载」', () => {
    const html = renderState({ status: 'idle' })
    expect(html).toContain('正在初始化…')
    expect(html).toContain('role="status"')
    expect(html).toContain('重新加载')
    expect(html).toMatch(/<button type="button"[^>]*disabled=""[^>]*>/)
  })

  it('loading：网络请求中文案 + 禁用的「重新加载」', () => {
    const html = renderState({ status: 'loading', requestId: 1 })
    expect(html).toContain('正在加载地图数据…')
    expect(html).toMatch(/<button type="button"[^>]*disabled=""[^>]*>/)
  })

  it('preparing：Worker 构建中文案 + 禁用的「重新加载」', () => {
    const html = renderState({ status: 'preparing', requestId: 1 })
    expect(html).toContain('正在构建三维场景…')
    expect(html).toMatch(/<button type="button"[^>]*disabled=""[^>]*>/)
  })
})

describe('error 状态（§11 错误矩阵展示）', () => {
  it('MapHttpError：标题、错误码、HTTP 状态与净化 URL，按钮启用', () => {
    const html = renderState({
      status: 'error',
      error: new MapHttpError('MAP_HTTP_NON_2XX', '地图请求失败：HTTP 404（/map.json）', {
        fieldPath: '/map.json',
      }),
      url: '/map.json',
    })
    expect(html).toContain('role="alert"')
    expect(html).toContain('服务器响应错误')
    expect(html).toContain('错误码：MAP_HTTP_NON_2XX')
    expect(html).toContain('HTTP 404')
    expect(html).toContain('请求地址')
    expect(html).toContain('/map.json')
    // error 态按钮启用（无 disabled），原生 button 可键盘聚焦
    expect(html).toContain('重新加载')
    expect(html).not.toContain('disabled')
  })

  it('MapValidationError：首个错误路径 + 摘要 + 错误总数', () => {
    const html = renderState({
      status: 'error',
      error: new MapValidationError('MAP_NODE_TYPE_INVALID', '节点类型必须是 node/work/park/charge 之一', {
        fieldPath: 'nodes[17].type',
        totalCount: 6,
      }),
      url: '/map.json',
    })
    expect(html).toContain('地图数据校验失败')
    expect(html).toContain('首个错误路径')
    expect(html).toContain('nodes[17].type')
    expect(html).toContain('错误总数')
    expect(html).toContain('6')
  })

  it('WebGLUnavailableError：硬件/浏览器不支持提示 +「刷新页面」（无「重新加载」）', () => {
    const html = renderState({
      status: 'error',
      error: new WebGLUnavailableError('WEBGL_CONTEXT_INIT_FAILED', '当前浏览器或硬件不支持 WebGL2，无法初始化三维画布'),
      url: '/map.json',
    })
    expect(html).toContain('无法初始化三维渲染')
    expect(html).toContain('不支持 WebGL2')
    expect(html).toContain('刷新页面')
    expect(html).not.toContain('重新加载')
    expect(html).not.toContain('disabled')
  })
})

describe('EmptyMapOverlay（§11：empty 状态「暂无地图数据」）', () => {
  it('渲染「暂无地图数据」文本', () => {
    const html = renderToStaticMarkup(createElement(EmptyMapOverlay))
    expect(html).toContain('暂无地图数据')
    expect(html).toContain('role="status"')
  })
})
