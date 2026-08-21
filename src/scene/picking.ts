import type { Object3D } from 'three'
import type { ThreeEvent } from '@react-three/fiber'

import { PICK_CLICK_MAX_DRAG_PX } from '../config/constants'

/**
 * 拾取事件共享判定（SPEC §8.2）。
 *
 * R3F 事件顺序保证（v9 events 源码）：pointermove 先对失焦对象派发 pointerout
 * （cancelPointer 先于新命中派发），因此各 mesh 的 onPointerOut 直接清除悬停即可；
 * 事件处理器内须**先 stopPropagation 再写 store**——stopPropagation 会同步冲刷
 * 被遮挡对象的 pointerout，先写后停会被迟到的 out 覆盖。
 *
 * 建筑元素不可拾取由建筑侧 raycast 置空保证（FactoryBuilding / FactoryInterior），
 * 且 R3F 只对注册了事件处理器的对象做 raycast——拾取目标天然只有地图三类对象。
 */

/** 点击选中判定：pointerdown→click 位移超阈值视为相机拖拽，不触发选中 */
export function isSelectionClick(event: ThreeEvent<MouseEvent>): boolean {
  return event.delta <= PICK_CLICK_MAX_DRAG_PX
}

/**
 * 命中对象的实效可见性（沿父链检查 visible）：
 * R3F raycast 不检查 visible——图层开关关闭的组、相机拉远整类隐藏的 node 组
 * 仍会被 raycast 命中，拾取须显式守卫（隐藏对象不可拾取、不遮挡其后对象）。
 */
export function isEffectivelyVisible(object: Object3D): boolean {
  let current: Object3D | null = object
  while (current !== null) {
    if (!current.visible) {
      return false
    }
    current = current.parent
  }
  return true
}
