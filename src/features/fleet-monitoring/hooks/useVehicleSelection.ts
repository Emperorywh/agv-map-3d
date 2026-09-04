/**
 * 车辆选择交互（SPEC §7.3、§8、§11.6、§12.5；TASK-012）。
 *
 * 职责：把「单击车辆外壳选中、Esc 或点击场景空白取消、双击上抛跟随请求、
 *       车辆删除立即清理选中」翻译为低频 store 命令——返回一组可展开在
 *       Feature 根组件包裹 group 上的 R3F 指针事件处理器（事件沿场景图冒泡，
 *       只有外壳 InstancedMesh 开启 raycast，因此命中必然是外壳）与 Esc 键
 *       监听。选中值落在 fleetMonitoringStore（低频），渲染层经 getState
 *       消费，高频事件流不经过本 Hook。
 * 边界：只处理选择语义——不移动相机（单击不自动取景）、不实现跟随（双击仅
 *       调用 onFollowRequest 上抛，跟随语义属 TASK-013 相机 Feature）、不
 *       渲染任何 DOM；拾取映射经槽位表 resolve((batchId, instanceId)) 完成，
 *       本 Hook 不持有车辆数据。
 * 关键不变量：
 * 1. 只接受主鼠标指针：pointerType 非 mouse 或 isPrimary=false 的事件一律
 *    忽略（SPEC §8「车辆拾取只接受主鼠标指针」，本期无触屏）；
 * 2. 拖拽抑制：pointerdown 与 click/双击/missed 之间的位移超过阈值视为
 *    轨道拖拽，不产生任何选择语义变化（相机拖拽不应误选/误取消）；
 * 3. 删除立即清理：数据源 remove/snapshot diff 产生的删除差异由
 *    FleetRuntimeProvider 转发为 store.notifyEntitiesRemoved——被选中的
 *    车辆被删除时选中键同帧清空（SPEC §11.6）；
 * 4. 监听器对称清理：Esc 键监听在 effect 清理函数中移除，StrictMode 的
 *    setup→cleanup→setup 不产生重复监听。
 */
import { useEffect, useRef } from 'react'
import type { ThreeEvent } from '@react-three/fiber'
import type { InstanceSlotTable } from '../model/instanceSlots'
import { useFleetMonitoringStore } from '../model/fleetMonitoringStore'

/** 拖拽判定默认阈值（像素）：位移超过该值视为轨道拖拽而非单击 */
const DEFAULT_DRAG_THRESHOLD_PX = 6

export interface VehicleSelectionOptions {
  /** 实例槽位表：(batchId, instanceId) → 实体键 的唯一映射来源 */
  table: InstanceSlotTable
  /** 双击跟随请求上抛（TASK-013 相机 Feature 接入；缺省时双击为 no-op） */
  onFollowRequest?: (entityKey: string) => void
  /** 拖拽判定阈值（像素）；默认 6 */
  dragThresholdPx?: number
}

export interface VehicleSelectionHandlers {
  /**
   * 悬停不阻止事件传播，地图轨道控制仍接收拖拽和滚轮。
   * 移动时检查按键状态，只在未拖拽时显示简要标签。
   */
  onPointerMove(event: ThreeEvent<PointerEvent>): void
  onPointerOut(event: ThreeEvent<PointerEvent>): void
  /** 记录按下位置（拖拽判定基准），展开在包裹 group 上 */
  onPointerDown(event: ThreeEvent<PointerEvent>): void
  /** 命中外壳 → 选中；命中部件非外壳时 R3F 不会触发（raycast 已关闭） */
  onClick(event: ThreeEvent<MouseEvent>): void
  /** 命中外壳 → 仅上抛跟随请求，不改变选中（SPEC §8） */
  onDoubleClick(event: ThreeEvent<MouseEvent>): void
  /** 点击未命中本 Feature 任何对象（空白、地图、其他图层）→ 取消选中 */
  onPointerMissed(event: MouseEvent): void
}

/** pointerdown 落点记录（拖拽判定基准；null 表示本指针会话无按下记录） */
interface DownSample {
  x: number
  y: number
}

export function useVehicleSelection(
  options: VehicleSelectionOptions,
): VehicleSelectionHandlers {
  // options 经 ref 透传：内联回调变化不重建事件处理器
  const optionsRef = useRef(options)
  optionsRef.current = options

  const downRef = useRef<DownSample | null>(null)

  // Esc 取消选中：window 级监听，effect 对称清理（不变量 4）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        useFleetMonitoringStore.getState().select(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    /**
     * 全局按下记录覆盖从空白开始的拖拽，避免释放在车辆上被误判为点击。
     * 按下和窗口失焦均清空悬停，监听器随组件生命周期对称移除。
     */
    const onDown = (event: PointerEvent) => {
      downRef.current = { x: event.clientX, y: event.clientY }
      useFleetMonitoringStore.getState().hover(null)
    }
    const clearHover = () => useFleetMonitoringStore.getState().hover(null)
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('blur', clearHover)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('blur', clearHover)
      clearHover()
    }
  }, [])

  const readDownSample = (native: { clientX?: number; clientY?: number }): DownSample | null => {
    if (typeof native.clientX !== 'number' || typeof native.clientY !== 'number') {
      return null
    }
    return { x: native.clientX, y: native.clientY }
  }

  /** 拖拽门卫：按下记录存在且位移超阈值时忽略该事件（轨道拖拽） */
  const isDrag = (native: { clientX?: number; clientY?: number }): boolean => {
    const down = downRef.current
    if (down === null) {
      return false
    }
    const current = readDownSample(native)
    if (current === null) {
      return false
    }
    return (
      Math.hypot(current.x - down.x, current.y - down.y) >
      (optionsRef.current.dragThresholdPx ?? DEFAULT_DRAG_THRESHOLD_PX)
    )
  }

  /** (batchId, instanceId) → 实体键；形态不符或槽位已复用返回 null */
  const resolveEntityKey = (event: {
    instanceId?: number
    object?: { userData?: { batchId?: unknown } }
  }): string | null => {
    const batchId = event.object?.userData?.batchId
    const instanceId = event.instanceId
    if (typeof batchId !== 'number' || typeof instanceId !== 'number') {
      return null
    }
    return optionsRef.current.table.resolve(batchId, instanceId) ?? null
  }

  return {
    onPointerMove(event) {
      if (!isMainMousePointer(event.nativeEvent) || event.nativeEvent.buttons !== 0) {
        useFleetMonitoringStore.getState().hover(null)
        return
      }
      const nearest = event.intersections.find((hit) => typeof hit.object.userData.batchId === 'number')
      useFleetMonitoringStore.getState().hover(resolveEntityKey(nearest ?? event))
    },
    onPointerOut(event) {
      if (useFleetMonitoringStore.getState().hoveredKey === resolveEntityKey(event)) {
        useFleetMonitoringStore.getState().hover(null)
      }
    },
    onPointerDown(event) {
      if (!isMainMousePointer(event.nativeEvent)) {
        return
      }
      downRef.current = readDownSample(event.nativeEvent)
    },
    onClick(event) {
      if (!isMainMousePointer(event.nativeEvent) || isDrag(event.nativeEvent)) {
        return
      }
      /**
       * 多部件或多车投影重叠时始终选择最近命中，避免后方车辆覆盖前方选择。
       * 只在确定点击时终止拾取传播，指针移动和地图拖拽保持原样。
       */
      const key = resolveEntityKey(event.intersections.find((hit) => typeof hit.object.userData.batchId === 'number') ?? event)
      if (key !== null) {
        event.stopPropagation()
        useFleetMonitoringStore.getState().select(key)
      }
    },
    onDoubleClick(event) {
      if (!isMainMousePointer(event.nativeEvent) || isDrag(event.nativeEvent)) {
        return
      }
      const key = resolveEntityKey(event.intersections.find((hit) => typeof hit.object.userData.batchId === 'number') ?? event)
      if (key !== null) {
        event.stopPropagation()
        // 只上抛跟随请求：相机行为归 TASK-013，本 Hook 不移动相机
        optionsRef.current.onFollowRequest?.(key)
      }
    },
    onPointerMissed(event) {
      if (!isMainMousePointer(event) || isDrag(event)) {
        return
      }
      useFleetMonitoringStore.getState().select(null)
    },
  }
}

/** 主鼠标指针判定：pointerType 可判定时必须为 mouse，isPrimary 不得为 false。
 *  入参为结构化宽松形态：浏览器 MouseEvent（onPointerMissed）没有这两个
 *  字段，视为「未声明」而放行；真实 PointerEvent 才携带可判定值。 */
function isMainMousePointer(native: object): boolean {
  const pointerType = (native as { pointerType?: unknown }).pointerType
  if (typeof pointerType === 'string' && pointerType !== 'mouse') {
    return false
  }
  /**
   * 浏览器的点击事件也可能是指针对象，但其主指针字段可以为假。
   * 主指针限制只适用于指针会话事件，普通左键点击与双击按按钮判断。
   */
  const type = (native as { type?: string }).type ?? ''
  if (type.startsWith('pointer') && (native as { isPrimary?: unknown }).isPrimary === false) {
    return false
  }
  if ((type === 'click' || type === 'dblclick') && (native as { button?: number }).button !== 0) return false
  return true
}
