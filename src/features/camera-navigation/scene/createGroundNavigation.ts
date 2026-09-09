/**
 * 只负责将屏幕增量换算为相机位移，不持有鼠标会话或隐藏的轨道增量。
 * 旋转、平移、缩放均从当前真实机位求解，交替操作不会沿用缩放前的射线。
 */
import { MathUtils, Plane, Raycaster, Spherical, Vector2, Vector3, type Camera, type PerspectiveCamera } from 'three'
import type { NavigationLimits } from '../model/navigationControls'

export function createGroundNavigation(camera: Camera, element: HTMLElement) {
  const plane = new Plane(new Vector3(0, 1, 0), 0)
  const raycaster = new Raycaster()
  const pointer = new Vector2()
  const previous = new Vector3()
  const current = new Vector3()
  const translation = new Vector3()
  const offset = new Vector3()
  const right = new Vector3()
  const forward = new Vector3()
  const spherical = new Spherical()

  /**
   * 求交前更新相机矩阵，忽略水平线附近数值不稳定的射线。
   * 无法命中时由调用方选择后备变换，不能直接吞掉整次平移。
   */
  const readGround = (x: number, y: number, result: Vector3): boolean => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    pointer.set((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2)
    camera.updateMatrixWorld()
    raycaster.setFromCamera(pointer, camera)
    if (raycaster.ray.direction.y >= -0.001) return false
    if (raycaster.ray.intersectPlane(plane, result) === null) return false
    return Number.isFinite(result.lengthSq())
  }

  return {
    /**
     * 围绕当前观察中心改变角度，再平移补偿以保持按下处的地面落点。
     * 最终边界修正只提交一次，不再用会修改控制器限值的递归试算拒绝手势。
     */
    rotate(controls: NavigationLimits, x: number, y: number, deltaX: number, deltaY: number, constrain: () => void): void {
      const height = element.getBoundingClientRect().height
      if (height <= 0 || (deltaX === 0 && deltaY === 0)) return
      const anchored = readGround(x, y, previous)
      spherical.setFromVector3(offset.subVectors(camera.position, controls.target))
      const radiansPerPixel = 2 * Math.PI * controls.rotateSpeed / height
      spherical.theta = MathUtils.clamp(spherical.theta - deltaX * radiansPerPixel, controls.minAzimuthAngle, controls.maxAzimuthAngle)
      spherical.phi = MathUtils.clamp(spherical.phi - deltaY * radiansPerPixel, controls.minPolarAngle, controls.maxPolarAngle)
      spherical.makeSafe()
      camera.position.copy(controls.target).add(offset.setFromSpherical(spherical))
      camera.lookAt(controls.target)
      if (anchored && readGround(x, y, current)) {
        translation.subVectors(previous, current)
        camera.position.add(translation)
        controls.target.add(translation)
      }
      constrain()
    },
    /**
     * 正常视角用地面抓取，保持地图跟手；接近水平线或拖出画布时使用相机平面基向量。
     * 后备速度按观察距离、有效视场和俯角计算，放大到近景后仍能连续平移。
     */
    pan(target: Vector3, fromX: number, fromY: number, toX: number, toY: number): void {
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const distance = camera.position.distanceTo(target)
      const perspective = camera as PerspectiveCamera
      const worldPerPixel = 2 * distance * Math.tan(perspective.getEffectiveFOV() * Math.PI / 360) / rect.height
      const deltaX = toX - fromX
      const deltaY = toY - fromY
      const maxStep = worldPerPixel * Math.hypot(deltaX, deltaY) * 20
      const hit = readGround(fromX, fromY, previous) && readGround(toX, toY, current)
      if (hit) translation.subVectors(previous, current)
      if (!hit || translation.length() > maxStep) {
        camera.updateMatrixWorld()
        right.setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize()
        forward.crossVectors(camera.up, right).normalize()
        const sinPitch = Math.max(0.1, camera.position.y / Math.max(distance, 0.001))
        translation.copy(right).multiplyScalar(-deltaX * worldPerPixel)
          .addScaledVector(forward, deltaY * worldPerPixel / sinPitch)
      }
      camera.position.add(translation)
      target.add(translation)
    },
    /**
     * 自由浏览绕光标落点缩放，车辆跟随绕当前观察中心缩放。
     * 两个端点使用同一倍率，保持视角不变，后续平移无需重置中心。
     */
    zoom(target: Vector3, x: number, y: number, factor: number, keepTarget: boolean): void {
      if (!Number.isFinite(factor) || factor <= 0) return
      if (keepTarget || !readGround(x, y, current)) current.copy(target)
      camera.position.sub(current).multiplyScalar(factor).add(current)
      target.sub(current).multiplyScalar(factor).add(current)
    },
  }
}
