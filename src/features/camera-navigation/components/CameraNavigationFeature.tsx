/**
 * 相机导航 Feature 公开根组件（SPEC §5.5、§8、§12.3；TASK-013）。
 *
 * 职责：camera-navigation 在场景内的唯一公开根——把地图包围盒、只读跟随
 *       目标读取器与相机命令出口交给 useCameraNavigation，由后者自持
 *       OrbitControls、取景、跟随状态机与全部输入监听。本组件自身不渲染任
 *       何场景对象（返回 null），相机的存在完全体现在 R3F 默认相机的位姿上。
 * 边界：不读取车辆数据（跟随目标经注入的读取器获取）、不组合其他 Feature、
 *       不渲染 DOM；跟随请求的来源（车辆双击）由 app 组合层经 commandsRef
 *       转发，本组件不感知 fleet-monitoring。
 * 关键不变量：
 * 1. 本组件是唯一挂载点：重复挂载（StrictMode/地图恢复重挂载）时 Hook 内部
 *    对 controls、监听与命令出口做对称创建/释放，不产生重复监听；
 * 2. bounds 为 null（地图未就绪）时不取景也不设最大距离，相机保持 R3F 初
 *    始位姿——首个有效包围盒到达后一次性完成自动取景。
 */
import type { SceneBounds } from '@/features/map-visualization'
import type { FollowTargetReader } from '@/features/fleet-monitoring'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  useCameraNavigation,
  type CameraNavigationCommands,
} from '../hooks/useCameraNavigation'

export interface CameraNavigationFeatureProps {
  /** 地图场景包围盒；null 表示地图未就绪（保持相机初始位姿） */
  bounds: SceneBounds | null
  /** 只读跟随目标读取器；null 表示跟随不可用（命令进入后当帧退出） */
  readFollowTarget: FollowTargetReader | null
  /** 相机命令出口引用；app 组合层经它把双击跟随/俯瞰请求转交本 Feature */
  commandsRef?: { current: CameraNavigationCommands | null }
  /** 测试/诊断注入：暴露内部 OrbitControls 实例（只读观察，所有权不变） */
  controlsRef?: { current: OrbitControls | null }
  /** 拖拽退出跟随阈值（像素）；默认 6 */
  dragExitThresholdPx?: number
  /**
   * 相机交互能力就绪信号（TASK-017 启动编排）：OrbitControls、命令出口与
   * 输入监听装配完毕后调用一次（每个挂载实例至多一次）；app 组合层据此
   * 合成 appInteractive 启动阶段。
   */
  onReady?: () => void
}

export function CameraNavigationFeature(props: CameraNavigationFeatureProps): null {
  useCameraNavigation(props)
  return null
}
