// Canvas 内的 Feature 组合根（SPEC §12.3；TASK-004 接入地图 Feature）。
// 职责：作为场景子树的唯一挂载点，以显式 props 组合各 Feature 根组件；
//       TASK-004 阶段组合 map-visualization 公开根组件，后续 Task 在此
//       追加 fleet-monitoring、camera-navigation 等并以适配器显式连接。
// 关键不变量：本组件只做组合；不解析协议、不发起网络请求、不读取运行时
// 配置，也不持有任何业务状态（启动状态由 App 持有并以描述符传入）。
import { MapVisualizationFeature, type MapViewDescriptor } from '@/features/map-visualization'

export interface AgvMonitorSceneProps {
  /** 地图视图描述符；null 表示启动尚未就绪或配置失败（保持清屏色） */
  mapDescriptor?: MapViewDescriptor | null
}

export function AgvMonitorScene({ mapDescriptor = null }: AgvMonitorSceneProps) {
  return (
    <group name="agv-monitor-scene">
      <MapVisualizationFeature map={mapDescriptor} />
    </group>
  )
}
