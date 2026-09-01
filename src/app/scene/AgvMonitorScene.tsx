// Canvas 内的 Feature 组合根（SPEC §12.3；TASK-004 接入地图 Feature，
// TASK-007 接入车队运行时 Provider）。
// 职责：作为场景子树的唯一挂载点，以显式 props 组合各 Feature 根组件；
//       本组件用 FleetRuntimeProvider 在场景子树内持有车队高频运行时与数据
//       源连接生命周期（R3F 子树的 Context 只在这里向下可达），后续 Task
//       在此追加车辆渲染、camera-navigation 等并以适配器显式连接。
// 关键不变量：本组件只做组合；不解析协议、不发起网络请求、不读取运行时
// 配置，也不持有任何业务状态（启动状态由 App 持有并以描述符传入，数据源
// 实例由 App 按配置构造后传入，连接生命周期封装在 Provider 内部）。
import type { VehicleDataSource } from '@/features/fleet-monitoring'
import { FleetRuntimeProvider } from '@/features/fleet-monitoring'
import { MapVisualizationFeature, type MapViewDescriptor } from '@/features/map-visualization'

export interface AgvMonitorSceneProps {
  /** 地图视图描述符；null 表示启动尚未就绪或配置失败（保持清屏色） */
  mapDescriptor?: MapViewDescriptor | null
  /** 车辆数据源；null 表示当前配置下无车队数据（静态地图照常渲染） */
  vehicleSource?: VehicleDataSource | null
  /** 单车过期阈值（毫秒）；未就绪时缺省用运行时默认 10s */
  staleAfterMs?: number
}

export function AgvMonitorScene({
  mapDescriptor = null,
  vehicleSource = null,
  staleAfterMs,
}: AgvMonitorSceneProps) {
  return (
    <group name="agv-monitor-scene">
      <FleetRuntimeProvider source={vehicleSource} staleAfterMs={staleAfterMs}>
        <MapVisualizationFeature map={mapDescriptor} />
        {/* TASK-010 起在此追加 FleetMonitoringFeature（消费同一运行时） */}
      </FleetRuntimeProvider>
    </group>
  )
}
