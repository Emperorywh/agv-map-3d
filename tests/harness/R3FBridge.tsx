/**
 * R3FBridge：验收桥在 R3F 树内的探针（SPEC §10.2/§15.2，测试专用）。
 *
 * 经 FactoryScene 的验收组合缝（children）挂入 Canvas 子树：
 * - 以 useThree 发布渲染器/相机/OrbitControls/invalidate 句柄到测试桥
 *   （卸载时保留被卸载渲染器引用，供 §10.3 卸载后基线读取）；
 * - 以 useFrame(priority=2) 在每帧 WebGL（priority=1 的 LabelLayer 先执行
 *   gl.render）与 CSS2D 渲染完成之后回调测试桥帧驱动——采样点因此拿到
 *   当帧结算后的 renderer.info（three 在 render 起始 autoReset，计数含
 *   阴影 pass）。priority>0 的订阅者本就存在（LabelLayer priority=1 接管
 *   渲染），本探针不改变渲染所有权。
 *
 * 只读快照 + 相机驱动，不修改场景内容；仅存在于 tests/，不进入生产包。
 */

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { PerspectiveCamera } from 'three'

import { attachThreeHandles, detachThreeHandles, tickTestFrame } from './installTestBridge'

export function R3FBridge(): null {
  const gl = useThree((state) => state.gl)
  const camera = useThree((state) => state.camera)
  const controls = useThree((state) => state.controls)
  const invalidate = useThree((state) => state.invalidate)

  useEffect(() => {
    attachThreeHandles({
      gl,
      // Canvas camera prop 固定创建 PerspectiveCamera（同 CameraRig/LabelLayer 的断言）
      camera: camera as PerspectiveCamera,
      // makeDefault 的 OrbitControls（drei）；挂载早期可能为 null，变化时本效应重挂
      controls: controls as OrbitControls | null,
      invalidate,
    })
    return () => {
      detachThreeHandles(gl)
    }
  }, [gl, camera, controls, invalidate])

  // priority=2：晚于 LabelLayer（priority=1）的 WebGL/CSS2D 渲染；
  // demand 模式下仅随 invalidate 产生的实际渲染帧触发
  useFrame(() => {
    tickTestFrame(performance.now())
  }, 2)

  return null
}
