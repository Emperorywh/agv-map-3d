import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'

import { SIM_SNAPSHOT_INTERVAL } from '../config/constants'
import { useAppStore } from '../state/appStore'

/**
 * 渲染性能采样（SPEC §8.3 统计信息 FPS / §9 draw call 预算 < 200）。
 *
 * useFrame 内用 ref 累积帧数与耗时（不进 React 渲染路径，SPEC §3 / §9），
 * 每 SIM_SNAPSHOT_INTERVAL（0.5s，与 AGV 低频快照同节拍，≤2Hz）把窗口均值
 * 取整写入 store，统计面板低频订阅读取；后台标签页 rAF 暂停期间不产生样本，
 * 恢复后自下一窗口重新计数。
 *
 * 同一窗口节拍顺带采样 draw call：useFrame 执行于本帧 render 之前，
 * renderer.info 持有的是上一完成帧的计数（three autoReset 在每帧 render 末尾清零），
 * 每个窗口取一次即代表稳态绘制调用数。
 */
export function FrameStats() {
  const windowRef = useRef({ elapsed: 0, frames: 0 })

  useFrame(({ gl }, delta) => {
    const acc = windowRef.current
    acc.elapsed += delta
    acc.frames += 1
    if (acc.elapsed >= SIM_SNAPSHOT_INTERVAL) {
      const store = useAppStore.getState()
      store.setFps(Math.round(acc.frames / acc.elapsed))
      store.setDrawCalls(gl.info.render.calls)
      acc.elapsed = 0
      acc.frames = 0
    }
  })

  return null
}
