import { useEffect, useState } from 'react'
import { OrbitControls } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'

import {
  BEZIER_TOLERANCE,
  CAMERA_DISTANCE_MAX,
  CAMERA_DISTANCE_MIN,
  CAMERA_POLAR_MAX_RAD,
  CAMERA_POLAR_MIN_RAD,
  CORRIDOR_GEOMETRY_TOLERANCE,
  MAX_DEVICE_PIXEL_RATIO,
} from './config/constants'
import { sceneColors } from './config/theme'
import { loadMap } from './infrastructure/mapLoader'
import { isWebGLSupported } from './infrastructure/webglSupport'
import { FactoryBuilding } from './scene/FactoryBuilding'
import { FactoryInterior } from './scene/FactoryInterior'
import { MapLayer } from './scene/MapLayer'
import { SceneLighting } from './scene/SceneLighting'
import { useAppStore } from './state/appStore'
import { ErrorScreen } from './ui/ErrorScreen'
import { LoadingOverlay } from './ui/LoadingOverlay'
import { WebGLUnsupportedScreen } from './ui/WebGLUnsupportedScreen'

/**
 * 应用组装（SPEC §3 / §4.4 / §10）：App.tsx 为 DOM UI 壳 → <Canvas> → 场景组件树。
 *
 * 加载状态流：WebGL 探测（不可用 → 提示页）→ idle 发起加载（进度条）
 * → ready 进入场景；失败（请求失败 / JSON 损坏 / 顶层结构缺失且主线程回退也失败）
 * → 全屏错误页（原因 + 重试），不进入场景。
 * 场景内容：FactoryBuilding 建筑外壳（TASK-006）+ FactoryInterior 内部元素 / 地面标线 /
 * glTF 点缀（TASK-007）+ MapLayer 走廊网络 / 节点实例层 / 标签层（TASK-003 / TASK-004 / TASK-005）。
 */
export default function App() {
  const [webglSupported] = useState(isWebGLSupported)
  const mapLoadPhase = useAppStore((state) => state.mapLoadPhase)
  const mapLoadProgress = useAppStore((state) => state.mapLoadProgress)
  const mapLoadError = useAppStore((state) => state.mapLoadError)

  useEffect(() => {
    if (!webglSupported) {
      return
    }
    // 仅 idle 发起加载；StrictMode 双调用 / 阶段推进导致的重放由该守卫与
    // store 内 beginMapLoad / completeMapLoad / failMapLoad 的阶段守卫共同兜底
    if (useAppStore.getState().mapLoadPhase !== 'idle') {
      return
    }
    useAppStore.getState().beginMapLoad()
    loadMap({
      bezierTolerance: BEZIER_TOLERANCE,
      corridorGeometryTolerance: CORRIDOR_GEOMETRY_TOLERANCE,
      onProgress: (progress) => useAppStore.getState().setMapLoadProgress(progress),
    })
      .then((result) => useAppStore.getState().completeMapLoad(result))
      .catch((error: unknown) =>
        useAppStore
          .getState()
          .failMapLoad(error instanceof Error ? error.message : String(error)),
      )
  }, [webglSupported, mapLoadPhase])

  if (!webglSupported) {
    return <WebGLUnsupportedScreen />
  }
  if (mapLoadPhase === 'error') {
    return (
      <ErrorScreen
        reason={mapLoadError ?? '未知错误'}
        onRetry={() => useAppStore.getState().resetMapLoad()}
      />
    )
  }
  if (mapLoadPhase !== 'ready') {
    return <LoadingOverlay progress={mapLoadProgress} />
  }

  return (
    <div className="app-root">
      <Canvas
        shadows
        dpr={[1, MAX_DEVICE_PIXEL_RATIO]}
        camera={{ position: [80, 60, 80], fov: 50, near: 0.1, far: 2000 }}
      >
        <color attach="background" args={[sceneColors.background]} />
        {/* 光照：1 盏平行光（唯一投影光源，shadow map ≤1024）+ 半球光（SPEC §5.3 / §9） */}
        <SceneLighting />
        {/* 相机：Orbit 自由视角（SPEC §8.1 极角 / 距离约束），三模式切换由 TASK-012 接管 */}
        <OrbitControls
          makeDefault
          enableDamping
          minPolarAngle={CAMERA_POLAR_MIN_RAD}
          maxPolarAngle={CAMERA_POLAR_MAX_RAD}
          minDistance={CAMERA_DISTANCE_MIN}
          maxDistance={CAMERA_DISTANCE_MAX}
        />
        <FactoryBuilding />
        <FactoryInterior />
        <MapLayer />
      </Canvas>
    </div>
  )
}
