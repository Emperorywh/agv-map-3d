// Canvas 内的 Feature 组合根（SPEC §12.3；TASK-004 接入地图 Feature，
// TASK-007 接入车队运行时 Provider，TASK-010 接入车辆实例渲染，TASK-013 接
// 入相机导航与跟随桥接，TASK-014 接入自适应质量能力，TASK-016 接入上下文
// 恢复编排）。
// 职责：作为场景子树的唯一挂载点，以显式 props 组合各 Feature 根组件：
//       1. FleetRuntimeProvider 在场景子树内持有车队高频运行时与数据源连接
//          生命周期（R3F 子树的 Context 只在这里向下可达），并把 app 注入的
//          世界变换转交 FleetMonitoringFeature（车辆放置的唯一坐标口径）；
//       2. 跨 Feature 协作只发生在本组合层（SPEC §12.3）：车辆双击的跟随请
//          求经 FleetMonitoringFeature.onFollowRequest 转交相机命令引用；
//          相机的跟随目标由 fleet-monitoring 公开的只读读取器（运行时 + 世
//          界变换 + §2.5 车体中心口径）经 props 注入 camera-navigation，
//          两个 Feature 互不导入、互不感知；
//       3. 地图包围盒取自 bootstrap 种子（MapModel.sceneBounds），为相机自
//          动取景与缩放上限提供唯一来源；
//       4. 质量能力映射（SPEC §12.3「质量等级由组合层映射为标签、阴影和装
//          饰能力开关」）：订阅 render-quality 的只读质量等级，经
//          capabilitiesForLevel 映射为地图（阴影分辨率/动态阴影/装饰动画）
//          与车队（标签重点模式/交通锁脉冲）的显式 props；RenderQuality
//          Feature 挂在场景内采样帧时间并应用 DPR 上限；车队规模经只读运
//          行时 count 的闭包注入（决定目标帧率档位）；
//       5. 上下文恢复编排（TASK-016，SPEC §11.9）：app 状态机递增资源代经
//          contextGeneration 下发，MapVisualizationFeature（地图 → 环境）
//          与 FleetMonitoringFeature（车辆 → 标签 → 环 → 交通资源）在同一
//          React 提交内按确定顺序重建全部 GPU 资源；本组件持有「恢复期重
//          建失败」旗标（地图环境工厂失败时置位）并在资源代提交完成后一次
//          性结算上抛——React 子组件 effect 先于本组件 effect 执行，故结算
//          时全部所有者已落地；
//       6. 启动阶段合成（TASK-017，SPEC §10.3）：地图视图就绪 + 首批车辆
//          实例就绪 + 相机命令就绪三个一次性信号在本组合层汇合，齐备即上
//          报 appInteractive 阶段耗时（计时原点为 App 注入的启动起点）。
//          app 的诊断通道经 diagnostics 下发到各 Feature（geometry/instances
//          阶段由所有者就地计时上报）。
// 关键不变量：本组件只做组合与低频桥接（一个命令引用 + 一个运行时引用状态
// + 一个派生读取器 + 一个低频质量等级订阅 + 一个恢复失败旗标），不解析协
// 议、不发起网络请求、不读取运行时配置，也不持有任何逐帧数据（跟随位姿由
// 相机 Feature 的 ref 状态机逐帧读取；帧时间样本由 render-quality 的 ref 状
// 态机持有，SPEC §4）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CameraNavigationCommands } from '@/features/camera-navigation'
import { CameraNavigationFeature } from '@/features/camera-navigation'
import {
  createFollowTargetReader,
  FleetMonitoringFeature,
  FleetRuntimeProvider,
  type ReadonlyFleetRuntime,
  type VehicleDataSource,
} from '@/features/fleet-monitoring'
import {
  DEFAULT_SHADOW_MAP_SIZE,
  MapVisualizationFeature,
  type MapViewDescriptor,
} from '@/features/map-visualization'
import {
  capabilitiesForLevel,
  RenderQualityFeature,
  useQualityLevel,
} from '@/features/render-quality'
import type { DiagnosticsReporter } from '@/shared/diagnostics'
import type { WorldTransform } from '@/shared/spatial'

export interface AgvMonitorSceneProps {
  /** 地图视图描述符；null 表示启动尚未就绪或配置失败（保持清屏色） */
  mapDescriptor?: MapViewDescriptor | null
  /** 车辆数据源；null 表示当前配置下无车队数据（静态地图照常渲染） */
  vehicleSource?: VehicleDataSource | null
  /** 单车过期阈值（毫秒）；未就绪时缺省用运行时默认 10s */
  staleAfterMs?: number
  /** 地图世界变换（app 由 bootstrap 产物注入）；null 时车辆不渲染 */
  worldTransform?: WorldTransform | null
  /** 基准 DPR 上限（config.renderer.maxDpr）；未就绪时缺省 2 */
  maxDpr?: number
  /** 基准阴影贴图分辨率（config.renderer.shadowMapSize）；缺省 2048 */
  shadowMapSize?: number
  /**
   * GPU 资源代（TASK-016 上下文恢复；app 恢复状态机持有）：0 为初始挂载，
   * 上下文恢复/重试时递增；下发到两个 Feature 驱动其资源整代重建。
   */
  contextGeneration?: number
  /**
   * 恢复结算上抛（TASK-016）：资源代提交完成后调用一次——ok=false 表示恢
   * 复期内有所有者重建失败（当前为地图环境工厂），app 状态机据此累计失败
   * 并重试或放弃；资源代 0（初始挂载）不结算。
   */
  onContextRecoverySettled?: (ok: boolean) => void
  /**
   * 结构化诊断通道（TASK-017 启动阶段指标）：app 组合层的通道经此下发到
   * 各 Feature 与本组件的 appInteractive 上报；未注入时各 Feature 使用自
   * 己的默认通道（指标不可见但不影响行为）。
   */
  diagnostics?: DiagnosticsReporter
  /**
   * 启动起点（TASK-017）：App 挂载时刻的单调时钟读数（performance.now()，
   * 毫秒），是 appInteractive 阶段耗时的计时原点（对齐 B3「导航开始到
   * appInteractive」口径）。
   */
  startedAt?: number
}

export function AgvMonitorScene({
  mapDescriptor = null,
  vehicleSource = null,
  staleAfterMs,
  worldTransform = null,
  maxDpr = 2,
  shadowMapSize = DEFAULT_SHADOW_MAP_SIZE,
  contextGeneration = 0,
  onContextRecoverySettled,
  diagnostics,
  startedAt,
}: AgvMonitorSceneProps) {
  // 相机命令出口：车辆双击跟随请求的唯一转交通道（组合层桥接，不经过
  // Feature 间 Store 或事件总线）；引用在相机 Feature 卸载时被置 null。
  const cameraCommandsRef = useRef<CameraNavigationCommands | null>(null)

  // 只读运行时引用：Provider 就绪时经回调拿到一次（低频，仅此一次更新），
  // 用于构建跟随目标读取器；高频事件流不经过本组件。
  const [fleetRuntime, setFleetRuntime] = useState<ReadonlyFleetRuntime | null>(
    null,
  )

  // 跟随目标读取器：运行时与世界变换齐备时创建（引用随二者变化重建）；
  // 缺一为 null（跟随不可用，相机命令进入后当帧退出，静态场景不受影响）。
  const readFollowTarget = useMemo(
    () =>
      fleetRuntime === null || worldTransform === null
        ? null
        : createFollowTargetReader({ runtime: fleetRuntime, worldTransform }),
    [fleetRuntime, worldTransform],
  )

  // 车队规模读取器：render-quality 每帧经它取运行时 count（决定 60/30fps
  // 目标档位），无运行时按 0 台处理；闭包只依赖运行时引用（低频重建）。
  const readVehicleCount = useMemo(
    () => () => fleetRuntime?.count ?? 0,
    [fleetRuntime],
  )

  // 质量等级 → 能力开关映射（SPEC §12.3：等级订阅与映射只发生在组合层）。
  // 等级跃迁受迟滞冷却约束（降级 ≥5s、恢复 ≥30s），订阅是低频的。
  const qualityLevel = useQualityLevel()
  const capabilities = useMemo(
    () => capabilitiesForLevel(qualityLevel, { shadowMapSize }),
    [qualityLevel, shadowMapSize],
  )

  // 相机取景与缩放上限的唯一包围盒来源：bootstrap 种子中的地图模型
  const sceneBounds = mapDescriptor?.initial?.mapModel.sceneBounds ?? null

  // 恢复期重建失败旗标（TASK-016）：仅 MapVisualizationFeature 的环境工厂
  // 失败会置位（其余所有者的创建为纯 CPU 构造，无真实失败源；标签图集失败
  // 属持久环境缺陷，按既有降级语义处理不重复计入）。旗标按资源代消费后复
  // 位，绝不跨代累积。
  const recreateFailedRef = useRef(false)
  const handleContextRecreateFailed = useCallback((): void => {
    recreateFailedRef.current = true
  }, [])

  // 恢复结算（TASK-016）：每个资源代提交完成后恰好一次。React 子组件 effect
  // 先于本组件 effect 执行，此刻两个 Feature 的全部所有者已重建完毕，旗标
  // 即本代结果；资源代 0 是初始挂载（首次创建而非恢复重建），不结算。
  // 已结算代号记录使 StrictMode 双执行（setup→cleanup→setup）不产生重复结算。
  const lastSettledGenerationRef = useRef(-1)
  useEffect(() => {
    if (lastSettledGenerationRef.current === contextGeneration) {
      return
    }
    lastSettledGenerationRef.current = contextGeneration
    if (contextGeneration === 0) {
      return
    }
    onContextRecoverySettled?.(!recreateFailedRef.current)
    recreateFailedRef.current = false
  }, [contextGeneration, onContextRecoverySettled])

  // 启动阶段合成（TASK-017，SPEC §10.3 阶段 6）：appInteractive = 地图视图
  // 就绪（geometry 之后）+ 首批车辆实例就绪（拾取对象已存在）+ 相机命令就
  // 绪（OrbitControls 与监听已装配）三者齐备。三个信号都是会话级一次性低
  // 频事件，进入 React state 合法（SPEC §4 只禁高频）；上报一次性完成。
  const [readySignals, setReadySignals] = useState({
    map: false,
    fleet: false,
    camera: false,
  })
  const markMapReady = useCallback(() => {
    setReadySignals((prev) => (prev.map ? prev : { ...prev, map: true }))
  }, [])
  const markFleetReady = useCallback(() => {
    setReadySignals((prev) => (prev.fleet ? prev : { ...prev, fleet: true }))
  }, [])
  const markCameraReady = useCallback(() => {
    setReadySignals((prev) => (prev.camera ? prev : { ...prev, camera: true }))
  }, [])
  const appInteractiveReportedRef = useRef(false)
  useEffect(() => {
    if (appInteractiveReportedRef.current) {
      return
    }
    if (!(readySignals.map && readySignals.fleet && readySignals.camera)) {
      return
    }
    appInteractiveReportedRef.current = true
    diagnostics?.report('BOOTSTRAP_STAGE_APP_INTERACTIVE', 'info', '启动阶段耗时', {
      stage: 'appInteractive',
      ...(startedAt === undefined
        ? {}
        : { durationMs: performance.now() - startedAt }),
    })
  }, [readySignals, diagnostics, startedAt])

  return (
    <group name="agv-monitor-scene">
      <RenderQualityFeature
        readVehicleCount={readVehicleCount}
        maxDpr={maxDpr}
      />
      <CameraNavigationFeature
        bounds={sceneBounds}
        readFollowTarget={readFollowTarget}
        commandsRef={cameraCommandsRef}
        onReady={markCameraReady}
      />
      <FleetRuntimeProvider
        source={vehicleSource}
        staleAfterMs={staleAfterMs}
        onRuntimeAvailable={setFleetRuntime}
      >
        {/* 恢复重建顺序（TASK-016）：地图（五图层）→ 环境 → 车辆 → 标签 →
            环 → 交通资源——由「地图 Feature 在前、车队 Feature 在后」与各自
            内部图层顺序保证；资源代经 props 下发驱动整代重建。 */}
        <MapVisualizationFeature
          map={mapDescriptor}
          shadowMapSize={capabilities.shadowMapSize}
          dynamicShadowsEnabled={capabilities.dynamicShadowsEnabled}
          decorationsEnabled={capabilities.decorationsEnabled}
          contextGeneration={contextGeneration}
          onContextRecreateFailed={handleContextRecreateFailed}
          diagnostics={diagnostics}
          onFirstViewApplied={markMapReady}
        />
        <FleetMonitoringFeature
          worldTransform={worldTransform}
          importantLabelsOnly={capabilities.importantLabelsOnly}
          trafficPulseEnabled={capabilities.trafficPulseEnabled}
          contextGeneration={contextGeneration}
          diagnostics={diagnostics}
          onInstancesReady={markFleetReady}
          onFollowRequest={(entityKey) => {
            // 跨 Feature 协作只发生在本组合层：双击跟随请求 → 相机命令
            cameraCommandsRef.current?.follow(entityKey)
          }}
        />
      </FleetRuntimeProvider>
    </group>
  )
}
