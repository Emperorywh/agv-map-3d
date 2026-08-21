import { useEffect, useRef } from 'react'
import type { ComponentRef } from 'react'
import { Vector3 } from 'three'
import { OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'

import {
  CAMERA_DISTANCE_MAX,
  CAMERA_DISTANCE_MIN,
  CAMERA_FAR,
  CAMERA_FOLLOW_TARGET_LIFT,
  CAMERA_FOV_DEG,
  CAMERA_INITIAL_POSITION,
  CAMERA_NEAR,
  CAMERA_ORBIT_RETURN_POLAR_RAD,
  CAMERA_ORTHO_HEIGHT,
  CAMERA_ORTHO_VIEW_WIDTH_MAX,
  CAMERA_ORTHO_VIEW_WIDTH_MIN,
  CAMERA_POLAR_MAX_RAD,
  CAMERA_POLAR_MIN_RAD,
  CAMERA_TOPDOWN_POLAR_RAD,
  CAMERA_TRANSITION_SECONDS,
} from '../config/constants'
import {
  buildCameraTransition,
  cameraPositionFromPose,
  clonePose,
  easeInOutCubic,
  poseFromCameraPosition,
  sampleTransitionPose,
} from '../rendering/scene/cameraTransitions'
import type { CameraPose } from '../rendering/scene/cameraTransitions'
import { agvRuntime } from '../state/agvRuntime'
import { useAppStore } from '../state/appStore'

/**
 * 相机装置（SPEC §8.1）：自由 Orbit（默认）/ 正交俯视 / AGV 跟随三模式，
 * 模式与跟随目标全部自 zustand store 读取（场景行为完全由 store 驱动），
 * 切换带约 0.5s 位置 / 目标点插值平滑过渡（球面参数插值 + 方位角最短路径，无跳变）。
 *
 * - 自由 Orbit：极角 5°~85°（防穿地 / 防翻转）、距离 5~400m、阻尼开启；
 * - 正交俯视：OrthographicCamera 顶视（极角 ≈0、方位角 0，屏幕右 = 世界 +X、
 *   屏幕上 = 世界 -Z 的 2D 地图视角），旋转锁定、支持平移缩放（zoom 按视野宽度限值）；
 * - AGV 跟随：关注点每帧直读模拟瞬时值（state/agvRuntime 通道，不经 React 状态），
 *   相机与关注点同步平移保留用户环绕 / 缩放位姿；Esc 或切模式退出；
 * - 过渡期间锁定 controls 输入（防约束钳制与插值打架），结束后恢复分模式约束；
 * - 过渡数学全部收敛于 rendering/scene/cameraTransitions.ts 纯函数（可单测）；
 *   相机位置与 OrbitControls target 即遮挡淡出（TASK-012）的消费点。
 *
 * 临时触发手段（TASK-014 顶部栏按钮接线后移除）：按键 1 = 自由 Orbit、
 * 2 = 正交俯视、3 = 跟随下一台 AGV（循环）；Esc = 退出跟随。
 */

/** OrbitControls 实现实例类型（three-stdlib，经 drei 组件 ref 推断，免直接依赖传递包） */
type OrbitControlsImpl = ComponentRef<typeof OrbitControls>

/** 目的地解算的静态参数（全部自 config/constants.ts 注入） */
const CAMERA_TRANSITION_STATIC_PARAMS = {
  fovDeg: CAMERA_FOV_DEG,
  orthoHeight: CAMERA_ORTHO_HEIGHT,
  topdownPolarRad: CAMERA_TOPDOWN_POLAR_RAD,
  orthoViewWidthMin: CAMERA_ORTHO_VIEW_WIDTH_MIN,
  orthoViewWidthMax: CAMERA_ORTHO_VIEW_WIDTH_MAX,
  orbitReturnPolarRad: CAMERA_ORBIT_RETURN_POLAR_RAD,
  distanceMin: CAMERA_DISTANCE_MIN,
  distanceMax: CAMERA_DISTANCE_MAX,
}

/**
 * 正交相机挂载初始机位（模块级稳定引用：数组字面量若内联，窗口 resize 触发重渲染时
 * 会被 R3F 当作 prop 变更重刷相机位置造成跳变；首帧姿态实际由 useFrame 过渡写入）
 */
const ORTHO_CAMERA_INITIAL_POSITION: [number, number, number] = [0, CAMERA_ORTHO_HEIGHT, 0]

/** 跟随目标关注点世界坐标（模拟瞬时值 + 车体中心抬升）；未找到返回 null */
function resolveFollowWorldPosition(id: number, out: Vector3): Vector3 | null {
  const snapshots = agvRuntime.snapshots
  if (snapshots === null) {
    return null
  }
  for (const snapshot of snapshots) {
    if (snapshot.id === id) {
      return out.set(
        snapshot.position.x,
        snapshot.position.y + CAMERA_FOLLOW_TARGET_LIFT,
        snapshot.position.z,
      )
    }
  }
  return null
}

export function CameraRig() {
  const cameraMode = useAppStore((state) => state.cameraMode)
  const followTargetId = useAppStore((state) => state.followTargetId)
  const size = useThree((state) => state.size)
  const isTopdown = cameraMode === 'topdown'

  const controlsRef = useRef<OrbitControlsImpl | null>(null)

  // 每帧跟踪的当前姿态（含用户操作结果），模式切换的过渡起点；
  // 初始关注点为世界原点（地图经校准居中，SPEC §4.3）
  const poseRef = useRef<CameraPose>(
    poseFromCameraPosition(
      new Vector3(...CAMERA_INITIAL_POSITION),
      new Vector3(0, 0, 0),
      1,
      { target: new Vector3(), radius: 0, polar: 0, azimuth: 0, zoom: 1 },
    ),
  )
  /** 进入俯视前的方位角记忆（切回透视时恢复环绕朝向；俯视下方位角退化不跟踪） */
  const azimuthMemoryRef = useRef(poseRef.current.azimuth)
  /** 进行中的过渡（球面插值纯函数构建；follow 目的地每帧重解析） */
  const transitionRef = useRef<{
    from: CameraPose
    resolveTo: (out: CameraPose) => void
    elapsed: number
  } | null>(null)
  /** 已应用到场景的模式 / 跟随目标（与 store 比对以启动过渡） */
  const appliedRef = useRef({ mode: cameraMode, followTargetId })
  /** 过渡采样 scratch（每帧 in-place，零分配） */
  const destScratchRef = useRef<CameraPose>(clonePose(poseRef.current))
  const sampleScratchRef = useRef<CameraPose>(clonePose(poseRef.current))
  const followScratchRef = useRef(new Vector3())
  const followDeltaRef = useRef(new Vector3())

  // 临时触发手段（SPEC §8.1；TASK-014 顶部栏按钮接线后移除）+ Esc 退出跟随
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = useAppStore.getState()
      if (event.key === 'Escape') {
        if (state.cameraMode === 'follow') {
          state.setCameraMode('orbit')
        }
        return
      }
      if (event.key === '1') {
        state.setCameraMode('orbit')
      } else if (event.key === '2') {
        state.setCameraMode('topdown')
      } else if (event.key === '3') {
        const snapshots = agvRuntime.snapshots
        if (snapshots !== null && snapshots.length > 0) {
          const currentIndex = snapshots.findIndex(
            (snapshot) => snapshot.id === state.followTargetId,
          )
          const next = snapshots[(currentIndex + 1) % snapshots.length]
          state.setFollowTarget(next.id)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useFrame(({ camera }, delta) => {
    const controls = controlsRef.current
    if (controls === null) {
      return
    }

    // 1) store 变化 → 启动 ~0.5s 过渡；过渡期间锁定输入（防约束钳制与插值打架）
    const applied = appliedRef.current
    if (applied.mode !== cameraMode || applied.followTargetId !== followTargetId) {
      const targetId = followTargetId
      transitionRef.current = {
        ...buildCameraTransition(cameraMode, applied.mode, poseRef.current, {
          ...CAMERA_TRANSITION_STATIC_PARAMS,
          aspect: size.width / size.height,
          viewportWidthPx: size.width,
          azimuthMemory: azimuthMemoryRef.current,
          resolveFollowTarget: () =>
            targetId === null ? null : resolveFollowWorldPosition(targetId, followScratchRef.current),
        }),
        elapsed: 0,
      }
      appliedRef.current = { mode: cameraMode, followTargetId }
      controls.enabled = false
    }

    // 2) 过渡推进 / 跟随步进（drei OrbitControls 以优先级 -1 先行 update，本回调随后修正）
    const transition = transitionRef.current
    if (transition !== null) {
      transition.elapsed += delta
      const t = Math.min(1, transition.elapsed / CAMERA_TRANSITION_SECONDS)
      const to = destScratchRef.current
      transition.resolveTo(to)
      const sampled = sampleTransitionPose(
        transition.from,
        to,
        easeInOutCubic(t),
        sampleScratchRef.current,
      )
      cameraPositionFromPose(sampled, camera.position)
      controls.target.copy(sampled.target)
      if (camera.zoom !== sampled.zoom) {
        camera.zoom = sampled.zoom
        camera.updateProjectionMatrix()
      }
      // 过渡期间 controls 禁用（drei 跳过 update），相机定向由本装置负责（up 恒为 +Y）
      camera.lookAt(controls.target)
      if (t >= 1) {
        transitionRef.current = null
        controls.enabled = true
      }
    } else if (cameraMode === 'follow' && followTargetId !== null) {
      // 关注点贴目标当前位置、相机同步平移：保留用户环绕 / 缩放形成的相对位姿
      const target = resolveFollowWorldPosition(followTargetId, followScratchRef.current)
      if (target !== null) {
        const deltaMove = followDeltaRef.current.subVectors(target, controls.target)
        camera.position.add(deltaMove)
        controls.target.copy(target)
      }
    }

    // 3) 跟踪当前姿态（下一次过渡的起点；俯视的方位角退化，不覆盖记忆）
    poseFromCameraPosition(camera.position, controls.target, camera.zoom, poseRef.current)
    if (appliedRef.current.mode !== 'topdown') {
      azimuthMemoryRef.current = poseRef.current.azimuth
    }
  })

  return (
    <>
      {/* 双相机按模式切换 makeDefault；首帧姿态由 useFrame 在渲染前写入，无可见跳变 */}
      {isTopdown ? (
        <OrthographicCamera
          makeDefault
          near={CAMERA_NEAR}
          far={CAMERA_FAR}
          position={ORTHO_CAMERA_INITIAL_POSITION}
        />
      ) : (
        <PerspectiveCamera
          makeDefault
          fov={CAMERA_FOV_DEG}
          near={CAMERA_NEAR}
          far={CAMERA_FAR}
          position={CAMERA_INITIAL_POSITION}
        />
      )}
      {/* 单 OrbitControls 随默认相机重建（drei 按 camera 换实例）；分模式约束：
          俯视锁定旋转 + 屏幕空间平移（2D 地图观感），跟随禁平移（防与跟随拉扯） */}
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableDamping
        enableRotate={!isTopdown}
        enablePan={cameraMode !== 'follow'}
        screenSpacePanning={isTopdown}
        minPolarAngle={isTopdown ? CAMERA_TOPDOWN_POLAR_RAD : CAMERA_POLAR_MIN_RAD}
        maxPolarAngle={isTopdown ? CAMERA_TOPDOWN_POLAR_RAD : CAMERA_POLAR_MAX_RAD}
        minDistance={CAMERA_DISTANCE_MIN}
        maxDistance={CAMERA_DISTANCE_MAX}
        minZoom={isTopdown ? size.width / CAMERA_ORTHO_VIEW_WIDTH_MAX : 0}
        maxZoom={isTopdown ? size.width / CAMERA_ORTHO_VIEW_WIDTH_MIN : Infinity}
      />
    </>
  )
}
