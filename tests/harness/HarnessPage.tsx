/**
 * HarnessPage：验收 harness 页面（SPEC §10.2/§15.2/§15.3，测试专用）。
 *
 * 与生产 FactoryMapPage 完全相同的组合与状态路由（同一控制器工厂、同一
 * PageStateView/EmptyMapOverlay/FactoryScene、同一生命周期效应），差异仅在：
 * - 控制器实例经 attachTestBridgeController 装配到测试桥（Playwright 侧因此
 *   能驱动新一轮加载、读取状态转换日志）；
 * - FactoryScene 传入 R3FBridge 作为验收组合缝 children（渲染器/相机探针）。
 *
 * 只存在于 tests/harness 构建（dist-harness），不进入生产包。
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'

import {
  EmptyMapOverlay,
  FactoryScene,
  PageStateView,
  createBrowserFactoryMapPageController,
} from '../../src/features/factory-map'
import type {
  SceneBuildError,
  WebGLUnavailableError,
} from '../../src/features/factory-map'
import { R3FBridge } from './R3FBridge'
import { attachTestBridgeController } from './installTestBridge'

export function HarnessPage(): ReactElement {
  // 与 FactoryMapPage 相同：useState 惰性初始化（StrictMode 双调用时被丢弃的
  // 控制器无任何副作用）；attach 效应只装配存活的实例
  const [controller] = useState(() => createBrowserFactoryMapPageController())
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)

  useEffect(() => attachTestBridgeController(controller), [controller])

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
  const handleSceneBuildError = useCallback(
    (error: SceneBuildError): void => controller.reportSceneBuildError(error),
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
          <FactoryScene
            model={state.model}
            onWebGLUnavailable={handleWebGLUnavailable}
            onSceneBuildError={handleSceneBuildError}
          >
            <R3FBridge />
          </FactoryScene>
          {state.status === 'empty' ? <EmptyMapOverlay /> : null}
        </>
      ) : (
        <PageStateView state={state} onRetry={handleRetry} onReloadPage={handleReloadPage} />
      )}
    </div>
  )
}
