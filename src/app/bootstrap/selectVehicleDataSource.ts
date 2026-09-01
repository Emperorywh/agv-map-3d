/**
 * 数据源选择（SPEC §10.3、§12.3；TASK-007 接入 WS 分支，Mock 分支属 TASK-009）。
 *
 * 职责：按运行时配置的 dataSource 字段构造对应的 VehicleDataSource 实例。
 *       本函数是 app 组合层与 fleet-monitoring 数据源实现之间的唯一装配点——
 *       真实后端协议字段被限制在 Feature 的 protocolAdapter 边界内，本模块
 *       只负责「选型 + 注入」，不承载连接行为。
 * 边界：只构造对象、不发起连接（连接由 FleetRuntimeProvider 的 Hook 在
 *       React 生命周期内建立）；Mock 分支在 TASK-009 落地前显式降级为
 *       null（无车队数据、静态地图照常），绝不伪造数据源。
 * 关键不变量：
 * 1. WS 数据源绑定启动时解析出的地图上下文（mapId），实体键 (mapId, agvKey)
 *    因此与地图模型一致（SPEC §2.4）；
 * 2. dataSource='ws' 而 wsUrl 缺失属于配置层已拦截的非法状态，此处纵深
 *    防御：记诊断并返回 null，绝不抛出中断启动；
 * 3. 返回 null 的语义统一为「本轮无车队数据」——地图场景必须照常渲染
 *    （SPEC §11.2：WS 无数据或断连不影响静态地图）。
 */
import type { DiagnosticsReporter } from '@/shared/diagnostics'
import {
  createUnmappedProtocolAdapter,
  createWebSocketVehicleDataSource,
  type VehicleDataSource,
  type WebSocketDataSourceOptions,
  type WebSocketFactory,
  type WebSocketProtocolAdapter,
} from '@/features/fleet-monitoring'
import type { RuntimeConfig } from './loadRuntimeConfig'

export interface SelectVehicleDataSourceOptions {
  /** 已校验的运行时配置（dataSource 与 wsUrl 的来源） */
  config: RuntimeConfig
  /** 启动时解析出的地图 ID：WS 事件与实体键的地图上下文 */
  mapId: string
  /** 诊断通道；缺省时仅构造、不上报 */
  diagnostics?: DiagnosticsReporter
  /** 协议适配器注入点；缺省用「未映射」默认适配器（真实映射属 TASK-021） */
  adapter?: WebSocketProtocolAdapter
  /** WebSocket 工厂注入点；测试用假 socket 替换 */
  socketFactory?: WebSocketFactory
}

/**
 * 按配置构造车辆数据源。
 * 返回 null 表示当前配置下没有可用数据源（Mock 未实现 / wsUrl 缺失），
 * 调用方以「无车队数据」稳态继续运行。
 */
export function selectVehicleDataSource(
  options: SelectVehicleDataSourceOptions,
): VehicleDataSource | null {
  const { config, mapId, diagnostics } = options

  if (config.dataSource === 'ws') {
    if (config.wsUrl === null) {
      // 配置校验层（CONFIG_WS_REQUIRED）已拦截；此处纵深防御不中断启动
      diagnostics?.report(
        'DATA_SOURCE_UNAVAILABLE',
        'warn',
        'dataSource=ws 但 wsUrl 缺失，本轮以无车队数据稳态运行',
        { dataSource: config.dataSource },
      )
      return null
    }
    const wsOptions: WebSocketDataSourceOptions = {
      wsUrl: config.wsUrl,
      mapId,
      adapter: options.adapter ?? createUnmappedProtocolAdapter(),
    }
    if (options.socketFactory !== undefined) {
      wsOptions.socketFactory = options.socketFactory
    }
    return createWebSocketVehicleDataSource(wsOptions)
  }

  // dataSource='mock'：Mock 数据源在 TASK-009 实现，当前显式降级为无车队数据
  diagnostics?.report(
    'DATA_SOURCE_UNAVAILABLE',
    'warn',
    'dataSource=mock 的仿真数据源尚未实现（TASK-009），本轮以无车队数据稳态运行',
    { dataSource: config.dataSource },
  )
  return null
}
