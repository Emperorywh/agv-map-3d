/**
 * CameraRig：初始机位 fit + OrbitControls 漫游（SPEC §9、§5.2、§10.1）。
 *
 * - 初始机位（§9.1）：首次 ready 与地图变更（bounds 值变化）时用 rendering/core
 *   的 fitPerspectiveCamera 纯函数设置 45° 斜视全景机位（复用 TASK-007，无二维回退）；
 *   用户尚未操作时 viewport resize 重新 fit，已操作后 resize 只更新
 *   aspect/projection、不重置机位；
 * - OrbitControls（§9.2 逐项）：enableDamping dampingFactor 0.08、
 *   minDistance 3 / maxDistance 350、minPolarAngle 5° / maxPolarAngle 80°、
 *   screenSpacePanning=false；drei 内置 change → invalidate()，阻尼未停时
 *   逐帧触发下一帧，静止后停止重绘（§5.2 frameloop='demand' 语义）；
 * - target 夹取（§9.2）：每次 change 后经 core/orbitTargetClamp 纯函数强制
 *   XZ 夹取到厂房内边界外扩 20m、Y 恒为 0；夹取使用组件级预分配 out，
 *   稳态无逐帧分配（§10.1）；
 * - 位姿通知 onCameraPoseChanged：标签候选重算钩子（§1.4/§8.3，TASK-012 接入
 *   距离/角度阈值与 10Hz 节流）；初始 fit、每次 change、viewport 尺寸变化后
 *   各触发一次；载体为组件级预分配快照对象，就地更新、引用稳定。
 */

import { OrbitControls } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { ComponentRef, ReactElement } from 'react'
import type { PerspectiveCamera } from 'three'

import type { FactoryBoundsDto } from '../../application/factorySceneModel'
import {
  ORBIT_DAMPING_FACTOR,
  ORBIT_MAX_DIST,
  ORBIT_MAX_POLAR_DEG,
  ORBIT_MIN_DIST,
  ORBIT_MIN_POLAR_DEG,
} from '../../config/cameraConfig'
import { fitPerspectiveCamera } from '../core/fitPerspectiveCamera'
import { clampOrbitTarget } from '../core/orbitTargetClamp'

const DEG_TO_RAD = Math.PI / 180

/**
 * 相机位姿快照：组件级预分配、就地更新（§10.1 稳态无分配）。
 * 持有方不得保留引用跨帧使用——内容随下一次通知覆盖。
 */
export interface CameraPoseSnapshot {
  readonly position: [number, number, number]
  readonly quaternion: [number, number, number, number]
}

export interface CameraRigProps {
  /** 厂房内空边界（§6.1）：fit 对象与 target 夹取边界 */
  readonly bounds: FactoryBoundsDto
  /** 相机位姿变化通知（初始 fit / 每次 change / viewport 尺寸变化） */
  readonly onCameraPoseChanged?: (pose: CameraPoseSnapshot) => void
}

type OrbitControlsElement = ComponentRef<typeof OrbitControls>

/** bounds 值比较：地图变更（DTO 值变化）才重新 fit，同值新对象不重置用户机位 */
function sameBounds(a: FactoryBoundsDto, b: FactoryBoundsDto): boolean {
  return (
    a.innerMinX === b.innerMinX
    && a.innerMaxX === b.innerMaxX
    && a.innerMinZ === b.innerMinZ
    && a.innerMaxZ === b.innerMaxZ
    && a.centerX === b.centerX
    && a.centerZ === b.centerZ
  )
}

export function CameraRig({ bounds, onCameraPoseChanged }: CameraRigProps): ReactElement {
  const camera = useThree((state) => state.camera)
  const size = useThree((state) => state.size)

  const controlsRef = useRef<OrbitControlsElement | null>(null)
  /** 用户是否已操作（旋转/缩放/平移的 start 事件）；已操作后 resize 不重置机位 */
  const userInteractedRef = useRef(false)
  /** 上次完成 fit 的 bounds：值变化 = 地图变更 → 重新 fit（§9.1） */
  const fittedBoundsRef = useRef<FactoryBoundsDto | null>(null)
  /** 预分配位姿快照与 target 夹取 out（§10.1：稳态无逐帧分配） */
  const poseRef = useRef<CameraPoseSnapshot>({
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
  })
  const clampedTargetRef = useRef<[number, number, number]>([0, 0, 0])
  const poseCallbackRef = useRef(onCameraPoseChanged)
  useEffect(() => {
    poseCallbackRef.current = onCameraPoseChanged
  }, [onCameraPoseChanged])

  const notifyPose = useCallback((): void => {
    const callback = poseCallbackRef.current
    if (callback === undefined) return
    const pose = poseRef.current
    pose.position[0] = camera.position.x
    pose.position[1] = camera.position.y
    pose.position[2] = camera.position.z
    pose.quaternion[0] = camera.quaternion.x
    pose.quaternion[1] = camera.quaternion.y
    pose.quaternion[2] = camera.quaternion.z
    pose.quaternion[3] = camera.quaternion.w
    callback(pose)
  }, [camera])

  // §9.1 初始/地图变更 fit 与 resize 规则；viewport 从 0 维恢复后 R3F 重新
  // configure 更新 size，本效应随之重算投影并触发标签候选重算钩子（§1.4）
  useLayoutEffect(() => {
    if (size.width <= 0 || size.height <= 0) return
    const aspect = size.width / size.height
    // Canvas camera prop 固定创建 PerspectiveCamera（非 orthographic）
    const perspective = camera as PerspectiveCamera
    perspective.aspect = aspect

    const previous = fittedBoundsRef.current
    if (previous === null || !sameBounds(previous, bounds)) {
      // 首次 ready / 地图变更：重新 fit，重置用户操作标记（§9.1）
      userInteractedRef.current = false
    }

    if (!userInteractedRef.current) {
      const fit = fitPerspectiveCamera(bounds, aspect)
      camera.position.set(fit.position[0], fit.position[1], fit.position[2])
      camera.up.set(fit.up[0], fit.up[1], fit.up[2])
      camera.lookAt(fit.target[0], fit.target[1], fit.target[2])
      const controls = controlsRef.current
      if (controls !== null) {
        controls.target.set(fit.target[0], fit.target[1], fit.target[2])
        controls.update()
      }
    }
    // 已操作后 resize：仅更新 aspect/projection，不重置机位（§9.1）
    perspective.updateProjectionMatrix()
    fittedBoundsRef.current = bounds
    notifyPose()
  }, [bounds, size, camera, notifyPose])

  // §9.2 target 夹取：每次 change 后强制执行（XZ 外扩 20m，Y 恒为 0）
  const handleControlsChange = useCallback((): void => {
    const controls = controlsRef.current
    if (controls === null) return
    const target = controls.target
    const clamped = clampedTargetRef.current
    clampOrbitTarget(bounds, target.x, target.z, clamped)
    if (clamped[0] !== target.x || clamped[1] !== target.y || clamped[2] !== target.z) {
      target.set(clamped[0], clamped[1], clamped[2])
    }
    notifyPose()
  }, [bounds, notifyPose])

  const handleControlsStart = useCallback((): void => {
    userInteractedRef.current = true
  }, [])

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={ORBIT_DAMPING_FACTOR}
      minDistance={ORBIT_MIN_DIST}
      maxDistance={ORBIT_MAX_DIST}
      minPolarAngle={ORBIT_MIN_POLAR_DEG * DEG_TO_RAD}
      maxPolarAngle={ORBIT_MAX_POLAR_DEG * DEG_TO_RAD}
      screenSpacePanning={false}
      onStart={handleControlsStart}
      onChange={handleControlsChange}
    />
  )
}
