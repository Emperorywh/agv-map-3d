/**
 * 地图可视化 Feature 公开根组件（SPEC §5.1、§5.4、§12.3；TASK-004）。
 *
 * 职责：协调地图场景的全部静态表达——清屏底色、环境与灯光（方向光 +
 *       RoomEnvironment/PMREM + 静态阴影相机）、工业地坪、去重物理路径与
 *       节点实例层；地图生命周期由 useMapVisualization 驱动。
 * 边界：本组件是 Feature 的唯一公开根；不解析协议、不读运行时配置文件、
 *       不做几何去重等业务算法（在 scene/model 层）。仓库/充电/停车地标与
 *       独占区语义层属 TASK-005，车辆属 fleet-monitoring。
 * 关键不变量：
 * 1. 尚无有效视图（首次加载失败、重试中）时只渲染清屏底色与灯光，不出现
 *    任何地图对象或 DOM 兜底（SPEC §7.4）；
 * 2. 视图原子替换时所有图层以同一 view 对象为源，同一渲染提交内完成整体
 *    换新，不出现新旧混排；
 * 3. 灯光阴影相机按当前地图包围盒静态配置（SPEC §5.4），不逐帧更新；
 * 4. 初始取景为最小可见性接线（45° 俯视取景数学），交互相机与跟随由
 *    camera-navigation Feature（TASK-013）接管后移除。
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import type { DiagnosticsReporter } from '@/shared/diagnostics'
import type { SceneBounds } from '../model/types'
import {
  useMapVisualization,
  type MapViewDescriptor,
} from '../hooks/useMapVisualization'
import {
  createRoomEnvironment,
  type SceneEnvironmentFactory,
} from '../scene/createSceneEnvironment'
import {
  DEFAULT_SHADOW_MAP_SIZE,
  DIRECTIONAL_LIGHT_INTENSITY,
  LIGHT_SHADOW_MARGIN_M,
  MAP_CLEAR_COLOR,
} from '../scene/mapAppearance'
import { GroundLayer } from './GroundLayer'
import { PhysicalPathsLayer } from './PhysicalPathsLayer'
import { NodesLayer } from './NodesLayer'

export interface MapVisualizationFeatureProps {
  /** 地图视图描述符；null 表示尚无可加载的地图（保持清屏色） */
  map: MapViewDescriptor | null
  /** 结构化诊断通道（加载失败/恢复/环境降级）；默认内置通道 */
  diagnostics?: DiagnosticsReporter
  /** 方向光阴影贴图分辨率；来自 config.renderer.shadowMapSize，默认 2048 */
  shadowMapSize?: number
  /** 环境工厂注入点；默认 RoomEnvironment+PMREM，测试注入替身 */
  environmentFactory?: SceneEnvironmentFactory
}

export function MapVisualizationFeature({
  map,
  diagnostics,
  shadowMapSize = DEFAULT_SHADOW_MAP_SIZE,
  environmentFactory = createRoomEnvironment,
}: MapVisualizationFeatureProps) {
  const { view } = useMapVisualization(map, { diagnostics })

  return (
    <>
      {/* 清屏底色始终存在：地图未就绪或失败重试期间页面保持该颜色 */}
      <color attach="background" args={[MAP_CLEAR_COLOR]} />
      <SceneLighting
        bounds={view?.mapModel.sceneBounds ?? null}
        shadowMapSize={shadowMapSize}
        environmentFactory={environmentFactory}
        diagnostics={diagnostics}
      />
      {view !== null ? (
        <>
          <GroundLayer bounds={view.mapModel.sceneBounds} />
          <PhysicalPathsLayer geometry={view.geometry} />
          <NodesLayer data={view.geometry.nodeInstances} />
          <InitialFraming bounds={view.mapModel.sceneBounds} />
        </>
      ) : null}
    </>
  )
}

interface SceneLightingProps {
  bounds: SceneBounds | null
  shadowMapSize: number
  environmentFactory: SceneEnvironmentFactory
  diagnostics?: DiagnosticsReporter
}

/** 灯光与环境：PMREM 环境贴图 + 按地图包围盒静态配置的方向光阴影 */
function SceneLighting({
  bounds,
  shadowMapSize,
  environmentFactory,
  diagnostics,
}: SceneLightingProps) {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)

  // 环境贴图生命周期：工厂创建、卸载释放；工厂失败记录诊断并降级为无 IBL
  useEffect(() => {
    let handle: ReturnType<SceneEnvironmentFactory> | null = null
    try {
      handle = environmentFactory(gl)
      scene.environment = handle.texture
    } catch (error) {
      diagnostics?.report('MAP_ENVIRONMENT_FAILED', 'warn', '环境贴图创建失败，已降级为无 IBL', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    return () => {
      scene.environment = null
      handle?.dispose()
    }
  }, [gl, scene, environmentFactory, diagnostics])

  // 方向光按包围盒静态构建：bounds 变化（地图替换）时整体重建并释放旧灯
  const lighting = useMemo(
    () => (bounds !== null ? createStaticDirectionalLight(bounds, shadowMapSize) : null),
    [bounds, shadowMapSize],
  )
  useEffect(() => () => lighting?.light.dispose(), [lighting])

  if (lighting === null) {
    return null
  }
  return (
    <>
      {/* dispose={null}：灯光对象由上方 effect 显式释放 */}
      <primitive object={lighting.light} dispose={null} />
      <primitive object={lighting.target} dispose={null} />
    </>
  )
}

interface StaticLighting {
  light: THREE.DirectionalLight
  target: THREE.Object3D
}

/** 按地图包围盒配置方向光：位置取对角线比例偏移，阴影正交相机静态覆盖全图 */
function createStaticDirectionalLight(bounds: SceneBounds, shadowMapSize: number): StaticLighting {
  const diagonal = Math.max(bounds.diagonal, 1)
  const light = new THREE.DirectionalLight(0xffffff, DIRECTIONAL_LIGHT_INTENSITY)
  light.name = 'map-directional-light'
  light.position.set(
    bounds.centerWorldX + diagonal * 0.4,
    diagonal * 0.9,
    bounds.centerWorldZ + diagonal * 0.25,
  )
  light.castShadow = true
  light.shadow.mapSize.set(shadowMapSize, shadowMapSize)
  const half = diagonal / 2 + LIGHT_SHADOW_MARGIN_M
  const camera = light.shadow.camera
  camera.left = -half
  camera.right = half
  camera.top = half
  camera.bottom = -half
  camera.near = 1
  camera.far = diagonal * 2.5 + LIGHT_SHADOW_MARGIN_M
  camera.updateProjectionMatrix()
  light.shadow.bias = -0.0005

  // 方向光的目标点必须同时在场景图中才参与矩阵计算
  const target = new THREE.Object3D()
  target.name = 'map-light-target'
  target.position.set(bounds.centerWorldX, 0, bounds.centerWorldZ)
  light.target = target
  return { light, target }
}

interface InitialFramingProps {
  bounds: SceneBounds
}

/**
 * 临时初始取景（TASK-004 最小可见性接线）：
 * 45° 俯视自动取景一次；TASK-013 的 camera-navigation Feature 接入
 * OrbitControls 与跟随后被其初始机位逻辑取代并移除。
 */
function InitialFraming({ bounds }: InitialFramingProps) {
  const camera = useThree((state) => state.camera)
  useEffect(() => {
    const diagonal = Math.max(bounds.diagonal, 1)
    // 45° 俯角：水平距离与高度相等；略带方位角避免完全轴向视角。
    // R3F 默认相机是透视相机，取景参数只对透视投影有意义。
    const perspective = camera as THREE.PerspectiveCamera
    const offset = diagonal * 0.55
    camera.position.set(
      bounds.centerWorldX + offset,
      offset,
      bounds.centerWorldZ + offset,
    )
    camera.lookAt(bounds.centerWorldX, 0, bounds.centerWorldZ)
    // 远平面覆盖全图并对角线余量，避免大地图被裁剪
    perspective.near = 0.5
    perspective.far = Math.max(diagonal * 6, 1000)
    perspective.updateProjectionMatrix()
  }, [bounds, camera])
  return null
}
