/**
 * camera-navigation Feature 公开入口（SPEC §12.2～§12.4；TASK-013）。
 *
 * 职责：向 app 组合层暴露最小稳定合同：相机导航根组件、相机命令接口类型与
 *       最小距离常量。跟随目标的读取器类型来自 fleet-monitoring 公开入口
 *       （SPEC §12.4 依赖方向），本 Feature 只消费不转售。
 * 边界：外部模块只允许从这里导入本 Feature；内部文件（model/hooks 细分模
 *       块）不对 Feature 外暴露。不导出内部 zustand store——跨 Feature 协
 *       作只能经 app 组合层的命令引用与回调完成（禁止互读 Store）。
 * 关键不变量：命令接口是本 Feature 唯一的运行时入口；命令引用在 Feature 卸
 *       载时被置 null，持有方必须空值保护。
 */
export { CameraNavigationFeature } from './components/CameraNavigationFeature'
export type { CameraNavigationFeatureProps } from './components/CameraNavigationFeature'
export type { CameraNavigationCommands } from './hooks/useCameraNavigation'
export {
  CAMERA_MIN_DISTANCE_M,
  computeOverviewPose,
} from './model/overviewFraming'
export type { OverviewPose } from './model/overviewFraming'
