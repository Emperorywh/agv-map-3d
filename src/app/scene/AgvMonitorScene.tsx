// Canvas 内的 Feature 组合根（SPEC §12.3；TASK-004 接入地图 Feature，
// TASK-007 接入车队运行时 Provider，TASK-010 接入车辆实例渲染，TASK-013 接
// 入相机导航与跟随桥接）。
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
//          动取景与缩放上限提供唯一来源。
// 关键不变量：本组件只做组合与低频桥接（一个命令引用 + 一个运行时引用状态
// + 一个派生读取器），不解析协议、不发起网络请求、不读取运行时配置，也不持
// 有任何逐帧数据（跟随位姿由相机 Feature 的 ref 状态机逐帧读取）。
import { useMemo, useRef, useState } from 'react'
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
  MapVisualizationFeature,
  type MapViewDescriptor,
} from '@/features/map-visualization'
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
}

export function AgvMonitorScene({
  mapDescriptor = null,
  vehicleSource = null,
  staleAfterMs,
  worldTransform = null,
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

  // 相机取景与缩放上限的唯一包围盒来源：bootstrap 种子中的地图模型
  const sceneBounds = mapDescriptor?.initial?.mapModel.sceneBounds ?? null

  return (
    <group name="agv-monitor-scene">
      <CameraNavigationFeature
        bounds={sceneBounds}
        readFollowTarget={readFollowTarget}
        commandsRef={cameraCommandsRef}
      />
      <FleetRuntimeProvider
        source={vehicleSource}
        staleAfterMs={staleAfterMs}
        onRuntimeAvailable={setFleetRuntime}
      >
        <MapVisualizationFeature map={mapDescriptor} />
        <FleetMonitoringFeature
          worldTransform={worldTransform}
          onFollowRequest={(entityKey) => {
            // 跨 Feature 协作只发生在本组合层：双击跟随请求 → 相机命令
            cameraCommandsRef.current?.follow(entityKey)
          }}
        />
      </FleetRuntimeProvider>
    </group>
  )
}
