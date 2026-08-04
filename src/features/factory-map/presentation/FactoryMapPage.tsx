/**
 * FactoryMapPage：页面容器与状态渲染（SPEC §1.4、§5、§5.1、§10.3、§11）。
 *
 * - 页面容器（§1.4）：.factory-map-page 固定占满 viewport（html/body/#root
 *   100%、margin 0、overflow hidden、color-scheme light，见 index.css）；
 *   position:relative 宿主同时承载 FactoryCanvas 与 DOM overlay。
 * - 状态渲染（§5 场景架构树）：idle/loading/preparing/error → PageStateView；
 *   ready/empty → FactoryScene；empty 额外叠加 EmptyMapOverlay「暂无地图数据」
 *   （厂房使用模型携带的 60×40m 空态 bounds，§6.1/§11）。
 * - 生命周期（§10.3）：挂载时 controller.start()，卸载时 controller.dispose()
 *   （abort 请求 + terminate Worker）；进入新一轮加载由状态机立即切换到
 *   loading，旧 SceneModel 随 FactoryScene 卸载——不保留旧画面（§11）。
 * - React 绑定：useSyncExternalStore 订阅控制器单一显式状态联合（§5.1）。
 *   React StrictMode 重复挂载：useState 惰性初始化可能被双调用，被丢弃的
 *   控制器无任何副作用（不 fetch、不建 Worker）；effect 的 start→dispose→start
 *   序列由状态机幂等承载，任一时刻至多一个在途请求与一个 Worker。
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'

import type { WebGLUnavailableError } from '../domain/errors'
import { FactoryScene } from '../rendering/scene/FactoryScene'
import { createBrowserFactoryMapPageController } from './FactoryMapPageController'
import { EmptyMapOverlay, PageStateView } from './PageStateView'

export function FactoryMapPage(): ReactElement {
  const [controller] = useState(() => createBrowserFactoryMapPageController())
  // 状态快照不可变（冻结对象），getSnapshot 缓存语义成立；第三参供 SSR/测试渲染
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)

  useEffect(() => {
    controller.start()
    return () => {
      controller.dispose()
    }
  }, [controller])

  const handleWebGLUnavailable = useCallback(
    (error: WebGLUnavailableError): void => controller.reportWebGLUnavailable(error),
    [controller],
  )
  const handleRetry = useCallback((): void => controller.retry(), [controller])
  const handleReloadPage = useCallback((): void => {
    window.location.reload()
  }, [])

  return (
    <div className="factory-map-page">
      {state.status === 'ready' || state.status === 'empty' ? (
        <>
          <FactoryScene model={state.model} onWebGLUnavailable={handleWebGLUnavailable} />
          {state.status === 'empty' ? <EmptyMapOverlay /> : null}
        </>
      ) : (
        <PageStateView state={state} onRetry={handleRetry} onReloadPage={handleReloadPage} />
      )}
    </div>
  )
}
