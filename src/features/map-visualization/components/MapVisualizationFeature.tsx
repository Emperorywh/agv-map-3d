/**
 * 地图可视化 Feature 公开根组件（SPEC §5.1、§5.4、§12.3；TASK-004/005/016）。
 *
 * 职责：协调地图场景的全部静态表达——室内冷灰背景（Canvas 不可用
 *       降级纯色清屏）、环境与灯光（方向光 + 渐变环境 PMREM（P2-5）+
 *       随观察范围收紧的阴影相机）、统一厂房外壳与贴墙地坪，以及
 *       TASK-005 的业务语义
 *       层（充电桩/呼吸灯、停车地面标识与名称合批）；地图生命周期由
 *       useMapVisualization 驱动，名称图集由本组件经 useMapNameAtlas 单一持有。
 *       TASK-016 接入上下文恢复重建：contextGeneration 资源代递增时，三个
 *       图层经 keyed Fragment 整体重挂（旧 GPU 对象由各图层所有权 effect 释
 *       放、新对象同提交内重建），环境工厂随后重建；地坪反射与 PMREM
 *       渲染目标均无 CPU 内容副本，需要重新采集。
 * 边界：本组件是 Feature 的唯一公开根；不解析协议、不读运行时配置文件、
 *       不做几何去重等业务算法（在 scene/model 层）。车辆属 fleet-monitoring。
 * 关键不变量：
 * 1. 尚无有效视图（首次加载失败、重试中）时只渲染清屏底色与灯光，不出现
 *    任何地图对象或 DOM 兜底（SPEC §7.4）；
 * 2. 视图原子替换时所有图层以同一 view 对象为源，同一渲染提交内完成整体
 *    换新，不出现新旧混排；名称图集随视图重建并释放旧实例；
 * 3. 主光方向固定，阴影投影按当前观察范围收紧，并对齐贴图像素抑制抖动；
 * 4. 动态阴影、地坪倒影与呼吸灯始终开启，完整效果不受运行负载影响；
 *    阴影分辨率由显式配置提供，不设置低画质能力开关；
 * 5. 本组件不移动相机：初始取景、轨道、跟随与俯瞰全部归 camera-navigation
 *    （TASK-013，SPEC §5.5/§8），相机位姿只由该 Feature 写入；
 * 6. 恢复重建顺序（TASK-016，SPEC §11.9）：同一恢复提交内按「地图图层
 *    （道路→地标）→ 环境」落地——图层 Fragment 在
 *    SceneLighting 之前，React 兄弟按 JSX 顺序执行 effect，因此环境重建
 *    恒在地图资源之后；MapGeometry 纯数据与名称图集（Canvas 源纹理）不换
 *    代，其 GPU 缓冲由 three.js 上下文恢复后的新鲜缓存自动重传；
 * 7. 恢复期环境工厂失败即本次恢复失败：经 onContextRecreateFailed 上抛计
 *    入失败计数（回滚语义 = 场景落定在「无 IBL 的完整一致状态」，绝不保留
 *    半建资源），初始挂载（资源代 0）的失败仍按既有降级处理不计入。
 */
import { Fragment, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import type { DiagnosticsReporter } from '@/shared/diagnostics'
import type { SceneBounds } from '../model/types'
import { getFactoryLayout } from '../model/factoryLayout'
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
import { PhysicalPathsLayer } from './PhysicalPathsLayer'
import { LandmarksLayer } from './LandmarksLayer'
import { GroundLayer } from './GroundLayer'
import { FactoryLayer } from './FactoryLayer'

export interface MapVisualizationFeatureProps {
  /** 地图视图描述符；null 表示尚无可加载的地图（保持清屏色） */
  map: MapViewDescriptor | null
  /** 结构化诊断通道（加载失败/恢复/环境降级）；默认内置通道 */
  diagnostics?: DiagnosticsReporter
  /** 方向光阴影贴图分辨率；来自 config.renderer.shadowMapSize，默认 2048 */
  shadowMapSize?: number
  /** 环境工厂注入点；默认顶点色渐变环境+PMREM（P2-5），测试注入替身 */
  environmentFactory?: SceneEnvironmentFactory
  /** 名称图集工厂注入点；默认真实 Canvas 工厂，测试注入替身 */
  nameAtlasFactory?: MapNameAtlasFactory
  /**
   * GPU 资源代（TASK-016 上下文恢复）：0 为初始挂载；恢复时由 app 状态机
   * 递增，驱动四个图层经 keyed Fragment 整体重挂与环境重建。
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
  environmentFactory = createGradientEnvironment,
  nameAtlasFactory = createMapNameAtlasDefault,
  contextGeneration = 0,
  onContextRecreateFailed,
  onFirstViewApplied,
}: MapVisualizationFeatureProps) {
  const { view } = useMapVisualization(map, { diagnostics })
  const scene = useThree((state) => state.scene)

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

  /**
   * 背景在副作用内成对创建和挂载，避免严格模式复用已清理的纹理句柄。
   * 显式持有场景背景，图层换代不影响高位总览时厂房外侧的中性底色。
   */
  useEffect(() => {
    const background = createBackgroundGradient()
    const value = background?.texture ?? new THREE.Color(MAP_CLEAR_COLOR)
    scene.background = value
    return () => {
      if (scene.background === value) scene.background = null
      background?.dispose()
    }
  }, [scene])

  /**
   * 地坪、厂房外壳与灯光共用布局；相机通过公开入口取得同一缓存结果。
   * 地图视图替换时整体换新，禁止地坪与墙体各自推算边距。
   */
  const factoryLayout = useMemo(
    () => view !== null ? getFactoryLayout(view.mapModel.sceneBounds) : null,
    [view],
  )

  return (
    <>
      {view !== null && factoryLayout !== null ? (
        // key 绑定资源代（TASK-016）：上下文恢复时代号变化强制四个图层整体
        // 卸载/挂载——旧 GPU 对象由各图层所有权 effect 释放，新对象在同一
        // 提交内重建（渲染阶段创建、清理阶段释放旧对象），规避 R3F 对已挂
        // 载 primitive 换 object 的重建丢弃问题；图层自身 key 仍携带视图版
        // 本，视图原子替换语义不变。
        <Fragment key={`map-resources-${contextGeneration}`}>
          <GroundLayer
            key={`ground-${view.version}`}
            bounds={factoryLayout.bounds}
          />
          <FactoryLayer key={`factory-${view.version}`} layout={factoryLayout} />
          <PhysicalPathsLayer
            key={`paths-${view.version}`}
            geometry={view.geometry}
          />
          <LandmarksLayer
            key={`landmarks-${view.version}`}
            mapModel={view.mapModel}
            worldTransform={view.worldTransform}
            nameAtlas={nameAtlas}
          />
        </Fragment>
      ) : null}
      {/* 环境与灯光位于图层之后（不变量 6）：恢复提交中环境重建恒在地图
          资源之后落地；方向光对象身份与场景图位置无关，语义不变 */}
      <SceneLighting
        bounds={factoryLayout?.bounds ?? null}
        wallHeight={factoryLayout?.config.wallHeightM ?? 12}
        shadowMapSize={shadowMapSize}
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
  /**
   * 阴影包络包含厂房墙高，避免高窗和立柱超出阴影相机而失去落地阴影。
   * 布局为空时使用标准高度，不改变加载阶段的资源生命周期。
   */
  wallHeight: number
  shadowMapSize: number
  environmentFactory?: SceneEnvironmentFactory
  diagnostics?: DiagnosticsReporter
  /** GPU 资源代（TASK-016）：变化时环境工厂重建（PMREM 渲染目标无法自动重传） */
  contextGeneration: number
  /** 恢复期环境重建失败上抛；仅资源代 > 0 时触发 */
  onContextRecreateFailed?: () => void
}

/**
 * 正式地图与开发空间样板共享同一套光照，防止样板通过单独调光掩盖差异。
 * 默认环境工厂在此兜底，调用方可以注入环境替身验证恢复流程。
 */
export function SceneLighting({
  bounds,
  wallHeight,
  shadowMapSize,
  environmentFactory = createGradientEnvironment,
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

  // 方向光按包围盒与配置分辨率构建，始终投射实时阴影。
  // 地图或显式配置变化时整体重建并释放旧灯，不根据运行负载改变效果。
  const lighting = useMemo(
    () =>
      bounds !== null
        ? createStaticDirectionalLight(bounds, wallHeight, shadowMapSize)
        : null,
    [bounds, wallHeight, shadowMapSize],
  )
  useEffect(() => () => lighting?.light.dispose(), [lighting])
  /**
   * 阴影分辨率优先用于正在观察的区域，总览时自动扩大到全厂。
   * 只调整同一盏灯的投影范围，不额外增加车辆或建筑的阴影渲染次数。
   */
  useFrame(({ camera }) => {
    lighting?.updateShadowFocus(camera)
  })

  /**
   * 低密度冷灰雾按厂房范围归一化，保留远侧墙和立柱的轮廓。
   * 雾是场景属性，不参与上下文恢复时的资源重建。
   */
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
      {/* 顶部大面积柔光模拟厂房室内照明，地面反射填补墙脚和设备暗部。
          与主光保持同一资源代，配合持续开启的动态阴影表现空间层次。 */}
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
  /**
   * 根据最终镜头收紧阴影覆盖，保持近景车辆与柱脚的可用像素密度。
   * 使用贴图像素对齐抑制轻微平移时的阴影抖动。
   */
  updateShadowFocus(camera: THREE.Camera): void
}

/**
 * 阴影相机覆盖厂房底部和墙顶的八个角，保留墙根、立柱与设备底部阴影。
 * 主光从接近顶部的方向落下，配合半球柔光表现室内漫反射。
 */
function createStaticDirectionalLight(
  bounds: SceneBounds,
  wallHeight: number,
  shadowMapSize: number,
): StaticLighting {
  const diagonal = Math.max(bounds.diagonal, 1)
  const light = new THREE.DirectionalLight(0xffffff, DIRECTIONAL_LIGHT_INTENSITY)
  light.name = 'map-directional-light'
  light.position.set(
    bounds.centerWorldX + diagonal * 0.28,
    diagonal * 0.9,
    bounds.centerWorldZ + diagonal * 0.18,
  )
  // 所有环境均启用完整动态阴影，阴影贴图按显式配置创建。
  // 不再保留按质量等级关闭投影的分支。
  light.castShadow = true
  light.shadow.mapSize.set(shadowMapSize, shadowMapSize)

  // 光空间正交基（与 three.js lookAt 同构）：forward 指向目标，right/up 张成
  // 垂直于视线的平面；厂房地面与墙顶投影到该基上取 min/max 包络
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
  /**
   * 逐一投影地面与墙顶，阴影裁剪面同时覆盖地坪和十二米高的围护结构。
   * 扩展边距保留柱脚和柔化采样空间，不依赖相机当前正在看哪一区域。
   */
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
    minRight = Math.min(minRight, sx)
    maxRight = Math.max(maxRight, sx)
    for (const cornerHeight of [0, wallHeight]) {
      const cornerY = cornerHeight - light.position.y
      const sy = rx * up.x + cornerY * up.y + rz * up.z
      const depth = rx * forward.x + cornerY * forward.y + rz * forward.z
      minUp = Math.min(minUp, sy)
      maxUp = Math.max(maxUp, sy)
      minDepth = Math.min(minDepth, depth)
      maxDepth = Math.max(maxDepth, depth)
    }
  }
  const camera = light.shadow.camera
  camera.left = minRight - margin
  camera.right = maxRight + margin
  camera.top = maxUp + margin
  camera.bottom = minUp - margin
  camera.near = Math.max(minDepth - margin, 1)
  camera.far = maxDepth + margin
  camera.updateProjectionMatrix()
  /**
   * 小幅偏移压制墙板自阴影条纹，保留墙脚接触边缘。
   * 柔化参数沿用现有阴影管线，不额外增加多盏投影灯。
   */
  light.shadow.bias = -0.00008
  light.shadow.normalBias = 0.025
  light.shadow.radius = 2

  // 方向光的目标点必须同时在场景图中才参与矩阵计算
  const target = new THREE.Object3D()
  target.name = 'map-light-target'
  target.position.set(bounds.centerWorldX, 0, bounds.centerWorldZ)
  light.target = target

  /**
   * 中性顶部柔光配合浅灰地面回光，避免冷蓝环境把整个空间染成蓝灰。
   * 墙边的局部光感由建筑灯槽和地坪过渡承担，不用全局加亮代替。
   */
  const hemisphere = new THREE.HemisphereLight(0xe4e7e8, 0x959c9f, 0.65)
  hemisphere.name = 'map-hemisphere-light'
  sceneLightingSeq += 1
  const viewDirection = new THREE.Vector3()
  return { id: sceneLightingSeq, light, target, hemisphere, updateShadowFocus(viewCamera) {
    if (!(viewCamera instanceof THREE.PerspectiveCamera)) return
    viewCamera.getWorldDirection(viewDirection)
    const distance = viewCamera.position.y / Math.max(0.05, -viewDirection.y)
    const focusX = viewCamera.position.x + viewDirection.x * distance
    const focusZ = viewCamera.position.z + viewDirection.z * distance
    const radius = Math.max(22, distance * Math.tan(viewCamera.getEffectiveFOV() * Math.PI / 360) * Math.max(1, viewCamera.aspect) * 1.25)
    const x0 = Math.max(bounds.minWorldX, focusX - radius)
    const x1 = Math.min(bounds.maxWorldX, focusX + radius)
    const z0 = Math.max(bounds.minWorldZ, focusZ - radius)
    const z1 = Math.min(bounds.maxWorldZ, focusZ + radius)
    if (x0 >= x1 || z0 >= z1) return
    let left = Infinity
    let rightEdge = -Infinity
    let bottom = Infinity
    let top = -Infinity
    for (const x of [x0, x1]) for (const z of [z0, z1]) for (const y of [0, wallHeight]) {
      const rx = x - light.position.x
      const ry = y - light.position.y
      const rz = z - light.position.z
      const sx = rx * right.x + rz * right.z
      const sy = rx * up.x + ry * up.y + rz * up.z
      left = Math.min(left, sx)
      rightEdge = Math.max(rightEdge, sx)
      bottom = Math.min(bottom, sy)
      top = Math.max(top, sy)
    }
    const width = rightEdge - left + margin * 2
    const height = top - bottom + margin * 2
    const texelX = width / shadowMapSize
    const texelY = height / shadowMapSize
    const cx = Math.round((left + rightEdge) / 2 / texelX) * texelX
    const cy = Math.round((bottom + top) / 2 / texelY) * texelY
    const nextLeft = cx - width / 2
    const nextTop = cy + height / 2
    if (Math.abs(camera.left - nextLeft) + Math.abs(camera.top - nextTop) + Math.abs(camera.right - (cx + width / 2)) + Math.abs(camera.bottom - (cy - height / 2)) < 0.00001) return
    camera.left = nextLeft
    camera.right = cx + width / 2
    camera.top = nextTop
    camera.bottom = cy - height / 2
    camera.updateProjectionMatrix()
  } }
}
