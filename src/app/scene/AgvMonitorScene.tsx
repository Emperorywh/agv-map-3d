// Canvas 内的 Feature 组合根（SPEC §12.3；TASK-004 接入地图 Feature，
// TASK-007 接入车队运行时 Provider，TASK-010 接入车辆实例渲染）。
// 职责：作为场景子树的唯一挂载点，以显式 props 组合各 Feature 根组件；
//       本组件用 FleetRuntimeProvider 在场景子树内持有车队高频运行时与数据
//       源连接生命周期（R3F 子树的 Context 只在这里向下可达），并把 app 注
//       入的世界变换转交 FleetMonitoringFeature（车辆放置的唯一坐标口径）。
//       后续 Task 在此追加标签、光环、交通资源、camera-navigation 等并以
//       适配器显式连接。
// 关键不变量：本组件只做组合；不解析协议、不发起网络请求、不读取运行时
// 配置，也不持有任何业务状态（启动状态由 App 持有并以描述符传入，数据源
// 实例由 App 按配置构造后传入，连接生命周期封装在 Provider 内部）。
import type { VehicleDataSource } from '@/features/fleet-monitoring'
import { FleetMonitoringFeature, FleetRuntimeProvider } from '@/features/fleet-monitoring'
import { MapVisualizationFeature, type MapViewDescriptor } from '@/features/map-visualization'
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
  /**
   * 车辆双击跟随请求上抛（实体键，TASK-012 暴露）：跟随的相机语义归
   * camera-navigation（TASK-013），组合层在那时接线；缺省时请求被丢弃。
   */
  onVehicleFollowRequest?: (entityKey: string) => void
}

export function AgvMonitorScene({
  mapDescriptor = null,
  vehicleSource = null,
  staleAfterMs,
  worldTransform = null,
  onVehicleFollowRequest,
}: AgvMonitorSceneProps) {
  return (
    <group name="agv-monitor-scene">
      <FleetRuntimeProvider source={vehicleSource} staleAfterMs={staleAfterMs}>
        <MapVisualizationFeature map={mapDescriptor} />
        <FleetMonitoringFeature
          worldTransform={worldTransform}
          onFollowRequest={onVehicleFollowRequest}
        />
      </FleetRuntimeProvider>
    </group>
  )
}
