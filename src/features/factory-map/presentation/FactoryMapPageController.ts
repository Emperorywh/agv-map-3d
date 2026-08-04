/**
 * 工厂地图页面控制器（SPEC §5.1、§10.3、§11）。
 *
 * 职责：
 * - 组合根：把 infrastructure 适配器（HttpMapRepository / WorkerScenePreparer）
 *   与 §13 配置常量装配为 application 用例端口，创建页面状态机；
 * - 生命周期（§10.3 PageController 行）：start 开始新一轮加载（状态机内部先
 *   abort 前一请求、terminate 正在 preparing 的 Worker、以单调 requestId 丢弃
 *   过期结果，且立即进入 loading 卸载旧 SceneModel——不保留旧画面）；页面卸载
 *   dispose（abort 请求 + terminate Worker，幂等）。dispose 只结束当前挂载周期
 *   的在途工作：React StrictMode 重复挂载的 cleanup→重新挂载序列中，下一次
 *   start 以全新状态机重新开始，任一时刻至多一个状态机持有请求/Worker；
 * - WebGL 终态错误通道：FactoryCanvas 上抛 WebGLUnavailableError（初始化失败 /
 *   context lost，§11）时进入 error 状态并 dispose 状态机——context lost 后不
 *   自动恢复旧场景、不自动重试，页面只提供「刷新页面」；该终态跨挂载周期保持，
 *   仅整页刷新可恢复。
 *
 * 对外暴露的页面状态始终是 application 的单一显式判别联合
 * （idle|loading|preparing|ready|empty|error，§5.1），WebGL 终态错误以最高
 * 优先级呈现为 error 状态；不引入布尔组合隐式状态。
 *
 * 本模块无 React/Three 依赖；React 绑定（useSyncExternalStore + 挂载/卸载效应）
 * 在 FactoryMapPage.tsx。
 */

import {
  createFactoryMapPageStateMachine,
  initialFactoryMapPageState,
} from '../application/factoryMapPageState'
import type { FactoryMapPageState } from '../application/factoryMapPageState'
import type { LoadFactoryMapPorts } from '../application/loadFactoryMap'
import { MAP_REQUEST_TIMEOUT_MS } from '../config/mapLoadConfig'
import { LABEL_ANCHOR_Y } from '../config/labelPolicy'
import {
  CHEVRON_MIN_PATH_LEN,
  CHEVRON_SPACING,
  CURVE_MAX_ERROR,
  CURVE_MAX_SEGMENT,
  FACTORY_MARGIN,
  MITER_LIMIT,
  PATH_WIDTH,
} from '../config/sceneMetrics'
import {
  STATION_CHARGE_COLOR,
  STATION_PARK_COLOR,
  STATION_WORK_COLOR,
} from '../config/visualTheme'
import type { WebGLUnavailableError } from '../domain/errors'
import { createHttpMapRepository, resolveDefaultMapUrl } from '../infrastructure/HttpMapRepository'
import { createMapBuildWorker, createWorkerScenePreparer } from '../infrastructure/worker/WorkerScenePreparer'
import type { SceneBuildOptions } from '../infrastructure/worker/builders/buildFactorySceneModel'

export interface FactoryMapPageController {
  /** 当前页面状态快照（与 subscribe 组合即 useSyncExternalStore 语义） */
  getState(): FactoryMapPageState
  /** 订阅状态变化；返回退订函数 */
  subscribe(listener: (state: FactoryMapPageState) => void): () => void
  /**
   * 开始新一轮加载（首次加载/地图切换）：状态机立即 abort 前一请求、
   * terminate 正在 preparing 的 Worker 并进入 loading（旧 SceneModel 随状态
   * 切换立即卸载，§11）。dispose 后的 start 以全新状态机重新开始
   * （StrictMode 重复挂载语义）；WebGL 终态错误后调用无效（页面只提供刷新）。
   */
  start(): void
  /** 重试：仅 error 态生效（§11），每次调用只启动一个新请求 */
  retry(): void
  /**
   * WebGL2/context 初始化失败或 context lost（§11）：进入 error 终态并
   * dispose 状态机（释放在途请求与 Worker）；幂等，首个错误优先；
   * 终态跨挂载周期保持，仅整页刷新可恢复。
   */
  reportWebGLUnavailable(error: WebGLUnavailableError): void
  /**
   * 结束当前挂载周期（页面卸载/StrictMode 模拟卸载）：abort 请求、
   * terminate Worker、状态复位 idle；幂等（§10.3）。之后的 start 重建状态机。
   */
  dispose(): void
}

export interface FactoryMapPageControllerOptions {
  /** 地图请求 URL（组合根经 resolveDefaultMapUrl 解析，§3.1） */
  readonly url: string
  /** 用例端口（测试注入 fake；浏览器经 createBrowserFactoryMapPageController 装配） */
  readonly ports: LoadFactoryMapPorts
}

export function createFactoryMapPageController(
  options: FactoryMapPageControllerOptions,
): FactoryMapPageController {
  const { url, ports } = options
  const listeners = new Set<(state: FactoryMapPageState) => void>()

  let machine = createFactoryMapPageStateMachine(ports)
  let machineState = machine.getState()
  /** WebGL 终态错误状态（§11）：非 null 时以最高优先级呈现，仅整页刷新可恢复 */
  let webglErrorState: FactoryMapPageState | null = null
  /** 当前挂载周期是否活跃：dispose 结束周期，start 重建状态机开启新周期 */
  let active = true

  const getState = (): FactoryMapPageState => webglErrorState ?? machineState

  const notify = (): void => {
    const state = getState()
    for (const listener of listeners) listener(state)
  }

  const attachMachine = (): void => {
    machineState = machine.getState()
    machine.subscribe((next) => {
      machineState = next
      notify()
    })
  }
  attachMachine()

  return {
    getState,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    start() {
      if (webglErrorState !== null) return
      if (!active) {
        // StrictMode 重复挂载：上一周期的状态机已随 dispose 释放全部资源，
        // 以全新状态机重新开始——任一时刻至多一个状态机持有请求/Worker（§10.3）
        machine = createFactoryMapPageStateMachine(ports)
        active = true
        attachMachine()
      }
      machine.startLoad(url)
    },

    retry() {
      if (!active || webglErrorState !== null) return
      machine.retry()
    },

    reportWebGLUnavailable(error) {
      if (!active || webglErrorState !== null) return
      webglErrorState = Object.freeze({ status: 'error', error, url })
      // §11：context lost 后不自动恢复、不自动重试——状态机就此终止并释放资源
      active = false
      machine.dispose()
      notify()
    },

    dispose() {
      if (!active) return
      active = false
      machine.dispose()
      machineState = initialFactoryMapPageState
    },
  }
}

// ---------------------------------------------------------------------------
// 浏览器组合根（§12：presentation 组装 infrastructure 适配器并注入 §13 常量）
// ---------------------------------------------------------------------------

/** §13 场景构建选项 → WorkerScenePreparer（infrastructure 不反向依赖 config，由本层注入） */
const BROWSER_SCENE_BUILD_OPTIONS: SceneBuildOptions = {
  factoryMargin: FACTORY_MARGIN,
  labelAnchorY: LABEL_ANCHOR_Y,
  path: {
    pathWidth: PATH_WIDTH,
    curveMaxError: CURVE_MAX_ERROR,
    curveMaxSegment: CURVE_MAX_SEGMENT,
    miterLimit: MITER_LIMIT,
    chevronSpacing: CHEVRON_SPACING,
    chevronMinPathLength: CHEVRON_MIN_PATH_LEN,
  },
  nodes: {
    stationColors: {
      work: STATION_WORK_COLOR,
      charge: STATION_CHARGE_COLOR,
      park: STATION_PARK_COLOR,
    },
  },
}

/**
 * 生产环境页面控制器：/map.json（或 VITE_MAP_URL）+ HttpMapRepository
 * （MAP_REQUEST_TIMEOUT_MS 硬超时）+ 每次加载新建 module Worker 的
 * WorkerScenePreparer（§5.1 取消语义：terminate + 新建）。
 */
export function createBrowserFactoryMapPageController(): FactoryMapPageController {
  return createFactoryMapPageController({
    url: resolveDefaultMapUrl(),
    ports: {
      repository: createHttpMapRepository({ timeoutMs: MAP_REQUEST_TIMEOUT_MS }),
      createPreparer: () =>
        createWorkerScenePreparer({
          createWorker: createMapBuildWorker,
          buildOptions: BROWSER_SCENE_BUILD_OPTIONS,
        }),
    },
  })
}
