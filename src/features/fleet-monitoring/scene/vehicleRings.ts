/**
 * 选中/L1/L2 分层光环资源与判定（SPEC §5.1、§5.3、§7.3；TASK-012）。
 *
 * 职责：两件事——
 * 1. ringLayersOf 纯判定：从投影主状态与静态告警列表推导「该车辆当前应显示
 *    哪些光环层」（L1 黄、L2 红允许可同时存在，选中层由帧同步按选中键单独
 *    判定），语义与 labelLod.labelAlertLevel 同表但 不互斥坍缩——标签边框只
 *    取最高一级，光环则每层独立存在（SPEC §7.3）；
 * 2. 资源工厂：构建全部批次共享的单位环几何与单一透明材质（Feature 根组件
 *    单一所有者，dispose 幂等），批次组件按批次数克隆 InstancedMesh。
 * 边界：不创建 InstancedMesh、不写实例缓冲（帧同步层职责）；不感知选中键、
 *       运行时与 React；配色复用 fleetAppearance 的标签边框常量，保证同一
 *       告警语义在全场景只有一种颜色。
 * 关键不变量：
 * 1. 层序固定：层序号 0/1/2 依次为选中（白）、L1（黄）、L2（红），半径单调
 *    递增（RING_LAYER_RADII_M），「从内到外」由半径表达；
 * 2. L1/L2 判定与 SPEC §7.3 告警表同口径：L1 = LOW_BATTERY 或
 *    LOW_LOCALIZATION；L2 = FAULT/STALE/断连主状态、CRITICAL_BATTERY 或
 *    INVALID_DATA；两层可同时为真；
 * 3. 单位环几何位于 XZ 水平面（内环比 RING_INNER_RATIO），世界尺寸完全由
 *    实例矩阵的 x/z 缩放表达，每车缩放系数 = max(长,宽)/RING_SIZE_REFERENCE_M。
 */
import * as THREE from 'three'
import type {
  VehicleAlert,
  VehiclePrimaryDisplayState,
} from '../model/types'
import {
  LABEL_BORDER_L1_COLOR,
  LABEL_BORDER_L2_COLOR,
  LABEL_BORDER_SELECTED_COLOR,
  RING_INNER_RATIO,
  RING_OPACITY,
  RING_SEGMENTS,
} from './fleetAppearance'

/** 光环层数与层序：0 选中、1 L1、2 L2（从内到外，SPEC §7.3） */
export const RING_LAYER_COUNT = 3

/** 每层实例颜色（与标签边框配色同源，线性空间经 THREE.Color 转换） */
export const RING_LAYER_COLORS: readonly string[] = [
  LABEL_BORDER_SELECTED_COLOR,
  LABEL_BORDER_L1_COLOR,
  LABEL_BORDER_L2_COLOR,
]

/** 一次光环判定结果：L1/L2 相互独立，可同时为 true */
export interface RingLayers {
  readonly l1: boolean
  readonly l2: boolean
}

/**
 * 光环层判定（SPEC §7.3 告警表）：标签边框取最高级（labelAlertLevel），
 * 光环每层独立——低电量 + 故障的车同时显示黄环与红环。
 */
export function ringLayersOf(
  primary: VehiclePrimaryDisplayState,
  alerts: readonly VehicleAlert[],
): RingLayers {
  let l1 = false
  let l2 =
    primary === 'FAULT' || primary === 'STALE' || primary === 'DISCONNECTED'
  for (const alert of alerts) {
    if (alert.type === 'LOW_BATTERY' || alert.type === 'LOW_LOCALIZATION') {
      l1 = true
    } else if (alert.type === 'CRITICAL_BATTERY' || alert.type === 'INVALID_DATA') {
      l2 = true
    }
  }
  return { l1, l2 }
}

/** 光环共享资源：单位环几何 + 单一透明材质；由 Feature 根组件单一持有 */
export interface RingResources {
  /** 单位环几何：XZ 水平面，外半径 1，内半径 RING_INNER_RATIO */
  readonly ring: THREE.BufferGeometry
  /** 共享材质：白色基色 + 实例颜色着色，透明不写深度 */
  readonly material: THREE.MeshBasicMaterial
  /** 幂等释放全部几何与材质 */
  dispose(): void
}

/** 构建光环共享资源（一次调用对应一个所有者；dispose 幂等） */
export function createRingResources(): RingResources {
  // RingGeometry 位于 XY 平面（z 轴法线），旋转 -90° 使其平铺在 XZ 水平面
  const ring = new THREE.RingGeometry(RING_INNER_RATIO, 1, RING_SEGMENTS)
  ring.rotateX(-Math.PI / 2)
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: RING_OPACITY,
    depthWrite: false,
    side: THREE.DoubleSide,
  })

  let disposed = false
  return {
    ring,
    material,
    dispose() {
      // 幂等：StrictMode 重复清理与重挂载路径都安全
      if (disposed) {
        return
      }
      disposed = true
      ring.dispose()
      material.dispose()
    },
  }
}
