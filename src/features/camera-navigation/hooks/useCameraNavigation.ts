/**
 * 相机导航生命周期 Hook（SPEC §5.5、§8、§12.3；TASK-013；视觉对齐 P0-5.2
 * 默认作业区聚焦）。
 *
 * 职责：在唯一 Canvas 内自持 OrbitControls 实例（旋转/平移/光标定点滚轮缩
 *       放 + 阻尼、最小 0.25m / 最大地图对角线 3 倍）、按地图包围盒 45° 自
 *       动取景（初始取景
 *       与空格俯瞰共用同一数学）、双击跟随状态机（进入时捕获相对偏移、每帧
 *       读取只读目标、手动拖拽或目标删除立即退出）、监听器对称清理；并把
 *       { follow, exitFollow, overview } 命令经 commandsRef 交给 app 组合层
 *       ——双击跟随请求由组合层转交，跨 Feature 协作不经过任何共享 Store。
 *       P0-5.2：initialFocusBounds 就绪且用户尚未交互时，把机位一次性移动
 *       到活跃作业区（距离限制仍按全图包围盒），空格键保留完整全厂总览。
 * 边界：本 Hook 只操作相机与输入事件，不读取车辆数据（目标位置经注入的
 *       FollowTargetReader 获取；聚焦包围盒由 app 组合层从地图模型与车队
 *       运行时派生后注入）、不修改场景内容、不渲染任何 DOM；Esc/空白
 *       的取消选中语义归 fleet-monitoring（§8），本 Hook 不处理 Escape。
 * 关键不变量：
 * 1. OrbitControls 单实例：随 (camera, gl) 创建一次，卸载 dispose 并清空
 *    controlsRef/commandsRef——StrictMode 的 setup→cleanup→setup 不残留监听
 *    或引用；
 * 2. 跟随是 ref 状态机：偏移与目标键保存在 ref，逐帧更新不触碰 React state
 *    （SPEC §4）；store 只在进入/退出跟随的低频跃迁时写一次；
 * 3. 跟随期间滚轮缩放相对偏移（方向与 OrbitControls 一致：滚离缩小、滚近
 *    放大），缩放被钳制进 [minDistance, maxDistance]；此时 controls 自身
 *    缩放关闭，两者不会互相抢占；
 * 4. 拖拽判定与车辆选择的拖拽抑制同阈值（6px）：单击（含双击的第一次单击）
 *    不退出跟随、不移动相机；
 * 5. 距离限制恒等式：minDistance=0.25，maxDistance=max(对角线×3,
 *    minDistance+间隔)，
 *    bounds 变化时与取景同时重设，任何时刻都满足 max > min；
 * 6. 默认聚焦一次性且不抢镜：只移动 position/target，不缩拢 near/far 与
 *    距离限制；用户已交互（按下/滚轮/空格）后到达的聚焦请求被静默丢弃。
 */
import { useCallback, useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { FocusBounds, SceneBounds } from '@/features/map-visualization'
import type { FollowTargetReader } from '@/features/fleet-monitoring'
import { useCameraNavigationStore } from '../model/cameraNavigationStore'
import {
  CAMERA_MIN_DISTANCE_M,
  computeOverviewPose,
} from '../model/overviewFraming'

/** 相机命令合同：app 组合层经 commandsRef 持有并转发双击跟随/俯瞰请求 */
export interface CameraNavigationCommands {
  /** 进入/切换跟随指定车辆；已跟随时仅切换目标并保留原偏移 */
  follow(entityKey: string): void
  /** 立即退出跟随（幂等） */
  exitFollow(): void
  /** 空格俯瞰语义：退出跟随并回到地图包围盒中心 45° 机位 */
  overview(): void
  /** 是否正在跟随（桥接诊断与测试用） */
  isFollowing(): boolean
  /** 当前跟随实体键；未跟随为 null */
  getFollowedKey(): string | null
}

export interface UseCameraNavigationOptions {
  /** 地图场景包围盒；null 表示地图未就绪（不取景、不设距离上限） */
  bounds: SceneBounds | null
  /**
   * 默认聚焦作业区包围盒（视觉对齐 P0-5.2）：首次就绪且用户尚未交互时把
   * 机位一次性移动到该区域（取景数学与全厂俯瞰共用，距离限制不缩拢）；
   * null 表示保持全厂总览。
   */
  initialFocusBounds?: FocusBounds | null
  /** 只读跟随目标读取器：实体键 → 世界坐标；null 时跟随命令无法成立 */
  readFollowTarget: FollowTargetReader | null
  /** 相机命令输出引用；由 app 组合层传入并在卸载时被清空 */
  commandsRef?: { current: CameraNavigationCommands | null }
  /** 测试/诊断注入：暴露内部 OrbitControls 实例（所有者仍是本 Hook） */
  controlsRef?: { current: OrbitControls | null }
  /** 拖拽退出跟随的位移阈值（像素）；默认 6，与选择拖拽抑制同口径 */
  dragExitThresholdPx?: number
  /**
   * 相机交互能力就绪信号（TASK-017 启动编排）：OrbitControls、命令出口与
   * 输入监听在本 Hook 挂载 effect 中装配完毕后调用一次（每个挂载实例至多
   * 一次）。app 组合层据此合成 appInteractive 启动阶段；未注入时不上报。
   */
  onReady?: () => void
}

/** 跟随状态（ref 内部形态）：目标实体键 + 进入时捕获的相机相对偏移 */
interface FollowState {
  readonly key: string
  readonly offset: THREE.Vector3
}

/** 拖拽退出跟随默认阈值：与 useVehicleSelection 的拖拽抑制一致（像素） */
const DEFAULT_DRAG_EXIT_THRESHOLD_PX = 6

/** 跟随期间滚轮缩放偏移的系数（与 OrbitControls getZoomScale 同基数） */
const WHEEL_DOLLY_BASE = 0.95
/** 滚轮一格（deltaY=±100）对应的缩放强度 */
const WHEEL_DOLLY_NOTCH = 100

/**
 * 自由浏览与车辆跟随共用的滚轮缩放速度。
 * 略高于 OrbitControls 默认值，使新增的 8 倍近景范围无需过多滚轮操作即可
 * 到达，同时保留足够细的步进以检查相邻路径。
 */
const CAMERA_ZOOM_SPEED = 1.25

export function useCameraNavigation(options: UseCameraNavigationOptions): void {
  const { bounds, initialFocusBounds, readFollowTarget, commandsRef, controlsRef } = options
  const camera = useThree((state) => state.camera)
  const gl = useThree((state) => state.gl)

  // options 经 ref 透传：帧循环与事件处理器永远读取最新值而不重建订阅
  const boundsRef = useRef(bounds)
  boundsRef.current = bounds
  const readFollowTargetRef = useRef(readFollowTarget)
  readFollowTargetRef.current = readFollowTarget

  // OrbitControls 单实例所有者（不变量 1）
  const internalControlsRef = useRef<OrbitControls | null>(null)

  // 跟随状态机（ref，逐帧更新不进 React state；不变量 2）
  const followRef = useRef<FollowState | null>(null)
  // 指针拖拽判定基准：本指针会话的按下落点；null 表示无按下记录
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null)
  // 用户已交互旗标（P0-5.2）：按下/滚轮/空格后不再接受默认聚焦请求
  const userInteractedRef = useRef(false)

  /** 进入/切换跟随：首次进入捕获当前相机相对偏移，切换目标保留原偏移 */
  const enterFollow = useCallback((entityKey: string): void => {
    const controlsNow = internalControlsRef.current
    if (controlsNow === null) {
      return
    }
    const current = followRef.current
    const offset =
      current === null
        ? camera.position.clone().sub(controlsNow.target)
        : current.offset
    followRef.current = { key: entityKey, offset }
    // 跟随期间 controls 自身缩放关闭，滚轮经本 Hook 缩放相对偏移（不变量 3）
    controlsNow.enableZoom = false
    useCameraNavigationStore.getState().setFollowedEntityKey(entityKey)
  }, [camera])

  /** 退出跟随：恢复缩放并清空低频 store（幂等） */
  const exitFollow = useCallback((): void => {
    if (followRef.current === null) {
      return
    }
    followRef.current = null
    const controlsNow = internalControlsRef.current
    if (controlsNow !== null) {
      controlsNow.enableZoom = true
    }
    useCameraNavigationStore.getState().setFollowedEntityKey(null)
  }, [])

  /** 按当前包围盒重新取景（初始取景与空格俯瞰共用；先退出跟随） */
  const frameOverview = useCallback((): void => {
    const controlsNow = internalControlsRef.current
    const currentBounds = boundsRef.current
    if (controlsNow === null || currentBounds === null) {
      return
    }
    exitFollow()
    const perspective = camera as THREE.PerspectiveCamera
    // 四角投影包络需要视口纵横比（P0-1）：取画布实测尺寸，异常时退化为方视口
    const width = gl.domElement.clientWidth
    const height = gl.domElement.clientHeight
    const aspect = width > 0 && height > 0 ? width / height : 1
    const pose = computeOverviewPose(currentBounds, perspective.fov, aspect)
    perspective.near = pose.near
    perspective.far = pose.far
    perspective.updateProjectionMatrix()
    controlsNow.minDistance = pose.minDistance
    controlsNow.maxDistance = pose.maxDistance
    controlsNow.target.set(pose.target.x, 0, pose.target.z)
    camera.position.set(pose.position.x, pose.position.y, pose.position.z)
    controlsNow.update()
  }, [camera, gl, exitFollow])

  /**
   * 聚焦作业区取景（视觉对齐 P0-5.2）：取景数学与全厂俯瞰完全共用，但只
   * 移动 position/target——near/far 与距离限制保持全图包围盒的取景结果，
   * 用户随时可以缩放回全厂；地图未就绪时不动作。
   */
  const frameFocusArea = useCallback((focusBounds: FocusBounds): void => {
    const controlsNow = internalControlsRef.current
    if (controlsNow === null || boundsRef.current === null) {
      return
    }
    exitFollow()
    const perspective = camera as THREE.PerspectiveCamera
    const width = gl.domElement.clientWidth
    const height = gl.domElement.clientHeight
    const aspect = width > 0 && height > 0 ? width / height : 1
    const pose = computeOverviewPose(focusBounds, perspective.fov, aspect)
    controlsNow.target.set(pose.target.x, 0, pose.target.z)
    camera.position.set(pose.position.x, pose.position.y, pose.position.z)
    controlsNow.update()
  }, [camera, gl, exitFollow])

  // OrbitControls 生命周期：随 (camera, gl) 创建，卸载对称释放（不变量 1）。
  // 本 effect 必须先于取景/命令 effect 声明，保证同一次提交内先创建实例。
  useEffect(() => {
    const controlsInstance = new OrbitControls(camera, gl.domElement)
    controlsInstance.enableDamping = true
    /**
     * 围绕光标命中的屏幕位置推进镜头，密集地图中可直接对准某个节点或路径
     * 连续放大；最近距离与自动取景共用同一常量，避免初始化阶段口径漂移。
     */
    controlsInstance.zoomToCursor = true
    controlsInstance.zoomSpeed = CAMERA_ZOOM_SPEED
    controlsInstance.minDistance = CAMERA_MIN_DISTANCE_M
    internalControlsRef.current = controlsInstance
    if (controlsRef !== undefined) {
      controlsRef.current = controlsInstance
    }
    return () => {
      controlsInstance.dispose()
      internalControlsRef.current = null
      if (controlsRef !== undefined && controlsRef.current === controlsInstance) {
        controlsRef.current = null
      }
    }
  }, [camera, gl, controlsRef])

  // 取景：bounds 对象身份变化（地图就绪/替换）即重取景并重设距离限制
  useEffect(() => {
    if (bounds !== null) {
      frameOverview()
    }
  }, [bounds, frameOverview])

  // 默认作业区聚焦（视觉对齐 P0-5.2）：聚焦包围盒首次就绪且用户尚未交互
  // 时执行一次；用户已交互（按下/滚轮/空格）则静默丢弃，绝不抢镜头。
  useEffect(() => {
    if (initialFocusBounds === null || initialFocusBounds === undefined) {
      return
    }
    if (userInteractedRef.current) {
      return
    }
    frameFocusArea(initialFocusBounds)
  }, [initialFocusBounds, frameFocusArea])

  // 相机命令：注册进组合层传入的 ref，卸载时清空（防止悬挂命令入口）
  useEffect(() => {
    if (commandsRef === undefined) {
      return
    }
    commandsRef.current = {
      follow: enterFollow,
      exitFollow,
      overview: frameOverview,
      isFollowing: () => followRef.current !== null,
      getFollowedKey: () => followRef.current?.key ?? null,
    }
    return () => {
      commandsRef.current = null
    }
  }, [commandsRef, enterFollow, exitFollow, frameOverview])

  // 相机交互能力就绪信号（TASK-017）：命令出口装配 effect 在本 effect 之前
  // 执行（同提交内 effect 按声明顺序），此处触发即代表 OrbitControls、命令
  // 与监听全部就绪。一次性（每个挂载实例至多一次），回调经 ref 透传。
  const onReadyRef = useRef(options.onReady)
  onReadyRef.current = options.onReady
  const readySignaledRef = useRef(false)
  useEffect(() => {
    if (readySignaledRef.current) {
      return
    }
    readySignaledRef.current = true
    onReadyRef.current?.()
  }, [])

  // 空格俯瞰（SPEC §8）：window 级键盘监听，effect 对称清理；preventDefault
  // 抑制浏览器默认滚动语义（页面本身不可滚动，防御性保留）。空格是用户
  // 明确选择全厂总览，同时标记已交互（此后默认聚焦不再抢占，P0-5.2）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code === 'Space' || event.key === ' ') {
        event.preventDefault()
        userInteractedRef.current = true
        frameOverview()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [frameOverview])

  // 指针拖拽退出跟随 + 跟随期间滚轮缩放偏移：监听在画布元素上，effect
  // 对称清理；只接受主鼠标指针（SPEC §8，与车辆拾取同一判定口径）
  useEffect(() => {
    const domElement = gl.domElement
    const thresholdPx = options.dragExitThresholdPx ?? DEFAULT_DRAG_EXIT_THRESHOLD_PX

    const isMainMouse = (native: PointerEvent | WheelEvent): boolean => {
      const pointerType = (native as PointerEvent).pointerType
      if (typeof pointerType === 'string' && pointerType !== 'mouse') {
        return false
      }
      if ((native as PointerEvent).isPrimary === false) {
        return false
      }
      return true
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (!isMainMouse(event)) {
        return
      }
      userInteractedRef.current = true
      pointerDownRef.current = { x: event.clientX, y: event.clientY }
    }
    const onPointerMove = (event: PointerEvent): void => {
      const down = pointerDownRef.current
      if (down === null || followRef.current === null || !isMainMouse(event)) {
        return
      }
      // 位移超阈值视为轨道拖拽：立即退出跟随，当前 controls 姿态无缝接管
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > thresholdPx) {
        exitFollow()
      }
    }
    const onPointerUp = (): void => {
      pointerDownRef.current = null
    }
    const onWheel = (event: WheelEvent): void => {
      userInteractedRef.current = true
      if (followRef.current === null || !isMainMouse(event)) {
        return
      }
      // 跟随期间缩放相对偏移（不变量 3）；controls 缩放已关闭不会抢占
      event.preventDefault()
      const controlsNow = internalControlsRef.current
      if (controlsNow === null) {
        return
      }
      const { offset } = followRef.current
      const factor = WHEEL_DOLLY_BASE ** (
        (event.deltaY / WHEEL_DOLLY_NOTCH) * CAMERA_ZOOM_SPEED
      )
      const nextLength = THREE.MathUtils.clamp(
        offset.length() * factor,
        controlsNow.minDistance,
        controlsNow.maxDistance,
      )
      offset.setLength(nextLength)
    }

    domElement.addEventListener('pointerdown', onPointerDown)
    domElement.addEventListener('pointermove', onPointerMove)
    domElement.addEventListener('pointerup', onPointerUp)
    domElement.addEventListener('pointercancel', onPointerUp)
    domElement.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      domElement.removeEventListener('pointerdown', onPointerDown)
      domElement.removeEventListener('pointermove', onPointerMove)
      domElement.removeEventListener('pointerup', onPointerUp)
      domElement.removeEventListener('pointercancel', onPointerUp)
      domElement.removeEventListener('wheel', onWheel)
      pointerDownRef.current = null
    }
  }, [gl, exitFollow, options.dragExitThresholdPx])

  // 帧循环：跟随 → 写目标与偏移（目标删除即退出），随后驱动阻尼更新。
  // R3F 同帧回调按注册序执行，本 Hook 的 update 在自身跟随写入之后调用，
  // 保证渲染用的是最终位姿；拖拽产生的阻尼残量在退出后自然衰减。
  useFrame(() => {
    const controlsNow = internalControlsRef.current
    if (controlsNow === null) {
      return
    }
    const following = followRef.current
    if (following !== null) {
      const target = readFollowTargetRef.current?.(following.key) ?? null
      if (target === null) {
        // 目标不存在（已删除/非法位置）：立即退出，相机停在当前位置
        exitFollow()
      } else {
        controlsNow.target.set(target.x, 0, target.z)
        camera.position.set(
          target.x + following.offset.x,
          following.offset.y,
          target.z + following.offset.z,
        )
      }
    }
    controlsNow.update()
  })
}
