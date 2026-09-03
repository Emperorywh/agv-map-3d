/**
 * 连通分量包围盒与默认聚焦选择（视觉对齐改造 P0-5.2）。
 *
 * 职责：为「启动后默认聚焦活跃车辆最多的连通区域」提供纯数据支撑——
 *       computeComponentBounds 按弱连通分量聚合节点世界坐标包围盒；
 *       pickFocusBounds 统计落入各分量包围盒的车辆位置数，返回车辆最多
 *       分量的包围盒（无车辆落入任何分量时返回 null，调用方保持全厂总览）。
 * 边界：纯函数，无 React、无 Three 对象；车辆位置由调用方（app 组合层）
 *       从车队运行时取数后传入——本模块不感知车队运行时（SPEC §12.4）。
 * 关键不变量：
 * 1. 分量包围盒由分量成员节点世界坐标 AABB 派生，与世界变换同源；空分量
 *    不产生包围盒（纵深防御）；
 * 2. 位置归属按扩展边距（margin）判定：贴边车辆仍计入所属区域；并列时取
 *    节点数更多的分量（components 已按节点数降序，先到者胜）。
 */
import type { MapModel, SceneBounds } from './types'
import type { WorldTransform } from '@/shared/spatial'

/** 与 SceneBounds 同形的包围盒（分量聚焦取景直接复用俯瞰取景数学） */
export type FocusBounds = SceneBounds

/** 计算每个弱连通分量的世界坐标包围盒（分量 index → 包围盒） */
export function computeComponentBounds(
  mapModel: MapModel,
  worldTransform: WorldTransform,
): ReadonlyMap<number, FocusBounds> {
  const acc = new Map<number, {
    minX: number
    maxX: number
    minZ: number
    maxZ: number
  }>()
  for (const node of mapModel.nodeList) {
    const component = mapModel.componentIndexOfNode.get(node.id)
    if (component === undefined) {
      continue
    }
    const world = worldTransform.toWorldXZ(node.x, node.y)
    let box = acc.get(component)
    if (box === undefined) {
      box = { minX: world.x, maxX: world.x, minZ: world.z, maxZ: world.z }
      acc.set(component, box)
    } else {
      if (world.x < box.minX) box.minX = world.x
      if (world.x > box.maxX) box.maxX = world.x
      if (world.z < box.minZ) box.minZ = world.z
      if (world.z > box.maxZ) box.maxZ = world.z
    }
  }

  const bounds = new Map<number, FocusBounds>()
  for (const [component, box] of acc) {
    bounds.set(
      component,
      Object.freeze({
        minWorldX: box.minX,
        maxWorldX: box.maxX,
        minWorldZ: box.minZ,
        maxWorldZ: box.maxZ,
        centerWorldX: (box.minX + box.maxX) / 2,
        centerWorldZ: (box.minZ + box.maxZ) / 2,
        diagonal: Math.hypot(box.maxX - box.minX, box.maxZ - box.minZ),
      }),
    )
  }
  return bounds
}

/**
 * 选取默认聚焦区域：统计落入各分量包围盒（含 margin 边距）的世界坐标点数，
 * 返回点数最多的分量包围盒；没有任何点落入任何分量时返回 null（调用方保
 * 持完整全厂总览，不抢镜头）。
 */
export function pickFocusBounds(
  mapModel: MapModel,
  worldTransform: WorldTransform,
  worldPositions: readonly { readonly x: number; readonly z: number }[],
  marginM = 0,
): FocusBounds | null {
  if (worldPositions.length === 0) {
    return null
  }
  const componentBounds = computeComponentBounds(mapModel, worldTransform)
  if (componentBounds.size === 0) {
    return null
  }

  const counts = new Map<number, number>()
  for (const p of worldPositions) {
    for (const [component, box] of componentBounds) {
      if (
        p.x >= box.minWorldX - marginM &&
        p.x <= box.maxWorldX + marginM &&
        p.z >= box.minWorldZ - marginM &&
        p.z <= box.maxWorldZ + marginM
      ) {
        counts.set(component, (counts.get(component) ?? 0) + 1)
        break
      }
    }
  }

  let bestComponent = -1
  let bestCount = 0
  // components 按节点数降序：并列时先遍历到（更大）的分量胜出
  for (const component of mapModel.components) {
    const count = counts.get(component.index) ?? 0
    if (count > bestCount) {
      bestCount = count
      bestComponent = component.index
    }
  }
  if (bestComponent < 0) {
    return null
  }
  return componentBounds.get(bestComponent) ?? null
}
