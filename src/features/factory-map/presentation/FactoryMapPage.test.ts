/**
 * FactoryMapPage 服务端渲染冒烟测试（SPEC §1.4、§5 场景架构树）。
 *
 * vitest 固定 node 环境、无 DOM/WebGL，本测试只覆盖 SSR 可及范围：
 * 页面容器宿主类名与「idle/loading/preparing/error → PageStateView」接线
 * （初始渲染即 idle → PageStateView，不产生 <canvas>）。ready/empty 的
 * FactoryScene（R3F Canvas 需 WebGL2）与 effect 驱动的真实加载流程由
 * 浏览器端验证（§15.2 / 用户手动验证）。
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

import { FactoryMapPage } from './FactoryMapPage'

describe('FactoryMapPage 页面容器（§1.4、§5）', () => {
  it('初始渲染：.factory-map-page 宿主 + idle 状态 PageStateView，无 canvas', () => {
    const html = renderToStaticMarkup(createElement(FactoryMapPage))
    expect(html).toContain('factory-map-page')
    // idle → PageStateView（初始化文案）；ready/empty 才挂 Canvas，此处不得出现
    expect(html).toContain('正在初始化…')
    expect(html).not.toContain('<canvas')
  })
})
