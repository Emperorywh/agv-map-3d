/**
 * 鼠标平移和定点缩放共用地面射线，让地面上的抓取位置跟随光标。
 * 只平移或等比缩放相机与观察中心，保持俯角、方位及目标的零高度不变。
 */
import { Plane, Raycaster, Vector2, Vector3, type Camera } from 'three'

export function createGroundNavigation(camera: Camera, element: HTMLElement) {
  const plane = new Plane(new Vector3(0, 1, 0), 0)
  const raycaster = new Raycaster()
  const pointer = new Vector2()
  const previous = new Vector3()
  const current = new Vector3()
  const translation = new Vector3()

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
