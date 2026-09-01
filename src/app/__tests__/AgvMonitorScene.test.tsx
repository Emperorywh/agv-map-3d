/*
 * AgvMonitorScene 场景组合测试（与实现共置）。
 *
 * 职责：用 @react-three/test-renderer 在不依赖真实 WebGL 的前提下，
 * 校验 Canvas 内唯一组合根的场景图内容。
 * 关键不变量（TASK-001 / F4）：
 * 1. StrictMode 双调用（setup→cleanup→setup）下只出现一个 agv-monitor-scene 锚点；
 * 2. 同一渲染器内更新（等价重新挂载子树）不产生重复或残留锚点；
 * 3. TASK-001 阶段除锚点外不得存在任何业务 3D 对象。
 * 注意：test-renderer 的容器在 unmount 后即失效，因此完整生命周期断言
 * （创建→更新→卸载）必须在单个用例内完成。
 */
import { StrictMode } from 'react'
import { describe, expect, it } from 'vitest'
import ReactThreeTestRenderer from '@react-three/test-renderer'
import { AgvMonitorScene } from '@/app/scene/AgvMonitorScene'

const ANCHOR_NAME = 'agv-monitor-scene'

describe('AgvMonitorScene 场景组合根', () => {
  it('StrictMode 下唯一锚点，更新不残留，且无业务 3D 对象', async () => {
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <AgvMonitorScene />
      </StrictMode>,
    )

    // StrictMode 双挂载后仍然只有一个组合锚点
    expect(renderer.scene.findAllByProps({ name: ANCHOR_NAME })).toHaveLength(1)
    // 根之外只允许存在锚点本身；任何额外实例都是越前的业务对象
    expect(renderer.scene.findAll(() => true)).toHaveLength(1)

    // 重新挂载同一子树（update 替换整个场景内容）后不残留旧子树
    await renderer.update(
      <StrictMode>
        <AgvMonitorScene />
      </StrictMode>,
    )
    expect(renderer.scene.findAllByProps({ name: ANCHOR_NAME })).toHaveLength(1)
    expect(renderer.scene.findAll(() => true)).toHaveLength(1)

    renderer.unmount()
  })
})
