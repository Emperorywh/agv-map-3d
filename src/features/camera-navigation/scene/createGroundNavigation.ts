/**
 * 鼠标旋转、平移和定点缩放共用地面射线，以鼠标落点作为操作基准。
 * 旋转锁定按下处的屏幕位置；平移跟随光标，缩放保持落点不变。
 */
import { MathUtils, Plane, Raycaster, Spherical, Vector2, Vector3, type Camera } from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export function createGroundNavigation(camera: Camera, element: HTMLElement) {
  const plane = new Plane(new Vector3(0, 1, 0), 0)
  const raycaster = new Raycaster()
  const pointer = new Vector2()
  const previous = new Vector3()
  const current = new Vector3()
  const translation = new Vector3()
  /**
   * 旋转试算复用同一组机位快照与球坐标，不修改控制器内部的角度增量。
   * 地面落点与观察中心分开保存，避免直接改 target 导致按下瞬间跳到屏幕中央。
   */
  const rotationPosition = new Vector3()
  const rotationTarget = new Vector3()
  const candidatePosition = new Vector3()
  const candidateTarget = new Vector3()
  const rotationOffset = new Vector3()
  const rotationSpherical = new Spherical()

  /**
   * 直接从画布坐标投影到地面，透视造成的远近比例由射线自然处理。
   * 复用向量和射线；画布不可见或射线没有向下命中时放弃本次求交。
   */
  const readGround = (x: number, y: number, result: Vector3): boolean => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    pointer.set((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2)
    camera.updateMatrixWorld()
    raycaster.setFromCamera(pointer, camera)
    if (raycaster.ray.direction.y >= -0.000001) return false
    return raycaster.ray.intersectPlane(plane, result) !== null
  }

  return {
    /**
     * 先改变方位和俯角，再水平补偿相机与观察中心，使按下处的地面点不漂移。
     * 每步读取实际机位，整次拖动共用按下坐标；缩放后无需重新居中或移动视野。
     */
    rotate(controls: OrbitControls, x: number, y: number, deltaX: number, deltaY: number, constrain: () => void): void {
      const height = element.clientHeight
      if (height <= 0 || (deltaX === 0 && deltaY === 0) || !readGround(x, y, previous)) return
      rotationPosition.copy(camera.position)
      rotationTarget.copy(controls.target)
      rotationSpherical.setFromVector3(rotationOffset.subVectors(rotationPosition, rotationTarget))
      const { radius, theta, phi } = rotationSpherical
      const radiansPerPixel = 2 * Math.PI * controls.rotateSpeed / height
      const nextTheta = MathUtils.clamp(theta - deltaX * radiansPerPixel, controls.minAzimuthAngle, controls.maxAzimuthAngle)
      const nextPhi = MathUtils.clamp(phi - deltaY * radiansPerPixel, controls.minPolarAngle, controls.maxPolarAngle)

      /**
       * 试算必须先锁定鼠标落点，再交给既有地面与厂房约束验证。
       * 若保护逻辑需要推移或缩放机位，则该角度不可达，不能直接接受造成漂移的修正。
       */
      const attempt = (fraction: number): boolean => {
        rotationSpherical.set(radius, phi + (nextPhi - phi) * fraction, theta + (nextTheta - theta) * fraction)
        rotationSpherical.makeSafe()
        controls.target.copy(rotationTarget)
        camera.position.copy(rotationTarget).add(rotationOffset.setFromSpherical(rotationSpherical))
        camera.lookAt(controls.target)
        if (!readGround(x, y, current)) return false
        translation.subVectors(previous, current)
        camera.position.add(translation)
        controls.target.add(translation)
        camera.updateMatrixWorld()
        candidatePosition.copy(camera.position)
        candidateTarget.copy(controls.target)
        constrain()
        return camera.position.distanceToSquared(candidatePosition) <= 1e-12 &&
          controls.target.distanceToSquared(candidateTarget) <= 1e-12
      }
      if (attempt(1)) return

      /**
       * 触边时只应用本次输入中可行的角度，保留原有室内取景与离地保护。
       * 有界二分不积累被拒绝的位移，反向拖动立即生效，松手后也不会继续滑移。
       */
      let lower = 0
      let upper = 1
      for (let step = 0; step < 12; step += 1) {
        const middle = (lower + upper) / 2
        if (attempt(middle)) lower = middle
        else upper = middle
      }
      if (lower > 0) {
        attempt(lower)
      } else {
        camera.position.copy(rotationPosition)
        controls.target.copy(rotationTarget)
        camera.lookAt(controls.target)
        camera.updateMatrixWorld()
        constrain()
      }
    },
    /**
     * 将旧光标下的地面点移动到新光标下，横向、纵向和斜向使用同一规则。
     * 每次从实际机位重新求交，触及边界后反向拖动无需抵消累计位移。
     */
    pan(target: Vector3, fromX: number, fromY: number, toX: number, toY: number): void {
      if (!readGround(fromX, fromY, previous) || !readGround(toX, toY, current)) return
      translation.subVectors(previous, current)
      camera.position.add(translation)
      target.add(translation)
    },
    /**
     * 自由浏览围绕光标地面落点等比缩放，跟随时围绕车辆所在的观察中心。
     * 同时缩放两个端点，避免沿单位射线推进导致不同光标位置的缩放速度不同。
     */
    zoom(target: Vector3, x: number, y: number, factor: number, keepTarget: boolean): void {
      if (keepTarget || !readGround(x, y, current)) current.copy(target)
      camera.position.sub(current).multiplyScalar(factor).add(current)
      target.sub(current).multiplyScalar(factor).add(current)
    },
  }
}
