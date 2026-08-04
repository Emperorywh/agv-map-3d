/**
 * FactoryCanvas：WebGL renderer 宿主与渲染质量策略
 *（SPEC §1.4 页面容器、§5.2 渲染边界、§6.6 灯光与后处理、§10.3 资源释放、§11 异常）。
 *
 * - R3F Canvas：WebGL2（three 0.185 WebGLRenderer 仅有 WebGL2 代码路径）、
 *   antialias=true（WebGL2 MSAA）、frameloop='demand'（§5.2：OrbitControls change
 *   → invalidate，阻尼停止后不再重绘）、shadows（PCFSoft）、默认相机
 *   fov 46 / near 0.1 / far 2000（§9.1，机位由 CameraRig 经 fit 纯函数设置）；
 * - 质量策略：ACESFilmicToneMapping、exposure 1.05（renderer 创建时固定）；
 *   dpr 不在 Canvas prop 固定——RendererQuality 按 §6.6 公式
 *   min(devicePixelRatio, sqrt(MAX_RENDER_PIXELS/(cssW×cssH)), 2) 随 viewport
 *   尺寸精确化（3840×2160 CSS 画布有效 dpr=1，渲染像素 ≤ 8,294,400）；
 * - 灯光（§6.6）：平行光（太阳，4096 shadow map，shadow camera 由
 *   core/directionalShadowFit 纯函数按厂房三维 bounds 推导）+ 半球光 +
 *   PMREM environment texture（EnvironmentResource，卸载释放）；
 * - 宿主：Canvas 与 CSS2D overlay 共用 position:relative、宽高 100% 的宿主（§1.4）。
 *   viewport 任一维为 0 时 R3F 内置守卫跳过 root configure——不执行 setSize/render；
 *   恢复正数后重新 configure，重算 aspect/projection（§1.4），CameraRig 的尺寸效应
 *   负责重新 fit 或仅更新投影并触发标签候选重算钩子；
 * - context lost → WebGLUnavailableError 上抛页面，不自动恢复旧场景（§11；
 *   不 preventDefault、不监听 restored、页面进入全屏错误态）；context 初始化
 *   失败同样映射为 WebGLUnavailableError 上抛。
 */

import { Canvas, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { ACESFilmicToneMapping, Object3D, WebGLRenderer } from 'three'
import type { DirectionalLight, WebGLRendererParameters } from 'three'

import type { FactoryBoundsDto } from '../../application/factorySceneModel'
import { CAMERA_FAR, CAMERA_FOV, CAMERA_NEAR } from '../../config/cameraConfig'
import { SHADOW_MAP_SIZE } from '../../config/qualityProfile'
import {
  HEMISPHERE_GROUND_COLOR,
  HEMISPHERE_SKY_COLOR,
  SUN_LIGHT_COLOR,
} from '../../config/visualTheme'
import { WebGLUnavailableError } from '../../domain/errors'
import { fitDirectionalShadowCamera } from '../core/directionalShadowFit'
import { resolveRenderDpr } from '../core/renderDpr'
import { createEnvironmentResource } from '../resources/EnvironmentResource'

// ---------------------------------------------------------------------------
// §6.6 固定灯光/后处理参数（SPEC 未列入 §13 配置表，唯一定义于此）
// ---------------------------------------------------------------------------

/** 平行光（太阳）强度 */
const SUN_LIGHT_INTENSITY = 2.2
/** 半球光强度 */
const HEMISPHERE_LIGHT_INTENSITY = 0.55
/** ACESFilmic 色调映射曝光 */
const TONE_MAPPING_EXPOSURE = 1.05
/** 阴影 bias / normalBias（§6.6） */
const SHADOW_BIAS = -0.0001
const SHADOW_NORMAL_BIAS = 0.05

/** WebGLUnavailableError 稳定错误码：WebGL2/context 初始化失败（§11） */
export const WEBGL_CONTEXT_INIT_FAILED = 'WEBGL_CONTEXT_INIT_FAILED'
/** WebGLUnavailableError 稳定错误码：context lost（§11，不自动恢复） */
export const WEBGL_CONTEXT_LOST = 'WEBGL_CONTEXT_LOST'

export interface FactoryCanvasProps {
  /** 厂房内空边界（灯光 shadow camera 推导随 bounds 更新） */
  readonly bounds: FactoryBoundsDto
  /** §11：WebGL2/context 初始化失败或 context lost 时上抛页面（不自动恢复） */
  readonly onWebGLUnavailable: (error: WebGLUnavailableError) => void
  readonly children?: ReactNode
}

// ---------------------------------------------------------------------------
// renderer 创建（WebGL2 + antialias + 色调映射；初始化失败映射 §11 错误）
// ---------------------------------------------------------------------------

function createWebGLRenderer(
  parameters: WebGLRendererParameters,
  reportUnavailable: (error: WebGLUnavailableError) => void,
): WebGLRenderer {
  try {
    const renderer = new WebGLRenderer({ ...parameters, antialias: true })
    renderer.toneMapping = ACESFilmicToneMapping
    renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE
    return renderer
  } catch (cause) {
    // §11：WebGL2/context 初始化失败 → WebGLUnavailableError（页面全屏提示 + 刷新按钮）
    reportUnavailable(new WebGLUnavailableError(
      WEBGL_CONTEXT_INIT_FAILED,
      '当前浏览器或硬件不支持 WebGL2，无法初始化三维画布',
      { cause },
    ))
    throw cause
  }
}

// ---------------------------------------------------------------------------
// 质量策略：dpr 按 §6.6 公式随 viewport 尺寸精确化
// ---------------------------------------------------------------------------

function RendererQuality(): null {
  const size = useThree((state) => state.size)
  const dpr = useThree((state) => state.viewport.dpr)
  const setDpr = useThree((state) => state.setDpr)

  useEffect(() => {
    const devicePixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio
    const target = resolveRenderDpr(size.width, size.height, devicePixelRatio)
    // R3F 每次 configure（resize/重渲染）会按 dpr prop 复位 viewport.dpr，
    // 本效应在偏离公式目标时重新校准；幂等，单步收敛
    if (dpr !== target) setDpr(target)
  }, [size, dpr, setDpr])

  return null
}

// ---------------------------------------------------------------------------
// context lost 守卫（§11：上抛页面，不自动恢复）
// ---------------------------------------------------------------------------

interface ContextLostGuardProps {
  readonly reportUnavailable: (error: WebGLUnavailableError) => void
}

function ContextLostGuard({ reportUnavailable }: ContextLostGuardProps): null {
  const gl = useThree((state) => state.gl)

  useEffect(() => {
    const canvas = gl.domElement
    const handleContextLost = (event: Event): void => {
      // §11：不 preventDefault、不自动恢复旧场景；上抛页面进入全屏错误态
      reportUnavailable(new WebGLUnavailableError(
        WEBGL_CONTEXT_LOST,
        'WebGL 渲染上下文已丢失，请刷新页面',
        { cause: event },
      ))
    }
    canvas.addEventListener('webglcontextlost', handleContextLost)
    // 卸载即移除（含 StrictMode 重复挂载）：任一时刻仅一份监听器；
    // R3F 在真实卸载后强制释放 context 时本监听器已移除，不会误报
    return () => {
      canvas.removeEventListener('webglcontextlost', handleContextLost)
    }
  }, [gl, reportUnavailable])

  return null
}

// ---------------------------------------------------------------------------
// PMREM environment（§6.6 环境反射；§10.3 卸载释放 texture）
// ---------------------------------------------------------------------------

function SceneEnvironment(): null {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)

  useEffect(() => {
    const resource = createEnvironmentResource()
    scene.environment = resource.setup(gl)
    return () => {
      scene.environment = null
      resource.dispose()
    }
  }, [gl, scene])

  return null
}

// ---------------------------------------------------------------------------
// §6.6 灯光：平行光（太阳，4096 阴影）+ 半球光
// ---------------------------------------------------------------------------

interface FactoryLightingProps {
  readonly bounds: FactoryBoundsDto
}

function FactoryLighting({ bounds }: FactoryLightingProps): ReactElement {
  // shadow camera 视锥与灯光位置由纯函数按厂房三维 bounds 推导（§6.6）
  const shadowSetup = useMemo(() => fitDirectionalShadowCamera(bounds), [bounds])
  // 平行光 target 必须挂进 scene 才会更新矩阵
  const lightTarget = useMemo(() => new Object3D(), [])
  const lightRef = useRef<DirectionalLight>(null)

  useLayoutEffect(() => {
    const light = lightRef.current
    if (light === null) return
    light.position.set(
      shadowSetup.lightPosition[0],
      shadowSetup.lightPosition[1],
      shadowSetup.lightPosition[2],
    )
    const shadowCamera = light.shadow.camera
    shadowCamera.left = shadowSetup.camera.left
    shadowCamera.right = shadowSetup.camera.right
    shadowCamera.top = shadowSetup.camera.top
    shadowCamera.bottom = shadowSetup.camera.bottom
    shadowCamera.near = shadowSetup.camera.near
    shadowCamera.far = shadowSetup.camera.far
    shadowCamera.updateProjectionMatrix()
  }, [shadowSetup])

  return (
    <>
      <directionalLight
        ref={lightRef}
        color={SUN_LIGHT_COLOR}
        intensity={SUN_LIGHT_INTENSITY}
        target={lightTarget}
        castShadow
        shadow-mapSize={[SHADOW_MAP_SIZE, SHADOW_MAP_SIZE]}
        shadow-bias={SHADOW_BIAS}
        shadow-normalBias={SHADOW_NORMAL_BIAS}
      />
      <primitive object={lightTarget} position={shadowSetup.lightTarget} />
      <hemisphereLight
        color={HEMISPHERE_SKY_COLOR}
        groundColor={HEMISPHERE_GROUND_COLOR}
        intensity={HEMISPHERE_LIGHT_INTENSITY}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// FactoryCanvas
// ---------------------------------------------------------------------------

export function FactoryCanvas({
  bounds,
  onWebGLUnavailable,
  children,
}: FactoryCanvasProps): ReactElement {
  // 渲染器只创建一次；经 ref 始终回调页面最新的错误处理器
  const unavailableRef = useRef(onWebGLUnavailable)
  useEffect(() => {
    unavailableRef.current = onWebGLUnavailable
  }, [onWebGLUnavailable])
  const reportUnavailable = useCallback((error: WebGLUnavailableError): void => {
    unavailableRef.current(error)
  }, [])
  const glFactory = useCallback(
    (parameters: WebGLRendererParameters): WebGLRenderer =>
      createWebGLRenderer(parameters, reportUnavailable),
    [reportUnavailable],
  )

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Canvas
        frameloop="demand"
        shadows
        camera={{ fov: CAMERA_FOV, near: CAMERA_NEAR, far: CAMERA_FAR }}
        gl={glFactory}
      >
        <RendererQuality />
        <ContextLostGuard reportUnavailable={reportUnavailable} />
        <SceneEnvironment />
        <FactoryLighting bounds={bounds} />
        {children}
      </Canvas>
    </div>
  )
}
