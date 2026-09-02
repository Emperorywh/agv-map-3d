/**
 * 只读跟随目标适配器（SPEC §5.5、§8、§12.3/§12.4；TASK-013）。
 *
 * 职责：向 camera-navigation（经 app 组合层注入）提供「实体键 → 车体中心当
 *       前世界坐标」的只读读取器——相机跟随每帧经它取数。坐标合成完全复用
 *       车辆渲染的 computeVehicleWorldPose（§2.5 centerOffset 位移与
 *       rotation.y 同一口径），保证跟随点与渲染车体中心严格一致。
 * 边界：纯函数工厂，无 React、无 Three 场景对象；只读运行时视图 + 注入的
 *       世界变换是仅有的输入，本模块绝不含任何写入通道。
 * 关键不变量：
 * 1. 跟随点恒等于渲染车体中心：两者都出自 computeVehicleWorldPose，任何一
 *    方的口径变化都会破坏对齐——本文件不改写坐标公式；
 * 2. 读取器对一切未知键与无效状态返回 null（绝不抛出）：实体已删除、位置
 *    非法（positionValid=false）或合成结果非有限时，相机跟随据此当帧退出；
 * 3. 每次调用即时读取运行时最新快照——跟随目标移动时相机逐帧对齐最新位
 *    置，不缓存、不插值（附录 A「车辆实时位置不插值、不推算」）。
 */
import type { WorldTransform } from '@/shared/spatial'
import { isFiniteNumber } from '@/shared/validation'
import type { ReadonlyFleetRuntime } from '../model/createFleetRuntime'
import { computeVehicleWorldPose } from './createVehicleGeometry'

/** 跟随目标的世界平面坐标（y 恒为地面 0，由相机侧决定高度） */
export interface FollowTargetPosition {
  readonly x: number
  readonly z: number
}

/** 只读跟随目标读取器：未知键/无效目标返回 null，绝不抛出 */
export type FollowTargetReader = (
  entityKey: string,
) => FollowTargetPosition | null

export interface CreateFollowTargetReaderOptions {
  /** 高频运行时的只读查询视图 */
  runtime: ReadonlyFleetRuntime
  /** 地图世界变换（与渲染车辆使用的实例同源，由 app 注入） */
  worldTransform: WorldTransform
}

/** 创建跟随目标读取器；坐标口径与车体渲染严格一致（不变量 1） */
export function createFollowTargetReader(
  options: CreateFollowTargetReaderOptions,
): FollowTargetReader {
  const { runtime, worldTransform } = options
  return (entityKey: string): FollowTargetPosition | null => {
    const entity = runtime.get(entityKey)
    if (entity === undefined || !entity.snapshot.positionValid) {
      return null
    }
    const pose = computeVehicleWorldPose(entity.snapshot, worldTransform)
    if (!isFiniteNumber(pose.cx) || !isFiniteNumber(pose.cz)) {
      return null
    }
    return { x: pose.cx, z: pose.cz }
  }
}
