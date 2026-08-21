import { Canvas } from '@react-three/fiber'

import { MAX_DEVICE_PIXEL_RATIO } from './config/constants'
import { sceneColors } from './config/theme'
import { PlaceholderScene } from './scene/PlaceholderScene'

/**
 * 应用组装（SPEC §3）：App.tsx 为 DOM UI 壳 → <Canvas> → 场景组件树。
 * 当前为脚手架占位场景；UI 面板（Canvas 外，经 zustand 通信）由后续任务挂载。
 */
export default function App() {
  return (
    <div className="app-root">
      <Canvas
        dpr={[1, MAX_DEVICE_PIXEL_RATIO]}
        camera={{ position: [80, 60, 80], fov: 50, near: 0.1, far: 2000 }}
      >
        <color attach="background" args={[sceneColors.background]} />
        <PlaceholderScene />
      </Canvas>
    </div>
  )
}
