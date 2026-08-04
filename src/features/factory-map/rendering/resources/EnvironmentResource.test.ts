/**
 * EnvironmentResource 单元测试（SPEC §6.6 环境反射行、§10.3 资源所有权）。
 *
 * 经注入的 PMREMGenerator/RoomEnvironment 桩件在 node 环境验证生命周期：
 * - setup 生成一次 environment texture，幂等返回同一 texture；
 * - 生成后立即释放 generator 与临时 scene（finally，含 fromScene 抛错路径）；
 * - dispose 释放 render target（texture 随之释放）、幂等、之后可重新 setup
 *  （StrictMode 顺序 setup→dispose→setup 任一时刻仅一份 GPU 资源）；
 * - 默认工厂返回真实 PMREMGenerator/RoomEnvironment（构造不触碰 GPU，node 可运行）。
 */

import { PMREMGenerator, Scene, Texture } from 'three'
import type { WebGLRenderer, WebGLRenderTarget } from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { describe, expect, it } from 'vitest'

import {
  createEnvironmentResource,
  createPmremGenerator,
  createRoomEnvironmentScene,
} from './EnvironmentResource'
import type {
  PmremGeneratorLike,
  RoomEnvironmentLike,
} from './EnvironmentResource'

/** 桩件 render target：texture 独立持有，dispose 计数 */
function createRenderTargetRecorder(): WebGLRenderTarget & { disposeCount: number } {
  const recorder = {
    texture: new Texture(),
    disposeCount: 0,
    dispose() {
      recorder.disposeCount += 1
    },
  }
  return recorder as unknown as WebGLRenderTarget & { disposeCount: number }
}

interface EnvironmentStubs {
  readonly generator: PmremGeneratorLike
  readonly roomScene: RoomEnvironmentLike
  readonly renderTarget: WebGLRenderTarget & { disposeCount: number }
  /** 调用顺序记录：fromScene / generatorDispose / roomDispose */
  readonly calls: string[]
  createGenerator(renderer: WebGLRenderer): PmremGeneratorLike
  createRoomScene(): RoomEnvironmentLike
}

function createEnvironmentStubs(options?: { throwFromScene?: boolean }): EnvironmentStubs {
  const calls: string[] = []
  const renderTarget = createRenderTargetRecorder()
  const generator: PmremGeneratorLike = {
    fromScene: () => {
      calls.push('fromScene')
      if (options?.throwFromScene === true) throw new Error('桩件：fromScene 失败')
      return renderTarget
    },
    dispose: () => {
      calls.push('generatorDispose')
    },
  }
  const roomScene = Object.assign(new Scene(), {
    dispose: () => {
      calls.push('roomDispose')
    },
  })
  return {
    generator,
    roomScene,
    renderTarget,
    calls,
    createGenerator: () => generator,
    createRoomScene: () => roomScene,
  }
}

const stubRenderer = {} as WebGLRenderer

describe('EnvironmentResource 生命周期（§6.6、§10.3）', () => {
  it('setup 生成一次 environment texture；fromScene 以临时 room scene 为输入', () => {
    const stubs = createEnvironmentStubs()
    const resource = createEnvironmentResource(stubs)
    const texture = resource.setup(stubRenderer)
    expect(texture).toBe(stubs.renderTarget.texture)
    expect(resource.current).toBe(stubs.renderTarget.texture)
    expect(stubs.calls).toEqual(['fromScene', 'generatorDispose', 'roomDispose'])
  })

  it('生成后立即释放 generator 与临时 scene（setup 返回前已释放，texture 保留）', () => {
    const stubs = createEnvironmentStubs()
    const resource = createEnvironmentResource(stubs)
    resource.setup(stubRenderer)
    // 释放发生在 setup 返回之前（调用顺序断言见上行），且 texture 仍可用
    expect(stubs.calls).toContain('generatorDispose')
    expect(stubs.calls).toContain('roomDispose')
    expect(resource.current).toBe(stubs.renderTarget.texture)
  })

  it('setup 幂等：重复 setup 复用同一 texture，不重建 generator/临时 scene', () => {
    const stubs = createEnvironmentStubs()
    const resource = createEnvironmentResource(stubs)
    const first = resource.setup(stubRenderer)
    const second = resource.setup(stubRenderer)
    expect(second).toBe(first)
    expect(stubs.calls.filter((call) => call === 'fromScene')).toHaveLength(1)
  })

  it('dispose 释放 render target（texture 随之释放）；幂等；之后可重新 setup', () => {
    const stubs = createEnvironmentStubs()
    const resource = createEnvironmentResource(stubs)
    resource.setup(stubRenderer)

    resource.dispose()
    expect(stubs.renderTarget.disposeCount).toBe(1)
    expect(resource.current).toBeNull()

    // 幂等：第二次 dispose 不产生额外释放
    resource.dispose()
    expect(stubs.renderTarget.disposeCount).toBe(1)

    // dispose 后可重新 setup（StrictMode 重挂载语义），生成新的 render target
    const regenerated = createEnvironmentStubs()
    const regeneratedResource = createEnvironmentResource(regenerated)
    regeneratedResource.setup(stubRenderer)
    regeneratedResource.dispose()
    expect(regenerated.renderTarget.disposeCount).toBe(1)
    const texture = regeneratedResource.setup(stubRenderer)
    expect(texture).toBe(regenerated.renderTarget.texture)
    expect(regenerated.calls.filter((call) => call === 'fromScene')).toHaveLength(2)
  })

  it('fromScene 抛错：generator 与临时 scene 仍立即释放，错误上抛，不产生 texture', () => {
    const stubs = createEnvironmentStubs({ throwFromScene: true })
    const resource = createEnvironmentResource(stubs)
    expect(() => resource.setup(stubRenderer)).toThrowError(/fromScene 失败/)
    expect(stubs.calls).toEqual(['fromScene', 'generatorDispose', 'roomDispose'])
    expect(resource.current).toBeNull()
    // 失败后可重试（新的资源实例按同一契约工作）
    const retried = createEnvironmentResource(createEnvironmentStubs())
    expect(retried.setup(stubRenderer)).toBeInstanceOf(Texture)
  })
})

describe('EnvironmentResource 默认工厂（真实 PMREMGenerator / RoomEnvironment）', () => {
  it('createPmremGenerator 返回真实 PMREMGenerator（构造不触碰 GPU）', () => {
    const generator = createPmremGenerator(stubRenderer)
    expect(generator).toBeInstanceOf(PMREMGenerator)
    generator.dispose()
  })

  it('createRoomEnvironmentScene 返回可整体释放的 Scene（§10.3）', () => {
    const roomScene = createRoomEnvironmentScene()
    expect(roomScene).toBeInstanceOf(RoomEnvironment)
    expect(roomScene).toBeInstanceOf(Scene)
    expect(() => {
      roomScene.dispose()
    }).not.toThrow()
  })

  it('未注入 createRoomScene 时使用真实 RoomEnvironment 作为 fromScene 输入', () => {
    const stubs = createEnvironmentStubs()
    let fromSceneInput: Scene | null = null
    const resource = createEnvironmentResource({
      createGenerator: () => ({
        fromScene: (scene: Scene) => {
          fromSceneInput = scene
          return stubs.renderTarget
        },
        dispose: () => undefined,
      }),
    })
    const texture = resource.setup(stubRenderer)
    expect(texture).toBe(stubs.renderTarget.texture)
    expect(fromSceneInput).toBeInstanceOf(RoomEnvironment)
    // 真实 RoomEnvironment 在 finally 中整体释放（node 安全，无异常即契约满足）
  })

  it('未注入 createGenerator 时使用真实 PMREMGenerator；node 无 GPU 时 fromScene 失败仍 finally 释放临时 scene', () => {
    const stubs = createEnvironmentStubs()
    const resource = createEnvironmentResource({ createRoomScene: stubs.createRoomScene })
    expect(() => resource.setup(stubRenderer)).toThrow()
    expect(stubs.calls).toContain('roomDispose')
    expect(resource.current).toBeNull()
  })
})
