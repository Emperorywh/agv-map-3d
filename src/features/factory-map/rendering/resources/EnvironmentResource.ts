/**
 * EnvironmentResource：PMREM environment texture 唯一 owner
 *（SPEC §6.6 环境反射行、§10.3 资源所有权）。
 *
 * - PMREMGenerator + three/addons/environments/RoomEnvironment.js 生成一次
 *   environment texture；同一次挂载内 setup 幂等返回同一 texture；
 * - 生成后立即释放 generator 与临时 scene（无论成败，finally 释放）；
 *   texture 由 render target 承载，Canvas 卸载时经 dispose() 释放
 *  （renderTarget.dispose() 同时释放其 texture）；
 * - dispose 幂等，之后可重新 setup（React StrictMode 重复挂载安全——
 *   顺序的 setup→dispose→setup 任一时刻只有一份 GPU 资源）。
 *
 * 材质级 envMapIntensity（其余 0.5 / 窗玻璃 0.6，§6.6/§13.3）已在
 * FactorySceneResources 的材质上固定（TASK-008），scene.environment 对全部
 * MeshStandardMaterial 生效；本模块只负责 texture 生命周期。
 *
 * 真实 PMREMGenerator 需要 WebGL2 上下文；测试经 options 注入桩件脱离 GPU。
 */

import { PMREMGenerator } from 'three'
import type { Scene, Texture, WebGLRenderer, WebGLRenderTarget } from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

/** PMREMGenerator 注入面（node 测试以桩件替身脱离 WebGL） */
export interface PmremGeneratorLike {
  fromScene(scene: Scene): WebGLRenderTarget
  dispose(): void
}

/** RoomEnvironment 临时 scene 注入面（§10.3：生成后必须可整体释放） */
export interface RoomEnvironmentLike extends Scene {
  dispose(): void
}

/** 默认工厂：真实 PMREMGenerator（仅持有 renderer 引用，fromScene 才触碰 GPU） */
export function createPmremGenerator(renderer: WebGLRenderer): PmremGeneratorLike {
  return new PMREMGenerator(renderer)
}

/** 默认工厂：真实 RoomEnvironment 临时 scene */
export function createRoomEnvironmentScene(): RoomEnvironmentLike {
  return new RoomEnvironment()
}

export interface EnvironmentResourceOptions {
  readonly createGenerator?: (renderer: WebGLRenderer) => PmremGeneratorLike
  readonly createRoomScene?: () => RoomEnvironmentLike
}

export interface EnvironmentResource {
  /** 生成（首次）或复用 environment texture；幂等返回同一 texture */
  setup(renderer: WebGLRenderer): Texture
  /** 释放 environment texture（render target）；幂等；之后可重新 setup */
  dispose(): void
  /** 当前 environment texture（未 setup 或已 dispose 时为 null） */
  readonly current: Texture | null
}

/** 创建 environment texture 资源 owner（§10.3：setup/cleanup 幂等） */
export function createEnvironmentResource(
  options: EnvironmentResourceOptions = {},
): EnvironmentResource {
  const createGenerator = options.createGenerator ?? createPmremGenerator
  const createRoomScene = options.createRoomScene ?? createRoomEnvironmentScene

  let renderTarget: WebGLRenderTarget | null = null

  return {
    setup(renderer: WebGLRenderer): Texture {
      if (renderTarget !== null) return renderTarget.texture
      const generator = createGenerator(renderer)
      const roomScene = createRoomScene()
      try {
        renderTarget = generator.fromScene(roomScene)
      } finally {
        // §10.3：生成后立即释放 generator 与临时 scene（无论成败）
        generator.dispose()
        roomScene.dispose()
      }
      return renderTarget.texture
    },

    dispose(): void {
      if (renderTarget === null) return
      renderTarget.dispose()
      renderTarget = null
    },

    get current(): Texture | null {
      return renderTarget === null ? null : renderTarget.texture
    },
  }
}
