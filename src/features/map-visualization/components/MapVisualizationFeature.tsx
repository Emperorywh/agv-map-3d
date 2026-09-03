/**
 * 地图可视化 Feature 公开根组件（SPEC §5.1、§5.4、§12.3；TASK-004/005/016）。
 *
 * 职责：协调地图场景的全部静态表达——背景渐变/暗角（P2-6，Canvas 不可用
 *       降级纯色清屏）、环境与灯光（方向光 + 渐变环境 PMREM（P2-5）+
 *       静态阴影相机）、工业地坪、去重物理路径、
 *       节点实例层，以及 TASK-005 的业务语义层（充电桩/呼吸灯、仓库与停车
 *       地面标识、名称合批、独占区蓝色外沿与近景名称）；地图生命周期由
 *       useMapVisualization 驱动，名称图集由本组件经 useMapNameAtlas 单一持有。
 *       TASK-016 接入上下文恢复重建：contextGeneration 资源代递增时，五个
 *       图层经 keyed Fragment 整体重挂（旧 GPU 对象由各图层所有权 effect 释
 *       放、新对象同提交内重建），环境工厂随后重建（PMREM 渲染目标是唯一无
 *       CPU 侧数据源、three.js 无法自动重传的资源）。
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
 *    （TASK-013，SPEC §5.5/§8），相机位姿只由该 Feature 写入；
 * 6. 恢复重建顺序（TASK-016，SPEC §11.9）：同一恢复提交内按「地图五图层
 *    （地坪→路径→节点→地标→独占区）→ 环境」落地——图层 Fragment 在
 *    SceneLighting 之前，React 兄弟按 JSX 顺序执行 effect，因此环境重建
 *    恒在地图资源之后；MapGeometry 纯数据与名称图集（Canvas 源纹理）不换
 *    代，其 GPU 缓冲由 three.js 上下文恢复后的新鲜缓存自动重传；
 * 7. 恢复期环境工厂失败即本次恢复失败：经 onContextRecreateFailed 上抛计
 *    入失败计数（回滚语义 = 场景落定在「无 IBL 的完整一致状态」，绝不保留
 *    半建资源），初始挂载（资源代 0）的失败仍按既有降级处理不计入。
 */
import { Fragment, useEffect, useMemo, useRef } from 'react'
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
  createGradientEnvironment,
  type SceneEnvironmentFactory,
} from '../scene/createSceneEnvironment'
import { createBackgroundGradient } from '../scene/createBackgroundGradient'
import { createMapNameAtlas } from '../scene/mapNameAtlas'
import {
  DEFAULT_SHADOW_MAP_SIZE,
  DIRECTIONAL_LIGHT_INTENSITY,
  LIGHT_SHADOW_MARGIN_M,
  MAP_CLEAR_COLOR,
  SCENE_FOG_DENSITY_PER_DIAGONAL,
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
  /**
   * 动态阴影能力开关（SPEC §6.5 行动 3；TASK-014 质量能力接线）：false 时
   * 方向光不再投射阴影（shadow camera 配置保留，恢复只需翻回开关）；默认 true。
   */
  dynamicShadowsEnabled?: boolean
  /** 环境工厂注入点；默认顶点色渐变环境+PMREM（P2-5），测试注入替身 */
  environmentFactory?: SceneEnvironmentFactory
  /** 名称图集工厂注入点；默认真实 Canvas 工厂，测试注入替身 */
  nameAtlasFactory?: MapNameAtlasFactory
  /** 装饰动画能力开关（呼吸灯等）；默认 true，TASK-014 质量控制接线 */
  decorationsEnabled?: boolean
  /**
   * GPU 资源代（TASK-016 上下文恢复）：0 为初始挂载；恢复时由 app 状态机
   * 递增，驱动五个图层经 keyed Fragment 整体重挂与环境重建。
   */
  contextGeneration?: number
  /**
   * 恢复期资源重建失败上抛（TASK-016）：当前为环境工厂失败（唯一依赖真实
   * GL 的创建步骤）；仅资源代 > 0（恢复重建）时调用，计入恢复失败计数。
   */
  onContextRecreateFailed?: () => void
  /**
   * 首个有效地图视图就绪信号（TASK-017 启动编排）：本组件生命周期内第一
   * 次存在生效视图时调用一次（每个挂载实例至多一次；刷新重建不重复触发）。
   * app 组合层据此合成 appInteractive 启动阶段；未注入时不上报。
   */
  onFirstViewApplied?: () => void
}

export function MapVisualizationFeature({
  map,
  diagnostics,
  shadowMapSize = DEFAULT_SHADOW_MAP_SIZE,
  dynamicShadowsEnabled = true,
  environmentFactory = createGradientEnvironment,
  nameAtlasFactory = createMapNameAtlasDefault,
  decorationsEnabled = true,
  contextGeneration = 0,
  onContextRecreateFailed,
  onFirstViewApplied,
}: MapVisualizationFeatureProps) {
  const { view } = useMapVisualization(map, { diagnostics })

  // 首个有效视图就绪信号（TASK-017）：一次性；依赖取「是否存在视图」布尔
  // 值，视图原子替换（刷新/恢复换代）不重复触发。回调经 ref 透传，内联
  // 函数不触发重复执行。
  const hasView = view !== null
  const firstViewAppliedRef = useRef(false)
  const onFirstViewAppliedRef = useRef(onFirstViewApplied)
  onFirstViewAppliedRef.current = onFirstViewApplied
  useEffect(() => {
    if (hasView && !firstViewAppliedRef.current) {
      firstViewAppliedRef.current = true
      onFirstViewAppliedRef.current?.()
    }
  }, [hasView])

  // 名称图集：随视图重建、失败降级为 null（名称缺失不阻断地图）。图集是
  // Canvas 源纹理，上下文恢复后由 three.js 新鲜缓存自动重传，不随资源换代。
  const nameAtlas = useMapNameAtlas(view?.mapModel ?? null, {
    factory: nameAtlasFactory,
    diagnostics,
  })

  // 背景渐变纹理（P2-6）：模块级静态资源，挂载时创建一次；Canvas 不可得
  // （无头测试环境）时为 null，降级为 MAP_CLEAR_COLOR 纯色清屏。Canvas 源
  // 纹理上下文恢复后由 three.js 自动重传，不随资源换代。
  const background = useMemo(() => createBackgroundGradient(), [])
  useEffect(() => () => background?.dispose(), [background])

  return (
    <>
      {/* 背景（P2-6）：渐变 + 暗角纹理优先，Canvas 不可用时保持纯色清屏——
          地图未就绪或失败重试期间页面同样保持背景色 */}
      {background !== null ? (
        <primitive object={background.texture} attach="background" />
      ) : (
        <color attach="background" args={[MAP_CLEAR_COLOR]} />
      )}
      {view !== null ? (
        // key 绑定资源代（TASK-016）：上下文恢复时代号变化强制五个图层整体
        // 卸载/挂载——旧 GPU 对象由各图层所有权 effect 释放，新对象在同一
        // 提交内重建（渲染阶段创建、清理阶段释放旧对象），规避 R3F 对已挂
        // 载 primitive 换 object 的重建丢弃问题；图层自身 key 仍携带视图版
        // 本，视图原子替换语义不变。
        <Fragment key={`map-resources-${contextGeneration}`}>
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
        </Fragment>
      ) : null}
      {/* 环境与灯光位于图层之后（不变量 6）：恢复提交中环境重建恒在地图
          资源之后落地；方向光对象身份与场景图位置无关，语义不变 */}
      <SceneLighting
        bounds={view?.mapModel.sceneBounds ?? null}
        shadowMapSize={shadowMapSize}
        dynamicShadowsEnabled={dynamicShadowsEnabled}
        environmentFactory={environmentFactory}
        diagnostics={diagnostics}
        contextGeneration={contextGeneration}
        onContextRecreateFailed={onContextRecreateFailed}
      />
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
  dynamicShadowsEnabled: boolean
  environmentFactory: SceneEnvironmentFactory
  diagnostics?: DiagnosticsReporter
  /** GPU 资源代（TASK-016）：变化时环境工厂重建（PMREM 渲染目标无法自动重传） */
  contextGeneration: number
  /** 恢复期环境重建失败上抛；仅资源代 > 0 时触发 */
  onContextRecreateFailed?: () => void
}

/** 灯光与环境：PMREM 环境贴图 + 按地图包围盒静态配置的方向光阴影 */
function SceneLighting({
  bounds,
  shadowMapSize,
  dynamicShadowsEnabled,
  environmentFactory,
  diagnostics,
  contextGeneration,
  onContextRecreateFailed,
}: SceneLightingProps) {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)

  // 环境贴图生命周期：工厂创建、卸载释放；工厂失败记录诊断并降级为无 IBL。
  // 资源代进入依赖（TASK-016）：上下文恢复后 PMREM 渲染目标的 GPU 内容无法
  // 由 three.js 自动重传（无 CPU 侧数据源），必须整代重建；重建失败在恢复期
  // 上抛 onContextRecreateFailed 计入恢复失败计数（回滚为无 IBL 的一致降级态），
  // 初始挂载（资源代 0）的失败沿用既有降级语义、不计入恢复统计。
  useEffect(() => {
    let handle: ReturnType<SceneEnvironmentFactory> | null = null
    try {
      handle = environmentFactory(gl)
      scene.environment = handle.texture
    } catch (error) {
      diagnostics?.report('MAP_ENVIRONMENT_FAILED', 'warn', '环境贴图创建失败，已降级为无 IBL', {
        reason: error instanceof Error ? error.message : String(error),
        contextGeneration,
      })
      if (contextGeneration > 0) {
        onContextRecreateFailed?.()
      }
    }
    return () => {
      scene.environment = null
      handle?.dispose()
    }
  }, [gl, scene, environmentFactory, diagnostics, contextGeneration, onContextRecreateFailed])

  // 方向光按包围盒静态构建：bounds / 阴影分辨率 / 动态阴影开关变化时整体重建
  // 并释放旧灯（分辨率与开关是 TASK-014 质量 2/3 级的能力开关，换代必须生效）
  const lighting = useMemo(
    () =>
      bounds !== null
        ? createStaticDirectionalLight(bounds, shadowMapSize, dynamicShadowsEnabled)
        : null,
    [bounds, shadowMapSize, dynamicShadowsEnabled],
  )
  useEffect(() => () => lighting?.light.dispose(), [lighting])

  // 场景雾（P1-3）：FogExp2 密度按地图对角线缩放，雾色 = 清屏底色——远处
  // 地面渐隐进背景，配合 50m 地坪边距消除「黑色孤岛」；近景无感知。fog 是
  // 纯 CPU 场景属性（非 GPU 资源），不参与 TASK-016 资源换代。
  useEffect(() => {
    if (bounds === null) {
      return
    }
    scene.fog = new THREE.FogExp2(
      MAP_CLEAR_COLOR,
      SCENE_FOG_DENSITY_PER_DIAGONAL / Math.max(bounds.diagonal, 1),
    )
    return () => {
      scene.fog = null
    }
  }, [scene, bounds])

  if (lighting === null) {
    return null
  }
  return (
    <>
      {/* dispose={null}：灯光对象由上方 effect 显式释放。key 携带资源代：
          R3F 对已挂载 primitive 换 object 的重建依赖「兄弟序列尾部」探测，
          与兄弟元素组合时换新会被静默丢弃（TASK-005 实测结论）——灯光与
          目标点都非尾部元素，key 变化强制走干净的卸载/挂载路径，保证阴影
          分辨率与动态阴影开关的真实生效。 */}
      <primitive
        key={`map-light-${lighting.id}`}
        object={lighting.light}
        dispose={null}
      />
      <primitive
        key={`map-light-target-${lighting.id}`}
        object={lighting.target}
        dispose={null}
      />
      {/* 冷色半球光（P1-9）：暗部补冷蓝灰环境光，明暗过渡更接近 Reference；
          强度 0.5，与方向光降档（P0-7）后的总量平衡，不过曝 */}
      <primitive
        key={`map-hemisphere-${lighting.id}`}
        object={lighting.hemisphere}
        dispose={null}
      />
    </>
  )
}

/** 资源代计数器：灯光对象换代时递增，驱动 primitive key 变化 */
let sceneLightingSeq = 0

interface StaticLighting {
  /** 资源代序号：每次重建递增，作为 primitive 的 key */
  readonly id: number
  light: THREE.DirectionalLight
  target: THREE.Object3D
  /** 冷色半球光（P1-9）：与方向光同代创建与释放 */
  hemisphere: THREE.HemisphereLight
}

/**
 * 按地图包围盒配置方向光：位置取对角线比例偏移，阴影正交相机静态覆盖全图。
 * 阴影相机按「灯光空间下的地图四角」包络（P0-8）：此前按 对角线/2 + margin 的
 * 正方形覆盖 311m 见方，近半面积在地图之外；改按四角在光空间的 min/max 设
 * left/right/top/bottom 与 near/far，有效分辨率显著提升（同贴图尺寸下）。
 * 同时创建冷色半球光（P1-9：天顶冷蓝 / 地面深灰，强度 0.5），补匀暗部。
 */
function createStaticDirectionalLight(
  bounds: SceneBounds,
  shadowMapSize: number,
  dynamicShadowsEnabled: boolean,
): StaticLighting {
  const diagonal = Math.max(bounds.diagonal, 1)
  const light = new THREE.DirectionalLight(0xffffff, DIRECTIONAL_LIGHT_INTENSITY)
  light.name = 'map-directional-light'
  light.position.set(
    bounds.centerWorldX + diagonal * 0.4,
    diagonal * 0.9,
    bounds.centerWorldZ + diagonal * 0.25,
  )
  // 动态阴影能力开关（SPEC §6.5 行动 3）：false 时不再投射阴影贴图
  light.castShadow = dynamicShadowsEnabled
  light.shadow.mapSize.set(shadowMapSize, shadowMapSize)

  // 光空间正交基（与 three.js lookAt 同构）：forward 指向目标，right/up 张成
  // 垂直于视线的平面；地图四角（地面 y=0）投影到该基上取 min/max 包络
  const forward = new THREE.Vector3(
    bounds.centerWorldX - light.position.x,
    -light.position.y,
    bounds.centerWorldZ - light.position.z,
  ).normalize()
  const right = new THREE.Vector3()
    .crossVectors(forward, new THREE.Vector3(0, 1, 0))
    .normalize()
  const up = new THREE.Vector3().crossVectors(right, forward).normalize()

  const margin = LIGHT_SHADOW_MARGIN_M
  // 角点（y=0）相对灯光位置的 y 分量为常量 −灯高：left/right/top/bottom 的
  // min/max 不受常量平移影响，但 near/far 是沿视线的绝对深度，必须计入
  const cornerY = -light.position.y
  let minRight = Infinity
  let maxRight = -Infinity
  let minUp = Infinity
  let maxUp = -Infinity
  let minDepth = Infinity
  let maxDepth = -Infinity
  for (const [cx, cz] of [
    [bounds.minWorldX, bounds.minWorldZ],
    [bounds.maxWorldX, bounds.minWorldZ],
    [bounds.minWorldX, bounds.maxWorldZ],
    [bounds.maxWorldX, bounds.maxWorldZ],
  ] as const) {
    const rx = cx - light.position.x
    const rz = cz - light.position.z
    const sx = rx * right.x + rz * right.z
    const sy = rx * up.x + cornerY * up.y + rz * up.z
    const depth = rx * forward.x + cornerY * forward.y + rz * forward.z
    minRight = Math.min(minRight, sx)
    maxRight = Math.max(maxRight, sx)
    minUp = Math.min(minUp, sy)
    maxUp = Math.max(maxUp, sy)
    minDepth = Math.min(minDepth, depth)
    maxDepth = Math.max(maxDepth, depth)
  }
  const camera = light.shadow.camera
  camera.left = minRight - margin
  camera.right = maxRight + margin
  camera.top = maxUp + margin
  camera.bottom = minUp - margin
  camera.near = Math.max(minDepth - margin, 1)
  camera.far = maxDepth + margin
  camera.updateProjectionMatrix()
  light.shadow.bias = -0.0005

  // 方向光的目标点必须同时在场景图中才参与矩阵计算
  const target = new THREE.Object3D()
  target.name = 'map-light-target'
  target.position.set(bounds.centerWorldX, 0, bounds.centerWorldZ)
  light.target = target

  const hemisphere = new THREE.HemisphereLight(0x3a4660, 0x14171c, 0.5)
  hemisphere.name = 'map-hemisphere-light'
  sceneLightingSeq += 1
  return { id: sceneLightingSeq, light, target, hemisphere }
}
