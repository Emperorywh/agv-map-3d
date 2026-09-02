/**
 * 低频相机镜头状态 Store（SPEC §4、§12.2「model/cameraNavigationStore.ts —
 * 仅保存低频镜头状态」；TASK-013）。
 *
 * 职责：以独立 zustand store 持有 camera-navigation 的低频镜头状态——当前
 *       跟随的车辆实体键。跟随的进入/退出只发生在用户双击、拖拽、空格与
 *       目标删除等低频时刻，写频率与帧循环无关。
 * 边界：本 store 是 Feature 内部状态，不对外导出（跨 Feature 协作由 app 组
 *       合层经 commands/回调完成，禁止互读 Store）；不持有相机位置、目标世
 *       界坐标等逐帧数据——那些属于 useCameraNavigation 的 ref 与 Three 对
 *       象，绝不进入 React/zustand（SPEC §4）。
 * 关键不变量：
 * 1. 跟随键是实体键 (mapId, agvKey)，与 fleet-monitoring 的实体键同一编码；
 * 2. 写入幂等：键未变化时重复写入是 no-op，低频订阅者不被无变化通知打扰；
 * 3. 逐帧跟随更新不经过本 store——相机每帧读取的是注入的只读目标读取器，
 *    store 只在跟随状态机发生跃迁时被写一次。
 */
import { create } from 'zustand'

export interface CameraNavigationState {
  /** 当前跟随车辆的实体键；null 表示未跟随（自由轨道/俯瞰） */
  followedEntityKey: string | null
  /** 进入/切换跟随；传 null 退出跟随（幂等） */
  setFollowedEntityKey: (key: string | null) => void
}

export const useCameraNavigationStore = create<CameraNavigationState>(
  (set, get) => ({
    followedEntityKey: null,
    setFollowedEntityKey: (key) => {
      if (get().followedEntityKey !== key) {
        set({ followedEntityKey: key })
      }
    },
  }),
)
