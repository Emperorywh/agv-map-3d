/**
 * 相机交互的唯一提交入口：输入意图经过几何变换和空间约束后，同步相机矩阵。
 * 不创建 OrbitControls，不积累阻尼或待消费位移，松手即停，切换操作即刻生效。
 */
import { MathUtils, Quaternion, Spherical, Vector3, type PerspectiveCamera } from 'three'
import type { FactoryLayout } from '@/features/map-visualization'
import { CAMERA_MAX_PITCH_RAD, CAMERA_MIN_DISTANCE_M, getFactoryMinPitch } from '../model/factoryFraming'
import type { CameraNavigationControls } from '../model/navigationControls'
import { bindNavigationInput } from './bindNavigationInput'
import { createGroundNavigation } from './createGroundNavigation'
import { constrainCameraToFactory } from './constrainCameraToFactory'
import { constrainCameraToGround } from './constrainCameraToGround'

interface NavigationControllerOptions {
  layout(): FactoryLayout | null
  isFollowing(): boolean
  beforeDrag(travel: number): boolean
  onInteract(): void
  onUpdate(): void
  overview(): void
}

export function createCameraNavigationController(
  camera: PerspectiveCamera,
  element: HTMLElement,
  options: NavigationControllerOptions,
): CameraNavigationControls {
  const navigation = createGroundNavigation(camera, element)
  const lastPosition = camera.position.clone()
  const lastTarget = new Vector3()
  const lastQuaternion = new Quaternion()
  const offset = new Vector3()
  const spherical = new Spherical()
  let disposed = false

  /**
   * 更新前拒绝非法数值，角度与空间约束使用当前视场，避免缩放后的旧限值参与平移。
   * 最终矩阵在事件返回前就绪，下一次射线、场景拾取和渲染看到相同的真实机位。
   */
  const update = (): boolean => {
    if (disposed) return false
    if (!Number.isFinite(camera.position.lengthSq()) || !Number.isFinite(controls.target.lengthSq())) {
      camera.position.copy(lastPosition)
      controls.target.copy(lastTarget)
    }
    controls.target.y = 0
    controls.maxPolarAngle = Math.PI / 2 - getFactoryMinPitch(camera.fov, camera.zoom)
    spherical.setFromVector3(offset.subVectors(camera.position, controls.target))
    const phi = MathUtils.clamp(spherical.phi, controls.minPolarAngle, controls.maxPolarAngle)
    const theta = MathUtils.clamp(spherical.theta, controls.minAzimuthAngle, controls.maxAzimuthAngle)
    if (spherical.phi !== phi || spherical.theta !== theta) {
      spherical.phi = phi
      spherical.theta = theta
      camera.position.copy(controls.target).add(offset.setFromSpherical(spherical))
    }
    const layout = options.layout()
    if (layout === null) constrainCameraToGround(camera, controls)
    else constrainCameraToFactory(camera, controls, layout, options.isFollowing())
    camera.lookAt(controls.target)
    camera.updateMatrixWorld()
    const changed = !lastPosition.equals(camera.position) || !lastTarget.equals(controls.target) || !lastQuaternion.equals(camera.quaternion)
    lastPosition.copy(camera.position)
    lastTarget.copy(controls.target)
    lastQuaternion.copy(camera.quaternion)
    options.onUpdate()
    return changed
  }

  const controls: CameraNavigationControls = {
    target: new Vector3(),
    enabled: true,
    enableRotate: true,
    enablePan: true,
    enableZoom: true,
    minDistance: CAMERA_MIN_DISTANCE_M,
    maxDistance: Infinity,
    minPolarAngle: Math.PI / 2 - CAMERA_MAX_PITCH_RAD,
    maxPolarAngle: Math.PI / 2 - getFactoryMinPitch(camera.fov, camera.zoom),
    minAzimuthAngle: -Infinity,
    maxAzimuthAngle: Infinity,
    rotateSpeed: 1,
    zoomSpeed: 2,
    update,
    cancelGesture: () => input.cancel(),
    dispose(): void {
      if (disposed) return
      disposed = true
      input.dispose()
    },
  }

  /**
   * 滚轮和中键拖动复用指数倍率，限制指数以容纳高精度触控板和极端滚轮量。
   * 跟随缩放固定车辆中心，其余缩放固定光标落点，最远与最近距离使用实际值。
   */
  const zoom = (x: number, y: number, delta: number): void => {
    update()
    const distance = camera.position.distanceTo(controls.target)
    if (distance <= 0) return
    const factor = Math.exp(MathUtils.clamp(-Math.log(0.95) * delta / 100 * controls.zoomSpeed, -20, 20))
    const nextDistance = MathUtils.clamp(distance * factor, controls.minDistance, controls.maxDistance)
    navigation.zoom(controls.target, x, y, nextDistance / distance, options.isFollowing())
    update()
  }
  const input = bindNavigationInput(element, {
    enabled: (gesture) => !disposed && controls.enabled && (gesture === 'rotate' ? controls.enableRotate
      : gesture === 'pan' ? controls.enablePan : gesture === 'dolly' ? controls.enableZoom : true),
    interact: options.onInteract,
    drag(gesture, x, y, lastX, lastY, dx, dy, travel): void {
      if (!options.beforeDrag(travel)) return
      if (gesture === 'rotate') {
        navigation.rotate(controls, x, y, dx, dy, update)
      } else if (gesture === 'pan') {
        navigation.pan(controls.target, lastX, lastY, lastX + dx, lastY + dy)
        update()
      } else {
        zoom(x, y, dy * 4)
      }
    },
    wheel: zoom,
    overview: options.overview,
  })
  return controls
}
