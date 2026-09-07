/**
 * 场景环境贴图工厂（SPEC §5.4：PMREM 环境光；TASK-004；P2-5 自定义渐变环境）。
 *
 * 职责：用中性室内渐变和顶部条形柔光经 PMREMGenerator
 *       预滤波生成 IBL 环境贴图，供场景 environment 使用；并明确拥有并释放
 *       该过程创建的全部 GPU 资源（PMREM 生成器、临时渲染目标、渐变球的
 *       几何与材质）。顶部柔光提供可辨的宽高光，低强度背景维持物体暗部。
 *       这里提供环境照明，实际墙体与车辆的倒影由地坪反射单独采集。
 * 边界：本模块只负责「生成与释放」这一对生命周期；不把 environment 挂到
 *       场景上（挂载与降级由 MapVisualizationFeature 的灯光组件负责），
 *       也不做 WebGL 上下文丢失恢复（归 TASK-016）。
 * 关键不变量：
 * 1. 创建者释放：返回句柄的 dispose() 必须释放 render target 与 PMREM 生成器，
 *       渐变球自身的几何/材质在采样完成后立即释放，不留悬挂 GPU 资源；
 * 2. 工厂签名是可注入边界：测试环境没有真实 WebGL 上下文，由调用方注入
 *       替身工厂；默认实现仅在真实渲染器上可用。
 */
import * as THREE from 'three'
import {
  ENVIRONMENT_GROUND_COLOR,
  ENVIRONMENT_HORIZON_COLOR,
  ENVIRONMENT_ZENITH_COLOR,
} from './mapAppearance'

/** 环境贴图句柄：texture 挂到 scene.environment，dispose 释放全部 GPU 资源 */
export interface SceneEnvironmentHandle {
  readonly texture: THREE.Texture
  dispose(): void
}

/** 环境工厂类型：输入真实渲染器，输出可释放的环境句柄（测试可注入替身） */
export type SceneEnvironmentFactory = (gl: THREE.WebGLRenderer) => SceneEnvironmentHandle

/** 渐变球半径（米）：只作为 PMREM 采样场景，量级不影响预滤波结果 */
const GRADIENT_SPHERE_RADIUS_M = 50

/**
 * 释放一次性采样场景，共享灯箱材质只处理一次。
 * 用对象集合去重，避免遍历多个灯箱时重复触发同一资源的释放事件。
 */
function disposeSceneGraph(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  root.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.geometry) {
      geometries.add(mesh.geometry)
    }
    const material = (mesh as unknown as { material?: THREE.Material | THREE.Material[] })
      .material
    if (Array.isArray(material)) {
      for (const item of material) {
        materials.add(item)
      }
    } else {
      if (material) materials.add(material)
    }
  })
  for (const geometry of geometries) geometry.dispose()
  for (const material of materials) material.dispose()
}

/**
 * 默认环境工厂：中性渐变球与条形柔光经 PMREM 预滤波。
 * 仅采样阶段需要真实 WebGL 上下文；失败由调用方按诊断降级处理。
 */
export const createGradientEnvironment: SceneEnvironmentFactory = (gl) => {
  const pmrem = new THREE.PMREMGenerator(gl)
  const scene = createGradientScene()
  let renderTarget: THREE.WebGLRenderTarget
  try {
    // 0.04 的模糊半径：给镜面反射一点柔和度，静态场景不需要锐利反射
    renderTarget = pmrem.fromScene(scene, 0.04)
  } catch (error) {
    /**
     * 采样失败时尚未产生可返回的句柄，必须在这里释放生成器。
     * 原始异常继续交给上层记录诊断，临时几何仍由 finally 统一清理。
     */
    pmrem.dispose()
    throw error
  } finally {
    // 渐变球只在采样阶段使用，采样后立即释放其几何与材质
    disposeSceneGraph(scene)
  }
  let disposed = false
  return {
    texture: renderTarget.texture,
    dispose() {
      // 幂等释放：重复卸载（StrictMode）不得重复释放已释放资源
      if (disposed) {
        return
      }
      disposed = true
      renderTarget.dispose()
      pmrem.dispose()
    },
  }
}

/**
 * 渐变环境场景：大球面（内表面）按顶点 y 方向插值三段色——天顶冷白、地平
 * 灰蓝、天底深灰蓝；幂曲线（^0.6）让上半球大部分保持偏亮，模拟天光。
 */
function createGradientScene(): THREE.Scene {
  const scene = new THREE.Scene()
  const geometry = new THREE.SphereGeometry(GRADIENT_SPHERE_RADIUS_M, 32, 24)
  const position = geometry.getAttribute('position')
  const colors = new Float32Array(position.count * 3)
  const zenith = new THREE.Color(ENVIRONMENT_ZENITH_COLOR)
  const horizon = new THREE.Color(ENVIRONMENT_HORIZON_COLOR)
  const ground = new THREE.Color(ENVIRONMENT_GROUND_COLOR)
  const scratch = new THREE.Color()
  for (let i = 0; i < position.count; i += 1) {
    const t = position.getY(i) / GRADIENT_SPHERE_RADIUS_M
    if (t >= 0) {
      scratch.copy(horizon).lerp(zenith, Math.pow(t, 0.6))
    } else {
      scratch.copy(horizon).lerp(ground, Math.pow(-t, 0.6))
    }
    colors[i * 3] = scratch.r
    colors[i * 3 + 1] = scratch.g
    colors[i * 3 + 2] = scratch.b
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
  })
  scene.add(new THREE.Mesh(geometry, material))
  /**
   * 环境采样场景中的条形灯箱只生成一次，不给主场景增加实时灯光或绘制。
   * 宽光源产生室内柔和高光，避免纯渐变环境缺少任何反射形状。
   */
  const lightMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.8, 2.9, 3.0), side: THREE.DoubleSide })
  for (const x of [-22, 0, 22]) {
    const softbox = new THREE.Mesh(new THREE.PlaneGeometry(9, 65), lightMaterial)
    softbox.rotation.x = Math.PI / 2
    softbox.position.set(x, 28, 0)
    scene.add(softbox)
  }
  return scene
}
