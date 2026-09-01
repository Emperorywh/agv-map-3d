/**
 * 场景环境贴图工厂（SPEC §5.4：RoomEnvironment/PMREM 环境光；TASK-004）。
 *
 * 职责：用 RoomEnvironment 场景经 PMREMGenerator 预滤波生成 IBL 环境贴图，
 *       供场景 environment 使用；并明确拥有并释放该过程创建的全部 GPU 资源
 *       （PMREM 生成器、临时渲染目标、房间场景的几何与材质）。
 * 边界：本模块只负责「生成与释放」这一对生命周期；不把 environment 挂到
 *       场景上（挂载与降级由 MapVisualizationFeature 的灯光组件负责），
 *       也不做 WebGL 上下文丢失恢复（归 TASK-016）。
 * 关键不变量：
 * 1. 创建者释放：返回句柄的 dispose() 必须释放 render target 与 PMREM 生成器，
 *       房间场景自身的几何/材质在采样完成后立即释放，不留悬挂 GPU 资源；
 * 2. 工厂签名是可注入边界：测试环境没有真实 WebGL 上下文，由调用方注入
 *       替身工厂；默认实现仅在真实渲染器上可用。
 */
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

/** 环境贴图句柄：texture 挂到 scene.environment，dispose 释放全部 GPU 资源 */
export interface SceneEnvironmentHandle {
  readonly texture: THREE.Texture
  dispose(): void
}

/** 环境工厂类型：输入真实渲染器，输出可释放的环境句柄（测试可注入替身） */
export type SceneEnvironmentFactory = (gl: THREE.WebGLRenderer) => SceneEnvironmentHandle

/** 释放一个对象图中的 geometry 与材质（房间场景等一次性采样资源） */
function disposeSceneGraph(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.geometry) {
      mesh.geometry.dispose()
    }
    const material = (mesh as unknown as { material?: THREE.Material | THREE.Material[] })
      .material
    if (Array.isArray(material)) {
      for (const item of material) {
        item.dispose()
      }
    } else {
      material?.dispose()
    }
  })
}

/**
 * 默认环境工厂：RoomEnvironment + PMREM。
 * only 采样阶段需要真实 WebGL 上下文；失败由调用方按诊断降级处理。
 */
export const createRoomEnvironment: SceneEnvironmentFactory = (gl) => {
  const pmrem = new THREE.PMREMGenerator(gl)
  const room = new RoomEnvironment()
  let renderTarget: THREE.WebGLRenderTarget
  try {
    // 0.04 的模糊半径：给镜面反射一点柔和度，工业地坪不需要锐利反射
    renderTarget = pmrem.fromScene(room, 0.04)
  } finally {
    // 房间场景只在采样阶段使用，采样后立即释放其几何与材质
    disposeSceneGraph(room)
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
