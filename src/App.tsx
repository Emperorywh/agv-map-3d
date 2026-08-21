import { useEffect, useState } from 'react'
import { Canvas } from '@react-three/fiber'

import {
  BEZIER_TOLERANCE,
  CORRIDOR_GEOMETRY_TOLERANCE,
  MAX_DEVICE_PIXEL_RATIO,
} from './config/constants'
import { sceneColors } from './config/theme'
import { loadMap } from './infrastructure/mapLoader'
import { isWebGLSupported } from './infrastructure/webglSupport'
import { AgvLayer } from './scene/AgvLayer'
import { CameraRig } from './scene/CameraRig'
import { FactoryBuilding } from './scene/FactoryBuilding'
import { FactoryInterior } from './scene/FactoryInterior'
import { MapLayer } from './scene/MapLayer'
import { SceneLighting } from './scene/SceneLighting'
import { SelectionHighlight } from './scene/SelectionHighlight'
import { useAppStore } from './state/appStore'
import { DetailPanel } from './ui/DetailPanel'
import { ErrorScreen } from './ui/ErrorScreen'
import { LoadingOverlay } from './ui/LoadingOverlay'
import { WebGLUnsupportedScreen } from './ui/WebGLUnsupportedScreen'

/**
 * 应用组装（SPEC §3 / §4.4 / §10）：App.tsx 为 DOM UI 壳 → <Canvas> → 场景组件树。
 *
 * 加载状态流：WebGL 探测（不可用 → 提示页）→ idle 发起加载（进度条）
 * → ready 进入场景；失败（请求失败 / JSON 损坏 / 顶层结构缺失且主线程回退也失败）
 * → 全屏错误页（原因 + 重试），不进入场景。
 * 场景内容：FactoryBuilding 建筑外壳与遮挡淡出（TASK-006 / TASK-012）+ FactoryInterior
 * 内部元素 / 地面标线 / glTF 点缀（TASK-007）+ MapLayer 走廊网络 / 节点实例层 / 标签层
 * （TASK-003 / TASK-004 / TASK-005）+ AgvLayer 模拟巡航 AGV（TASK-010）
 * + CameraRig 相机三模式与平滑切换（TASK-011）+ SelectionHighlight 拾取高亮（TASK-013）。
 * 拾取（SPEC §8.2）：地图三类对象（节点 / 走廊 / AGV）在各自图层挂 raycast 事件；
 * 点击未命中任何可拾取对象时 onPointerMissed 取消选中（R3F 自带拖拽守卫：
 * pointerdown→click 位移 > 2px 的相机拖拽不触发）。
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
        onPointerMissed={() => useAppStore.getState().setSelection(null)}
      >
        <color attach="background" args={[sceneColors.background]} />
        {/* 光照：1 盏平行光（唯一投影光源，shadow map ≤1024）+ 半球光（SPEC §5.3 / §9） */}
        <SceneLighting />
        <FactoryInterior />
        <MapLayer />
        <AgvLayer />
        {/* 选中 / 悬停高亮层（SPEC §8.2）：描边色环 + 走廊覆盖，自身不可拾取 */}
        <SelectionHighlight />
        {/* 相机三模式（自由 Orbit / 正交俯视 / AGV 跟随）与 0.5s 平滑切换（SPEC §8.1）；
            置于 AgvLayer 之后挂载，同优先级 useFrame 内跟随读取的是当帧 AGV 位姿 */}
        <CameraRig />
        {/* 遮挡淡出（SPEC §5.5）置于 CameraRig 之后挂载：同优先级 useFrame 后执行，
            读取的是当帧跟随步进后的相机位姿与 controls.target（关注点） */}
        <FactoryBuilding />
      </Canvas>
      {/* 右侧详情面板（SPEC §8.2，DOM、Canvas 外）：消费 store 的 selection / mapData /
          agvSnapshot 低频快照 */}
      <DetailPanel />
    </div>
  )
}
