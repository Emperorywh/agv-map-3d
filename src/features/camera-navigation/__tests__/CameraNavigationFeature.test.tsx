/*
 * 相机导航 Feature 集成测试（TASK-013 / SPEC §5.5、§8、§12.5）。
 *
 * 职责：以 @react-three/test-renderer 验证相机 Feature 的完整交互语义——
 *       bounds 到位自动取景与距离限制、双击跟随（命令入口、逐帧对齐只读目
 *       标、重定向保留偏移）、目标删除/拖拽退出、空格俯瞰、跟随期间滚轮缩
 *       放偏移、单击不退出跟随、命令出口与监听器的对称清理及 StrictMode 重
 *       挂载安全。
 * 边界：跟随目标以注入桩提供（不依赖 fleet-monitoring 实现）；真实浏览器
 *       交互序列由本 Task 的浏览器自测覆盖。
 */
import { StrictMode } from 'react'
import { act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ReactThreeTestRenderer from '@react-three/test-renderer'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { SceneBounds } from '@/features/map-visualization'
import type { FollowTargetReader } from '@/features/fleet-monitoring'
import { CameraNavigationFeature } from '../components/CameraNavigationFeature'
import type { CameraNavigationCommands } from '../hooks/useCameraNavigation'
import { useCameraNavigationStore } from '../model/cameraNavigationStore'
import { computeOverviewPose } from '../model/overviewFraming'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const BOUNDS_A: SceneBounds = {
  minWorldX: 0,
  maxWorldX: 100,
  minWorldZ: 0,
  maxWorldZ: 50,
  centerWorldX: 50,
  centerWorldZ: 25,
  diagonal: Math.hypot(100, 50),
}

type TestRenderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>
type ControlsRef = { current: OrbitControls | null }
type CommandsRef = { current: CameraNavigationCommands | null }

interface Captured {
  camera: THREE.PerspectiveCamera
  dom: HTMLCanvasElement
}

/** 场景探针：捕获默认相机与画布元素（事件派发目标） */
function makeProbe(capture: { current: Captured | null }) {
  return function SceneProbe() {
    const camera = useThree((state) => state.camera)
    const gl = useThree((state) => state.gl)
    capture.current = {
      camera: camera as THREE.PerspectiveCamera,
      dom: gl.domElement as HTMLCanvasElement,
    }
    return null
  }
}

interface MountOptions {
  bounds: SceneBounds | null
  readFollowTarget: FollowTargetReader | null
  commands: CommandsRef
  controls: ControlsRef
}

async function mount(
  options: Partial<MountOptions> = {},
): Promise<{ renderer: TestRenderer; capture: { current: Captured | null } }> {
  const capture: { current: Captured | null } = { current: null }
  const SceneProbe = makeProbe(capture)
  const renderer = await ReactThreeTestRenderer.create(
    <>
      <CameraNavigationFeature
        bounds={options.bounds ?? BOUNDS_A}
        readFollowTarget={options.readFollowTarget ?? null}
        commandsRef={options.commands ?? { current: null }}
        controlsRef={options.controls ?? { current: null }}
      />
      <SceneProbe />
    </>,
  )
  return { renderer, capture }
}

async function advance(renderer: TestRenderer, frames = 1): Promise<void> {
  await act(async () => {
    renderer.advanceFrames(frames, 1 / 60)
  })
}

/** test-renderer 的 unmount 不主动冲刷 effect 清理：外部 act 包裹保证对称执行 */
async function unmountSync(renderer: TestRenderer): Promise<void> {
  await act(async () => {
    renderer.unmount()
  })
  await act(async () => {})
}

function pointer(type: string, x: number, y: number): MouseEvent {
  return new MouseEvent(type, { clientX: x, clientY: y, bubbles: true })
}

beforeEach(() => {
  useCameraNavigationStore.getState().setFollowedEntityKey(null)
})

describe('CameraNavigationFeature 相机导航', () => {
  it('bounds 到位即自动取景：45° 机位、距离限制与阻尼同时生效', async () => {
    const commands: CommandsRef = { current: null }
    const controls: ControlsRef = { current: null }
    const { renderer, capture } = await mount({ commands, controls })

    expect(capture.current).not.toBeNull()
    // aspect=1：jsdom 画布无布局尺寸，Hook 内退化为方视口（与实现同口径）
    const pose = computeOverviewPose(BOUNDS_A, capture.current!.camera.fov, 1)
    const camera = capture.current!.camera
    expect(camera.position.x).toBeCloseTo(pose.position.x, 4)
    expect(camera.position.y).toBeCloseTo(pose.position.y, 4)
    expect(camera.position.z).toBeCloseTo(pose.position.z, 4)
    expect(controls.current).not.toBeNull()
    expect(controls.current!.enableDamping).toBe(true)
    expect(controls.current!.minDistance).toBe(2)
    expect(controls.current!.maxDistance).toBeCloseTo(BOUNDS_A.diagonal * 3, 4)
    expect(commands.current).not.toBeNull()
    renderer.unmount()
  })

  it('跟随命令逐帧对齐只读目标；目标键写入低频 store', async () => {
    const target = { x: 60, z: 30 }
    const reader: FollowTargetReader = (key) => (key === 'k1' ? target : null)
    const commands: CommandsRef = { current: null }
    const { renderer, capture } = await mount({ readFollowTarget: reader, commands })
    await advance(renderer, 1)

    // 进入跟随：偏移 = 取景机位 − 注视中心（BOUNDS_A 中心）
    commands.current!.follow('k1')
    expect(useCameraNavigationStore.getState().followedEntityKey).toBe('k1')
    const camera = capture.current!.camera
    const offset = camera.position.clone().sub(new THREE.Vector3(50, 0, 25))

    // 目标移动后下一帧相机保持相对偏移对齐
    target.x = 80
    target.z = 40
    await advance(renderer, 1)
    expect(camera.position.x).toBeCloseTo(80 + offset.x, 3)
    expect(camera.position.z).toBeCloseTo(40 + offset.z, 3)
    expect(camera.position.y).toBeCloseTo(offset.y, 5)
    renderer.unmount()
  })

  it('目标删除（读取器返回 null）当帧退出跟随并恢复缩放', async () => {
    const reader: FollowTargetReader = (key) => (key === 'k1' ? { x: 60, z: 30 } : null)
    const commands: CommandsRef = { current: null }
    const controls: ControlsRef = { current: null }
    const { renderer } = await mount({ readFollowTarget: reader, commands, controls })
    await advance(renderer, 1)

    commands.current!.follow('k1')
    expect(controls.current!.enableZoom).toBe(false)
    await advance(renderer, 1)
    expect(commands.current!.isFollowing()).toBe(true)

    // 目标消失：读取器改为恒 null → 当帧退出
    const exitingReader: FollowTargetReader = () => null
    await renderer.update(
      <CameraNavigationFeature
        bounds={BOUNDS_A}
        readFollowTarget={exitingReader}
        commandsRef={commands}
        controlsRef={controls}
      />,
    )
    await advance(renderer, 1)
    expect(commands.current!.isFollowing()).toBe(false)
    expect(useCameraNavigationStore.getState().followedEntityKey).toBeNull()
    expect(controls.current!.enableZoom).toBe(true)
    renderer.unmount()
  })

  it('拖拽（位移超阈值）立即退出跟随；单击不退出', async () => {
    const reader: FollowTargetReader = () => ({ x: 60, z: 30 })
    const commands: CommandsRef = { current: null }
    const { renderer, capture } = await mount({ readFollowTarget: reader, commands })
    await advance(renderer, 1)

    commands.current!.follow('k1')
    await advance(renderer, 1)
    expect(commands.current!.isFollowing()).toBe(true)

    const dom = capture.current!.dom
    // 单击（按下抬起，无位移）：不退出跟随
    act(() => {
      dom.dispatchEvent(pointer('pointerdown', 100, 100))
      dom.dispatchEvent(pointer('pointerup', 100, 100))
    })
    expect(commands.current!.isFollowing()).toBe(true)

    // 拖拽：按下后位移超过 6px → 立即退出
    act(() => {
      dom.dispatchEvent(pointer('pointerdown', 100, 100))
      dom.dispatchEvent(pointer('pointermove', 130, 100))
    })
    expect(commands.current!.isFollowing()).toBe(false)
    expect(useCameraNavigationStore.getState().followedEntityKey).toBeNull()
    renderer.unmount()
  })

  it('空格键退出跟随并回到地图中心俯瞰机位', async () => {
    const reader: FollowTargetReader = () => ({ x: 60, z: 30 })
    const commands: CommandsRef = { current: null }
    const { renderer, capture } = await mount({ readFollowTarget: reader, commands })
    await advance(renderer, 1)
    const overviewX = capture.current!.camera.position.x
    const overviewY = capture.current!.camera.position.y

    commands.current!.follow('k1')
    await advance(renderer, 1)
    expect(capture.current!.camera.position.x).not.toBeCloseTo(overviewX, 3)

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', code: 'Space' }),
      )
    })
    expect(commands.current!.isFollowing()).toBe(false)
    expect(capture.current!.camera.position.x).toBeCloseTo(overviewX, 4)
    expect(capture.current!.camera.position.y).toBeCloseTo(overviewY, 4)
    renderer.unmount()
  })

  it('跟随期间滚轮缩放相对偏移且不退出跟随', async () => {
    const reader: FollowTargetReader = () => ({ x: 60, z: 30 })
    const commands: CommandsRef = { current: null }
    const { renderer, capture } = await mount({ readFollowTarget: reader, commands })
    await advance(renderer, 1)

    commands.current!.follow('k1')
    await advance(renderer, 1)
    const camera = capture.current!.camera
    const targetPoint = new THREE.Vector3(60, 0, 30)
    const before = camera.position.distanceTo(targetPoint)

    act(() => {
      capture.current!.dom.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, cancelable: true }),
      )
    })
    await advance(renderer, 1)
    expect(commands.current!.isFollowing()).toBe(true)
    const after = camera.position.distanceTo(targetPoint)
    expect(after).toBeCloseTo(before / 0.95, 2)
    renderer.unmount()
  })

  it('跟随中切换目标：保留原相对偏移（不重新捕获）', async () => {
    const targets: Record<string, { x: number; z: number }> = {
      k1: { x: 60, z: 30 },
      k2: { x: 20, z: 10 },
    }
    const reader: FollowTargetReader = (key) => targets[key] ?? null
    const commands: CommandsRef = { current: null }
    const { renderer, capture } = await mount({ readFollowTarget: reader, commands })
    await advance(renderer, 1)

    // 以取景机位为基准记录偏移（进入 k1 时捕获）
    const camera = capture.current!.camera
    const offset = camera.position.clone().sub(new THREE.Vector3(50, 0, 25))

    commands.current!.follow('k1')
    await advance(renderer, 1)
    commands.current!.follow('k2')
    await advance(renderer, 1)

    expect(camera.position.x).toBeCloseTo(20 + offset.x, 3)
    expect(camera.position.z).toBeCloseTo(10 + offset.z, 3)
    expect(camera.position.y).toBeCloseTo(offset.y, 5)
    expect(useCameraNavigationStore.getState().followedEntityKey).toBe('k2')
    renderer.unmount()
  })

  it('卸载对称清理：命令出口与 controls 引用清空，监听不再生效', async () => {
    const reader: FollowTargetReader = () => ({ x: 60, z: 30 })
    const commands: CommandsRef = { current: null }
    const controls: ControlsRef = { current: null }
    const { renderer, capture } = await mount({ readFollowTarget: reader, commands, controls })
    await advance(renderer, 1)
    commands.current!.follow('k1')
    await advance(renderer, 1)

    await unmountSync(renderer)
    expect(commands.current).toBeNull()
    expect(controls.current).toBeNull()

    // 卸载后派发事件：无监听器，不应抛出；store 保留最后低频值不被改写
    expect(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', code: 'Space' }),
      )
      capture.current!.dom.dispatchEvent(pointer('pointerdown', 0, 0))
    }).not.toThrow()
    expect(useCameraNavigationStore.getState().followedEntityKey).toBe('k1')
    useCameraNavigationStore.getState().setFollowedEntityKey(null)
  })

  it('StrictMode 重复挂载：controls 单实例、命令可用、无重复监听副作用', async () => {
    const reader: FollowTargetReader = () => ({ x: 60, z: 30 })
    const commands: CommandsRef = { current: null }
    const controls: ControlsRef = { current: null }
    const capture: { current: Captured | null } = { current: null }
    const SceneProbe = makeProbe(capture)
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <CameraNavigationFeature
          bounds={BOUNDS_A}
          readFollowTarget={reader}
          commandsRef={commands}
          controlsRef={controls}
        />
        <SceneProbe />
      </StrictMode>,
    )
    await advance(renderer, 1)

    expect(controls.current).not.toBeNull()
    expect(controls.current!.enableDamping).toBe(true)
    commands.current!.follow('k1')
    await advance(renderer, 1)
    expect(commands.current!.isFollowing()).toBe(true)

    // 拖拽仍只触发一次退出（监听未重复注册的间接证明）
    act(() => {
      capture.current!.dom.dispatchEvent(pointer('pointerdown', 0, 0))
      capture.current!.dom.dispatchEvent(pointer('pointermove', 50, 0))
    })
    expect(commands.current!.isFollowing()).toBe(false)
    renderer.unmount()
  })

  it('bounds 变化：距离限制与机位随新包围盒重设', async () => {
    const commands: CommandsRef = { current: null }
    const controls: ControlsRef = { current: null }
    const { renderer, capture } = await mount({ commands, controls })
    const boundsB: SceneBounds = {
      ...BOUNDS_A,
      diagonal: BOUNDS_A.diagonal * 2,
    }
    await renderer.update(
      <CameraNavigationFeature
        bounds={boundsB}
        readFollowTarget={null}
        commandsRef={commands}
        controlsRef={controls}
      />,
    )
    expect(controls.current!.maxDistance).toBeCloseTo(boundsB.diagonal * 3, 4)
    const pose = computeOverviewPose(boundsB, capture.current!.camera.fov, 1)
    expect(capture.current!.camera.position.y).toBeCloseTo(pose.position.y, 4)
    renderer.unmount()
  })
})

/* ==== 相机交互能力就绪信号（TASK-017，SPEC §10.3 阶段 6） ==== */

describe('CameraNavigationFeature 启动阶段接线（TASK-017）', () => {
  it('挂载提交后 onReady 触发恰好一次；StrictMode 双执行不重复；命令出口同提交可用', async () => {
    const onReady = vi.fn()
    const commands: CommandsRef = { current: null }
    const controls: ControlsRef = { current: null }
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <CameraNavigationFeature
          bounds={BOUNDS_A}
          readFollowTarget={null}
          commandsRef={commands}
          controlsRef={controls}
          onReady={onReady}
        />
      </StrictMode>,
    )
    await act(async () => {})
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(commands.current).not.toBeNull()
    renderer.unmount()
  })
})
