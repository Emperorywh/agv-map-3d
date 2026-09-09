/**
 * 相机导航生命周期只负责自动取景、车辆跟随和公开命令，不再同时维护两套鼠标状态。
 * 输入由独立控制器统一处理，高频相机数据留在对象与引用中，低频跟随状态才进入 Store。
 */
import { useCallback, useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3, type PerspectiveCamera } from 'three'
import { getFactoryLayout, type FocusBounds, type SceneBounds } from '@/features/map-visualization'
import type { FollowTargetReader } from '@/features/fleet-monitoring'
import { useCameraNavigationStore } from '../model/cameraNavigationStore'
import type { CameraNavigationControls } from '../model/navigationControls'
import { computeOverviewPose } from '../model/overviewFraming'
import { createCameraNavigationController } from '../scene/createCameraNavigationController'

/**
 * 应用组合层只转交跟随和总览命令，不直接操作输入监听。
 * 诊断方法读取当前引用，命令注册与清理和控制器生命周期保持一致。
 */
export interface CameraNavigationCommands {
  follow(entityKey: string): void
  exitFollow(): void
  overview(): void
  isFollowing(): boolean
  getFollowedKey(): string | null
}

export interface UseCameraNavigationOptions {
  bounds: SceneBounds | null
  initialFocusBounds?: FocusBounds | null
  readFollowTarget: FollowTargetReader | null
  commandsRef?: { current: CameraNavigationCommands | null }
  controlsRef?: { current: CameraNavigationControls | null }
  dragExitThresholdPx?: number
  onReady?: () => void
}

/**
 * 跟随只保存目标键与相对偏移，切换车辆保留观察角度和距离。
 * 位移超过阈值才退出跟随，单击和双击中的轻微手抖不会抢走镜头。
 */
interface FollowState {
  readonly key: string
  readonly offset: Vector3
}

export function useCameraNavigation(options: UseCameraNavigationOptions): void {
  const camera = useThree((state) => state.camera) as PerspectiveCamera
  const gl = useThree((state) => state.gl)
  const optionsRef = useRef(options)
  optionsRef.current = options
  const internalControlsRef = useRef<CameraNavigationControls | null>(null)
  const followRef = useRef<FollowState | null>(null)
  const userInteractedRef = useRef(false)
  const framingRef = useRef<{ bounds: SceneBounds | null; focused: boolean }>({ bounds: null, focused: false })
  const readySignaledRef = useRef(false)

  /**
   * 进入和退出跟随不切换任何缩放开关，同一滚轮通道根据跟随状态选择锚点。
   * 失效实体不建立悬挂跟随；显式切换命令先结束旧拖动，避免沿用旧屏幕基准。
   */
  const exitFollow = useCallback((): void => {
    if (followRef.current === null) return
    followRef.current = null
    useCameraNavigationStore.getState().setFollowedEntityKey(null)
  }, [])
  const enterFollow = useCallback((entityKey: string): void => {
    const controls = internalControlsRef.current
    const target = optionsRef.current.readFollowTarget?.(entityKey)
    if (controls === null || target == null || !Number.isFinite(target.x) || !Number.isFinite(target.z)) return
    controls.cancelGesture()
    userInteractedRef.current = true
    const offset = followRef.current?.offset ?? camera.position.clone().sub(controls.target)
    followRef.current = { key: entityKey, offset }
    useCameraNavigationStore.getState().setFollowedEntityKey(entityKey)
  }, [camera])

  /**
   * 自动取景只在初始化、作业区首次就绪和主动总览时运行，手动浏览不再反复套用视锥取景。
   * 两种取景共用裁剪面和画布纵横比，并在写入后通过唯一控制器提交实际机位。
   */
  const frame = useCallback((mode: 'monitor' | 'overview', focus?: FocusBounds): void => {
    const controls = internalControlsRef.current
    const bounds = optionsRef.current.bounds
    if (controls === null || bounds === null) return
    exitFollow()
    controls.cancelGesture()
    const width = gl.domElement.clientWidth
    const height = gl.domElement.clientHeight
    const aspect = width > 0 && height > 0 ? width / height : 1
    const pose = computeOverviewPose(focus ?? bounds, camera.getEffectiveFOV(), aspect, getFactoryLayout(bounds), mode)
    camera.aspect = aspect
    camera.near = pose.near
    camera.far = pose.far
    camera.updateProjectionMatrix()
    controls.target.set(pose.target.x, 0, pose.target.z)
    camera.position.set(pose.position.x, pose.position.y, pose.position.z)
    controls.update()
  }, [camera, gl, exitFollow])
  const overview = useCallback((): void => {
    userInteractedRef.current = true
    frame('overview')
  }, [frame])

  /**
   * 一个挂载实例拥有一个控制器和一套完整输入监听，事件回调通过引用读取最新业务数据。
   * 清理覆盖捕获、公开命令和跟随状态，严格模式及图形上下文重建不会留下旧会话。
   */
  const { commandsRef, controlsRef } = options
  useEffect(() => {
    framingRef.current = { bounds: null, focused: false }
    const controls = createCameraNavigationController(camera, gl.domElement, {
      layout: () => {
        const bounds = optionsRef.current.bounds
        return bounds === null ? null : getFactoryLayout(bounds)
      },
      isFollowing: () => followRef.current !== null,
      beforeDrag: (travel) => {
        if (followRef.current === null) return true
        if (travel <= (optionsRef.current.dragExitThresholdPx ?? 6)) return false
        exitFollow()
        return true
      },
      onInteract: () => { userInteractedRef.current = true },
      onUpdate: () => {
        followRef.current?.offset.copy(camera.position).sub(controls.target)
      },
      overview,
    })
    internalControlsRef.current = controls
    if (controlsRef !== undefined) controlsRef.current = controls
    const commands: CameraNavigationCommands = {
      follow: enterFollow,
      exitFollow,
      overview,
      isFollowing: () => followRef.current !== null,
      getFollowedKey: () => followRef.current?.key ?? null,
    }
    if (commandsRef !== undefined) commandsRef.current = commands
    controls.update()
    return () => {
      controls.dispose()
      internalControlsRef.current = null
      if (controlsRef?.current === controls) controlsRef.current = null
      if (commandsRef?.current === commands) commandsRef.current = null
      exitFollow()
    }
  }, [camera, gl, commandsRef, controlsRef, enterFollow, exitFollow, overview])

  /**
   * 同一张地图只应用一次默认作业区聚焦，用户已开始操作后就不再自动抢镜。
   * 地图真正替换才重置取景资格，普通数据更新不会触发镜头跳转。
   */
  useEffect(() => {
    const bounds = options.bounds
    if (bounds === null) return
    const framing = framingRef.current
    if (framing.bounds !== null && framing.bounds !== bounds) {
      userInteractedRef.current = false
      framing.focused = false
    }
    framing.bounds = bounds
    if (!userInteractedRef.current) frame('monitor')
  }, [options.bounds, frame])
  useEffect(() => {
    if (options.bounds === null || options.initialFocusBounds == null || userInteractedRef.current || framingRef.current.focused) return
    frame('monitor', options.initialFocusBounds)
    framingRef.current.focused = true
  }, [options.bounds, options.initialFocusBounds, frame])
  useEffect(() => {
    if (readySignaledRef.current) return
    readySignaledRef.current = true
    optionsRef.current.onReady?.()
  }, [])

  /**
   * 跟随先写入目标与偏移，再提交约束；空闲帧也能处理画布比例和裁剪面变化。
   * 相机优先于地图渲染更新，车辆删除或无效坐标会立即退出跟随并停在当前视角。
   */
  useFrame(() => {
    const controls = internalControlsRef.current
    if (controls === null) return
    const following = followRef.current
    if (following !== null) {
      const target = optionsRef.current.readFollowTarget?.(following.key)
      if (target == null || !Number.isFinite(target.x) || !Number.isFinite(target.z)) {
        exitFollow()
      } else {
        controls.target.set(target.x, 0, target.z)
        camera.position.set(target.x + following.offset.x, following.offset.y, target.z + following.offset.z)
      }
    }
    controls.update()
  }, -1)
}
