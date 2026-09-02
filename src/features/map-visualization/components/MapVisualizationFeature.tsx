/**
 * 地图可视化 Feature 公开根组件（SPEC §5.1、§5.4、§12.3；TASK-004/005）。
 *
 * 职责：协调地图场景的全部静态表达——清屏底色、环境与灯光（方向光 +
 *       RoomEnvironment/PMREM + 静态阴影相机）、工业地坪、去重物理路径、
 *       节点实例层，以及 TASK-005 的业务语义层（充电桩/呼吸灯、仓库与停车
 *       地面标识、名称合批、独占区蓝色外沿与近景名称）；地图生命周期由
 *       useMapVisualization 驱动，名称图集由本组件经 useMapNameAtlas 单一持有。
 * 边界：本组件是 Feature 的唯一公开根；不解析协议、不读运行时配置文件、
 *       不做几何去重等业务算法（在 scene/model 层）。车辆属 fleet-monitoring。
 * 关键不变量：
 * 1. 尚无有效视图（首次加载失败、重试中）时只渲染清屏底色与灯光，不出现
 *    任何地图对象或 DOM 兜底（SPEC §7.4）；
 * 2. 视图原子替换时所有图层以同一 view 对象为源，同一渲染提交内完成整体
 *    换新，不出现新旧混排；名称图集随视图重建并释放旧实例；
 * 3. 灯光阴影相机按当前地图包围盒静态配置（SPEC §5.4），不逐帧更新；
 * 4. decorationsEnabled 只影响装饰动画（呼吸灯），不隐藏任何业务语义对象
 *    （SPEC §6.5：质量降级不隐藏核心语义）；
 * 5. 本组件不移动相机：初始取景、轨道、跟随与俯瞰全部归 camera-navigation
 *    （TASK-013，SPEC §5.5/§8），相机位姿只由该 Feature 写入。
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
  useMapNameAtlas,
  type MapNameAtlasFactory,
} from '../hooks/useMapNameAtlas'
import {
  createRoomEnvironment,
  type SceneEnvironmentFactory,
} from '../scene/createSceneEnvironment'
import { createMapNameAtlas } from '../scene/mapNameAtlas'
import {
  DEFAULT_SHADOW_MAP_SIZE,
  DIRECTIONAL_LIGHT_INTENSITY,
  LIGHT_SHADOW_MARGIN_M,
  MAP_CLEAR_COLOR,
} from '../scene/mapAppearance'
import { GroundLayer } from './GroundLayer'
import { PhysicalPathsLayer } from './PhysicalPathsLayer'
import { NodesLayer } from './NodesLayer'
import { LandmarksLayer } from './LandmarksLayer'
import { ExclusiveGroupsLayer } from './ExclusiveGroupsLayer'

export interface MapVisualizationFeatureProps {
  /** 地图视图描述符；null 表示尚无可加载的地图（保持清屏色） */
  map: MapViewDescriptor | null
  /** 结构化诊断通道（加载失败/恢复/环境降级）；默认内置通道 */
  diagnostics?: DiagnosticsReporter
  /** 方向光阴影贴图分辨率；来自 config.renderer.shadowMapSize，默认 2048 */
  shadowMapSize?: number
  /** 环境工厂注入点；默认 RoomEnvironment+PMREM，测试注入替身 */
  environmentFactory?: SceneEnvironmentFactory
  /** 名称图集工厂注入点；默认真实 Canvas 工厂，测试注入替身 */
  nameAtlasFactory?: MapNameAtlasFactory
  /** 装饰动画能力开关（呼吸灯等）；默认 true，TASK-014 质量控制接线 */
  decorationsEnabled?: boolean
}

export function MapVisualizationFeature({
  map,
  diagnostics,
  shadowMapSize = DEFAULT_SHADOW_MAP_SIZE,
  environmentFactory = createRoomEnvironment,
  nameAtlasFactory = createMapNameAtlasDefault,
  decorationsEnabled = true,
}: MapVisualizationFeatureProps) {
  const { view } = useMapVisualization(map, { diagnostics })
  // 名称图集：随视图重建、失败降级为 null（名称缺失不阻断地图）
  const nameAtlas = useMapNameAtlas(view?.mapModel ?? null, {
    factory: nameAtlasFactory,
    diagnostics,
  })

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
          {/* key 绑定视图版本：视图原子替换时各图层整体卸载/重建，避免
              R3F 对已挂载 primitive 换 object 时的重建丢弃问题（地图恢复
              旧场景必然完整离场，与 useMapVisualization 的所有权释放配合） */}
          <GroundLayer key={`ground-${view.version}`} bounds={view.mapModel.sceneBounds} />
          <PhysicalPathsLayer key={`paths-${view.version}`} geometry={view.geometry} />
          <NodesLayer key={`nodes-${view.version}`} data={view.geometry.nodeInstances} />
          <LandmarksLayer
            key={`landmarks-${view.version}`}
            mapModel={view.mapModel}
            worldTransform={view.worldTransform}
            nameAtlas={nameAtlas}
            decorationsEnabled={decorationsEnabled}
          />
          <ExclusiveGroupsLayer
            key={`exclusive-${view.version}`}
            mapModel={view.mapModel}
            worldTransform={view.worldTransform}
            physical={view.geometry.physical}
            nameAtlas={nameAtlas}
          />
        </>
      ) : null}
    </>
  )
}

/** 默认图集工厂（保持组件 props 默认值引用稳定） */
function createMapNameAtlasDefault(
  ...args: Parameters<MapNameAtlasFactory>
): ReturnType<MapNameAtlasFactory> {
  return createMapNameAtlas(...args)
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
