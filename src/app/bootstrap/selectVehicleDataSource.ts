/**
 * 数据源选择（SPEC §10.3、§12.3；TASK-007 接入 WS 分支，TASK-009 接入
 * Mock 分支）。
 *
 * 职责：按运行时配置的 dataSource 字段构造对应的 VehicleDataSource 实例。
 *       本函数是 app 组合层与 fleet-monitoring / mock-simulation 数据源实现
 *       之间的唯一装配点——真实后端协议字段被限制在 Feature 的
 *       protocolAdapter 边界内，Mock 仿真被限制在 mock-simulation 内核之上，
 *       本模块只负责「选型 + 注入 + 开发桥注册」，不承载连接与仿真行为。
 * 边界：只构造对象、不发起连接（连接由 FleetRuntimeProvider 的 Hook 在
 *       React 生命周期内建立）；Mock 分支的创建以 MapModel 拓扑为硬前置
 *       （内核需要真实有向图），WS 分支不依赖该屏障——TASK-017 起 WS 分支
 *       可在地图加载完成前以 Promise 形态的 mapId 创建（与地图下载并行），
 *       Mock 分支仍必须等待 MapModel 就绪后由调用方创建。
 * 关键不变量：
 * 1. WS 数据源绑定启动时解析出的地图上下文（mapId），实体键 (mapId, agvKey)
 *    因此与地图模型一致（SPEC §2.4）；
 * 2. dataSource='ws' 而 wsUrl 不可用时创建静态车辆快照源；
 *    dataSource='mock' 而 mapModel 尚未就绪时返回 null，均不阻断地图；
 * 3. 返回 null 的语义统一为「本轮无车队数据」——地图场景必须照常渲染
 *    （SPEC §11.2：无数据或断连不影响静态地图）；
 * 4. 本模块保持纯工厂：不做任何全局副作用。`window.__AGV_MOCK__` 开发桥的
 *    注册归 App 组合层的提交阶段 effect（StrictMode 双渲染下 render 阶段
 *    创建的实例可能被丢弃，只有提交后的实例与连接生命周期一致）。
 */
import type { DiagnosticsReporter } from '@/shared/diagnostics'
import type { MapModel } from '@/features/map-visualization'
import {
  createDispatcherProtocolAdapter,
  createWebSocketVehicleDataSource,
  type VehicleDataSource,
  type WebSocketDataSourceOptions,
  type WebSocketFactory,
  type WebSocketProtocolAdapter,
} from '@/features/fleet-monitoring'
import { createMockVehicleDataSource } from '@/features/mock-simulation'
import type { RuntimeConfig } from './loadRuntimeConfig'
import { withStaticVehicleFallback } from './withStaticVehicleFallback'

export interface SelectVehicleDataSourceOptions {
  /** 已校验的运行时配置（dataSource 与 wsUrl 的来源） */
  config: RuntimeConfig
  /**
   * 启动时解析出的地图 ID：WS 事件与实体键的地图上下文。支持 Promise 形态
   * （TASK-017 并行初始化）：dataSource='ws' 时可在地图加载完成前创建数据源，
   * mapId 由启动编排的地图上下文 promise 异步绑定（见 WS 数据源延迟绑定语义）。
   */
  mapId: string | Promise<string>
  /**
   * 地图模型：Mock 分支的必需输入（内核在其有向拓扑上分配与行驶）；
   * WS 分支不消费。Mock 必须在 MapModel 拓扑就绪后创建（SPEC §10.3）。
   */
  mapModel?: MapModel
  /** 诊断通道；缺省时仅构造、不上报 */
  diagnostics?: DiagnosticsReporter
  /** 协议适配器注入点；缺省用调度监控真实协议适配器（mapId 延迟绑定透传） */
  adapter?: WebSocketProtocolAdapter
  /** WebSocket 工厂注入点；测试用假 socket 替换 */
  socketFactory?: WebSocketFactory
}

/**
 * 按配置构造车辆数据源。
 * 返回 null 表示 Mock 尚缺地图拓扑，调用方以无车队数据稳态继续运行。
 * wsUrl 不可用时仍返回静态快照源，使车辆兜底与地图加载同时可用。
 */
export function selectVehicleDataSource(
  options: SelectVehicleDataSourceOptions,
): VehicleDataSource | null {
  const { config, mapId, diagnostics } = options

  if (config.dataSource === 'ws') {
    if (config.wsUrl === null) {
      // 实时连接配置已被降级为不可用，直接复用本地车辆快照加载流程。
      // 不创建 WebSocket，也不因返回空数据源而绕过已有车辆兜底。
      diagnostics?.report(
        'DATA_SOURCE_UNAVAILABLE',
        'warn',
        '实时车辆地址不可用，已启用本地车辆快照',
        { dataSource: config.dataSource },
      )
      return withStaticVehicleFallback(null, mapId, config.staleAfterMs, diagnostics)
    }
    const wsOptions: WebSocketDataSourceOptions = {
      wsUrl: config.wsUrl,
      mapId,
      // 默认绑定调度监控真实协议适配器（订阅帧 = 裸地图 ID，全量快照推送）；
      // injection 点仍允许测试以假适配器替换
      adapter: options.adapter ?? createDispatcherProtocolAdapter({ mapId, diagnostics }),
    }
    if (options.socketFactory !== undefined) {
      wsOptions.socketFactory = options.socketFactory
    }
    // 实时连接不可用时使用本地车辆列表，保持快照中的位置与朝向。
    // 回退包装保留后台重连，收到真实全量快照后自动恢复实时显示。
    return withStaticVehicleFallback(
      createWebSocketVehicleDataSource(wsOptions), mapId, config.staleAfterMs, diagnostics,
    )
  }

  // dataSource='mock'：内核需要真实拓扑，MapModel 未就绪时降级为无车队数据
  // （Mock 必须在 MapModel 拓扑就绪后创建；WS 初始化不受该屏障限制）
  if (!options.mapModel) {
    diagnostics?.report(
      'DATA_SOURCE_UNAVAILABLE',
      'warn',
      'dataSource=mock 但地图拓扑尚未就绪（Mock 必须在 MapModel 就绪后创建），本轮以无车队数据稳态运行',
      { dataSource: config.dataSource },
    )
    return null
  }
  const source = createMockVehicleDataSource({
    mapModel: options.mapModel,
    diagnostics,
  })
  return source
}
