import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'

import { SIM_SNAPSHOT_INTERVAL } from '../config/constants'
import { useAppStore } from '../state/appStore'

/**
 * 渲染帧率采样（SPEC §8.3 统计信息 FPS）。
 *
 * useFrame 内用 ref 累积帧数与耗时（不进 React 渲染路径，SPEC §3 / §9），
 * 每 SIM_SNAPSHOT_INTERVAL（0.5s，与 AGV 低频快照同节拍，≤2Hz）把窗口均值
 * 取整写入 store，统计面板低频订阅读取；后台标签页 rAF 暂停期间不产生样本，
 * 恢复后自下一窗口重新计数。
 */
export function FrameStats() {
  const windowRef = useRef({ elapsed: 0, frames: 0 })

  useFrame((_, delta) => {
    const acc = windowRef.current
    acc.elapsed += delta
    acc.frames += 1
    if (acc.elapsed >= SIM_SNAPSHOT_INTERVAL) {
      useAppStore.getState().setFps(Math.round(acc.frames / acc.elapsed))
      acc.elapsed = 0
      acc.frames = 0
    }
  })

  return null
}
