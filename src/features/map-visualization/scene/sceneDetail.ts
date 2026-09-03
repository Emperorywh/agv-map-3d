/**
 * 三级场景细节层级（视觉对齐改造 P0-5.1）。
 *
 * 职责：定义监控场景统一的「当前应该展示什么」细节等级——全厂总览(0) /
 *       作业区(1) / 车辆近景(2)，并提供带迟滞的等级判定纯函数与各节点展示
 *       角色的最低可见等级。几何构建层用 ROLE_MIN_SCENE_LEVEL 把角色烘焙成
 *       实例属性；材质注入 uSceneLevel 共享 uniform，由场景侧控制器逐帧写
 *       入，GPU 侧完成按等级显隐。
 * 边界：本模块是纯数学与常量，不持有相机、不进 React、不创建 Three 对象；
 *       与 render-quality 的「设备性能不足时关闭什么」正交——两者不得复用
 *       同一状态或等级（改造说明 §5.1）。
 * 关键不变量：
 * 1. 等级判定带迟滞：升级与降级使用不同阈值，在阈值区间内保持当前等级，
 *       避免相机在临界距离附近推拉时层级频繁闪烁；
 * 2. 等级只升不跳级无感知差异：从总览快速拉近会经一帧作业区再进近景
 *       （uniform 逐帧重写，无过渡动画），行为可预测；
 * 3. 场景对角线缩放阈值：同一比例适用于任何尺度的地图。
 */
import type { NodeVisualRole } from '../model/types'

/** 场景细节等级：0=全厂总览 1=作业区 2=车辆近景 */
export type SceneDetailLevel = 0 | 1 | 2

/** 总览 → 作业区的进入阈值（聚焦距离 / 场景对角线） */
export const ZONE_ENTER_DIAGONAL_RATIO = 0.45
/** 作业区 → 总览的降级阈值（迟滞：高于进入阈值才回总览） */
export const ZONE_EXIT_DIAGONAL_RATIO = 0.55
/** 作业区 → 近景的进入阈值 */
export const CLOSEUP_ENTER_DIAGONAL_RATIO = 0.15
/** 近景 → 作业区的降级阈值（迟滞） */
export const CLOSEUP_EXIT_DIAGONAL_RATIO = 0.2

/**
 * 带迟滞的场景细节等级判定。
 * @param previous 当前等级（迟滞基准）
 * @param focusDistanceM 相机到关注地面点的距离（米）
 * @param diagonalM 场景包围盒对角线（米）
 */
export function resolveSceneDetailLevel(
  previous: SceneDetailLevel,
  focusDistanceM: number,
  diagonalM: number,
): SceneDetailLevel {
  const diagonal = Math.max(diagonalM, 1)
  const zoneEnter = ZONE_ENTER_DIAGONAL_RATIO * diagonal
  const zoneExit = ZONE_EXIT_DIAGONAL_RATIO * diagonal
  const closeEnter = CLOSEUP_ENTER_DIAGONAL_RATIO * diagonal
  const closeExit = CLOSEUP_EXIT_DIAGONAL_RATIO * diagonal

  switch (previous) {
    case 0:
      return focusDistanceM < zoneEnter ? 1 : 0
    case 1:
      if (focusDistanceM >= zoneExit) {
        return 0
      }
      return focusDistanceM < closeEnter ? 2 : 1
    case 2:
      if (focusDistanceM >= zoneExit) {
        return 0
      }
      return focusDistanceM >= closeExit ? 1 : 2
  }
}

/**
 * 各节点展示角色的最低可见场景等级：场景等级 ≥ 该值时角色可见。
 * - route-control / storage-slot 仅近景显示（导航控制点与单个库位标识）；
 * - junction / work-station / park 自作业区起显示；
 * - charge / landmark 全等级显示（charge 另有自己的投影尺寸淡出）。
 * 展示角色缺失时（手工构建的测试模型），构建层回退为 landmark（全可见）。
 */
export const ROLE_MIN_SCENE_LEVEL: Record<NodeVisualRole, SceneDetailLevel> = {
  'route-control': 2,
  junction: 1,
  'work-station': 1,
  'storage-slot': 2,
  charge: 0,
  park: 1,
  landmark: 0,
}
