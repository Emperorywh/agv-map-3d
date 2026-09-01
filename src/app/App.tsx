import { Canvas } from '@react-three/fiber'
import { AgvMonitorScene } from './scene/AgvMonitorScene'

// 应用组合根。
// 职责：装配唯一的全屏 WebGL Canvas，并在场景内组合各 Feature 根组件。
// 关键不变量（SPEC §7.1 / D2）：
// 1. 整个应用自始至终只挂载一个 Canvas，尺寸为 100vw × 100dvh；
// 2. Canvas 之外不得出现任何 DOM 覆盖层（标题、按钮、面板、加载/错误 UI 等）；
// 3. App 只做组合，不承载地图、车辆、协议等业务实现。
export function App() {
  return (
    <Canvas style={{ width: '100vw', height: '100dvh' }}>
      <AgvMonitorScene />
    </Canvas>
  )
}

export default App
