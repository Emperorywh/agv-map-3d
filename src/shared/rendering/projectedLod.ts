/**
 * 车辆与设施共用按投影尺寸选择细节的规则，主画面保持原有 CSS 像素阈值。
 * 离屏绘制按实际视口缩小预算，各相机、各分辨率分别维护滞回状态。
 */
import * as THREE from 'three'

const reflectionCameras = new WeakSet<THREE.Camera>()
export function registerReflectionCamera(camera: THREE.Camera) { reflectionCameras.add(camera) }

export class ProjectedLod {
  private readonly capacity: number
  private readonly diameter: number
  private readonly thresholds: readonly [number, number]
  private readonly cameraLevels = new WeakMap<THREE.Camera, Map<number, Uint8Array>>()
  private readonly view = new THREE.Matrix4()
  private readonly size = new THREE.Vector2()
  private readonly viewport = new THREE.Vector4()
  private levels: Uint8Array
  private factor = 0
  private perspective = false
  private minimumLevel = 0

  constructor(capacity: number, diameter: number, thresholds: readonly [number, number]) {
    this.capacity = capacity
    this.diameter = diameter
    this.thresholds = thresholds
    this.levels = new Uint8Array(capacity).fill(255)
  }

  /**
   * 主体、透射和镜像即使复用同一个相机，也不能共享不同分辨率的切档历史。
   * 每个相机最多缓存四种尺寸，窗口连续缩放不会无限保留旧槽位数组。
   */
  prepare(renderer: THREE.WebGLRenderer, camera: THREE.Camera, world: THREE.Matrix4, material: THREE.Material): void {
    renderer.getSize(this.size)
    renderer.getCurrentViewport(this.viewport)
    const height = Math.max(1, Math.min(this.size.y, this.viewport.w / renderer.getPixelRatio()))
    let resolutions = this.cameraLevels.get(camera)
    if (resolutions === undefined) { resolutions = new Map(); this.cameraLevels.set(camera, resolutions) }
    let levels = resolutions.get(height)
    if (levels === undefined) {
      if (resolutions.size >= 4) resolutions.delete(resolutions.keys().next().value!)
      levels = new Uint8Array(this.capacity).fill(255)
      resolutions.set(height, levels)
    }
    this.levels = levels
    this.view.multiplyMatrices(camera.matrixWorldInverse, world)
    this.factor = height * Math.abs(camera.projectionMatrix.elements[5]) * this.diameter / 2
    this.perspective = camera instanceof THREE.PerspectiveCamera
    /**
     * 阴影和柔化倒影最多使用中景模型，细小倒角不再进入这些辅助通道。
     * 高画质不传派生几何，调用方仍会把结果限制到原模型，保留显式档位语义。
     */
    this.minimumLevel = reflectionCameras.has(camera) || material instanceof THREE.MeshDepthMaterial || material instanceof THREE.MeshDistanceMaterial ? 1 : 0
  }

  select(slot: number, x: number, y: number, z: number): number {
    const view = this.view.elements
    const depth = -(view[2] * x + view[6] * y + view[10] * z + view[14])
    const pixels = this.perspective ? this.factor / Math.max(0.01, depth) : this.factor
    const previous = this.levels[slot]
    let level = pixels >= this.thresholds[0] ? 0 : pixels >= this.thresholds[1] ? 1 : 2
    /**
     * 百分之十五的滞回抑制临界距离闪烁，所有材质部件使用相同尺寸口径。
     * 辅助通道的最低细节级别在滞回后应用，避免上一帧近景状态突破预算。
     */
    if (previous !== 255 && level !== previous) {
      const boundary = this.thresholds[level > previous ? previous : level]
      if (level > previous ? pixels > boundary * 0.85 : pixels < boundary * 1.15) level = previous
    }
    level = Math.max(level, this.minimumLevel)
    this.levels[slot] = level
    return level
  }
}
