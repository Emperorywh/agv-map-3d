/**
 * 交通锁图层（SPEC §5.1、§5.3、§7.2、§12.5；TASK-012）。
 *
 * 职责：把交通锁聚合资源（createTrafficLocksResources）挂载到场景，并在
 *       useFrame 中以单调时钟驱动 sync——归一化、100ms 合并窗口与「规范化
 *       哈希变化才重建」的全部语义都封装在资源对象内，本组件只负责挂载
 *       （面板/描边/文字三网格，P1-8）、驱动与脉冲 uniforms 写入（TASK-014
 *       接入 pulseEnabled 能力开关：SPEC §6.5 行动 3 关闭交通锁脉冲），不
 *       触碰任何 React 状态（几何重建发生在资源对象内部，对 React 不可见也
 *       无需可见）。
 * 边界：本组件拥有聚合资源（网格、材质、当前几何）并在卸载时幂等释放；
 *       不做矩形校验裁决（模型层职责）、不做坐标换算（资源对象按注入的
 *       WorldTransform 完成）。世界变换引用变化（地图恢复换代）由 sync 内部
 *       检测并强制重建。
 * 关键不变量：
 * 1. 网格常驻、几何换代：mesh 对象身份恒定（primitive 只挂载一次），重建
 *    只更换 geometry——规避 R3F 对已挂载 primitive 换 object 的重建丢弃
 *    问题，也不产生任何 React 渲染；
 * 2. 高频事件零 React 参与：sync 每帧调用但内部按 100ms 窗口节流，签名
 *    不变时零 GPU 上传（SPEC §5.3）；
 * 3. StrictMode 对称：useFrame 随组件生命周期建立/销毁，资源 dispose 幂等。
 */
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { DiagnosticsReporter } from '@/shared/diagnostics'
import type { WorldTransform } from '@/shared/spatial'
import type { FleetRuntime } from '../model/createFleetRuntime'
import {
  createTrafficLocksResources,
  type TrafficLocksResources,
} from '../scene/trafficGeometry'

export interface TrafficLocksLayerProps {
  /** 高频车队运行时（只读扫描交通资源） */
  runtime: FleetRuntime
  /** 地图世界变换；null 时本层不挂载（等待地图就绪） */
  worldTransform: WorldTransform | null
  /** 交通锁脉冲能力开关（SPEC §6.5 行动 3）；false 时恒定不透明度；默认 true */
  pulseEnabled?: boolean
  /** 结构化诊断通道（当前无告警路径，保留与兄弟图层一致的注入口径） */
  diagnostics?: DiagnosticsReporter
}

export function TrafficLocksLayer({
  runtime,
  worldTransform,
  pulseEnabled = true,
}: TrafficLocksLayerProps) {
  // 聚合资源单一所有者：组件生命周期内只创建一次，卸载幂等释放
  const resources = useMemo<TrafficLocksResources>(
    () => createTrafficLocksResources(),
    [],
  )
  useEffect(() => () => resources.dispose(), [resources])

  // 单调时钟与能力开关经 ref 透传：测试渲染器与真实循环共用同一 sync 语义
  const optionsRef = useRef({ runtime, worldTransform, pulseEnabled })
  optionsRef.current = { runtime, worldTransform, pulseEnabled }

  useFrame(({ clock }) => {
    const { runtime: rt, worldTransform: wt, pulseEnabled: pulse } = optionsRef.current
    if (wt === null) {
      return
    }
    // 脉冲 uniforms：时间推进相位，开关即时生效（不触碰几何与 React state）
    resources.pulseUniforms.uTime.value = clock.elapsedTime
    resources.pulseUniforms.uLockPulseEnabled.value = pulse ? 1 : 0
    resources.sync(rt.entities(), wt, performance.now())
  })

  if (worldTransform === null) {
    return null
  }
  // dispose={null}：全部资源由本组件 effect 显式释放，禁止 R3F 二次释放
  return (
    <>
      <primitive object={resources.mesh} dispose={null} />
      {/* P1-8 表达增强：边缘亮色描边（共享面板材质）与「已锁定/申请中」文字
          贴花（Canvas 不可用时网格恒不可见），几何均由 sync 同签同换 */}
      <primitive object={resources.borderMesh} dispose={null} />
      <primitive object={resources.textMesh} dispose={null} />
    </>
  )
}
