/**
 * 车辆仍用固定业务槽位写入 CPU 草稿，绘制改由逐对象剔除的多绘制批次负责。
 * 主相机、镜像相机和阴影相机分别筛选完整部件，视野外实例不再提交顶点。
 */
import * as THREE from 'three'

export class CulledVehicleBatch extends THREE.BatchedMesh {
  readonly instanceMatrix: THREE.InstancedBufferAttribute
  instanceColor: THREE.InstancedBufferAttribute | null = null
  count = 0
  private readonly scratchMatrix = new THREE.Matrix4()
  private readonly scratchColor = new THREE.Color()
  /**
   * 脏集合精确到槽位，活跃集合同时用于计数、距离分档及简化拾取。
   * 相机分别持有滞回状态，倒影或阴影的距离选择不会污染主视角状态。
   */
  private readonly matrixSlots = new Set<number>()
  private readonly colorSlots = new Set<number>()
  private readonly activeSlots = new Set<number>()
  private readonly geometryIds: number[] = []
  private readonly cameraLevels = new WeakMap<THREE.Camera, Uint8Array>()
  private readonly viewMatrix = new THREE.Matrix4()
  private readonly drawingSize = new THREE.Vector2()
  private readonly pickBounds = new THREE.Box3()
  private readonly pickInverse = new THREE.Matrix4()
  private readonly pickRay = new THREE.Ray()
  private readonly pickPoint = new THREE.Vector3()
  private readonly lodPixels: readonly [number, number]
  private disposed = false

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, lodGeometries: readonly THREE.BufferGeometry[] = [], lodPixels: readonly [number, number] = [120, 36]) {
    /**
     * 尚未加载的精修部件只有空几何，以零顶点占位建立稳定槽位。
     * 每种真实几何只拷贝一次，不改变顶点、法线、索引或材质参数。
     */
    const empty = new THREE.BufferGeometry()
    empty.setAttribute('position', new THREE.Float32BufferAttribute([], 3))
    const source = geometry.hasAttribute('position') ? geometry : empty
    const levels = [source, ...lodGeometries]
    super(capacity, levels.reduce((sum, item) => sum + item.getAttribute('position').count, 0), levels.reduce((sum, item) => sum + (item.index?.count ?? 0), 0), material)
    this.lodPixels = lodPixels
    for (const level of levels) this.geometryIds.push(this.addGeometry(level))
    const geometryId = this.geometryIds[0]
    if (source.getAttribute('position').count > 0) {
      source.computeBoundingBox()
      this.pickBounds.copy(source.boundingBox!)
    }
    empty.dispose()
    this.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 16), 16)
    for (let slot = 0; slot < capacity; slot += 1) {
      this.addInstance(geometryId)
      this.setVisibleAt(slot, false)
    }
    /**
     * 禁用整批静态包围球判断，改用每个部件的实时矩阵和独立包围球。
     * 阴影与倒影进入内置回调时使用各自相机，保留屏幕外对象对画面的间接贡献。
     */
    this.frustumCulled = false
    this.perObjectFrustumCulled = true
    this.sortObjects = material.transparent
  }

  /**
   * 写草稿的同时登记槽位，一帧多次修改由集合去重。
   * 删除和全量回填沿用同一入口，不需要额外扫描整批零缩放矩阵。
   */
  markMatrixSlot(slot: number): void { this.matrixSlots.add(slot) }
  markColorSlot(slot: number): void { this.colorSlots.add(slot) }

  /**
   * 仅提交本帧变化槽位，并增量维护活跃集合与绘制上界。
   * 判定三条基向量的全部分量，旋转九十度的合法车辆不会被误判为零缩放。
   */
  commit(matrixDirty: boolean, colorDirty: boolean): void {
    if (!matrixDirty && !colorDirty) return
    if (matrixDirty) {
      for (const slot of this.matrixSlots) {
        const matrix = this.scratchMatrix.fromArray(this.instanceMatrix.array, slot * 16)
        const e = matrix.elements
        const visible = e[0] !== 0 || e[1] !== 0 || e[2] !== 0 || e[4] !== 0 || e[5] !== 0 || e[6] !== 0 || e[8] !== 0 || e[9] !== 0 || e[10] !== 0
        this.setVisibleAt(slot, visible)
        if (visible) {
          this.setMatrixAt(slot, matrix)
          this.activeSlots.add(slot)
          this.count = Math.max(this.count, slot + 1)
        } else this.activeSlots.delete(slot)
      }
      this.matrixSlots.clear()
      while (this.count > 0 && !this.activeSlots.has(this.count - 1)) this.count -= 1
      this.visible = this.activeSlots.size > 0
    }
    if (colorDirty && this.instanceColor !== null) {
      for (const slot of this.colorSlots) {
        this.scratchColor.fromArray(this.instanceColor.array, slot * 3)
        this.setColorAt(slot, this.scratchColor)
      }
      this.colorSlots.clear()
    }
  }

  /**
   * 每个绘制相机根据整车投影大小选择几何，所有精修部件共享相同尺寸口径。
   * 百分之十五滞回防止边界闪烁；主画面、倒影、阴影各自使用正确的相机。
   */
  override onBeforeRender(...args: Parameters<THREE.BatchedMesh['onBeforeRender']>): void {
    const [renderer, , camera] = args
    if (this.geometryIds.length > 1) {
      let levels = this.cameraLevels.get(camera)
      if (levels === undefined) {
        levels = new Uint8Array(this.instanceMatrix.count).fill(255)
        this.cameraLevels.set(camera, levels)
      }
      renderer.getSize(this.drawingSize)
      this.viewMatrix.multiplyMatrices(camera.matrixWorldInverse, this.matrixWorld)
      const view = this.viewMatrix.elements
      const positions = this.instanceMatrix.array
      const factor = this.drawingSize.y * Math.abs(camera.projectionMatrix.elements[5]) * 2.8 / 2
      for (const slot of this.activeSlots) {
        const offset = slot * 16
        const depth = -(view[2] * positions[offset + 12] + view[6] * positions[offset + 13] + view[10] * positions[offset + 14] + view[14])
        const pixels = camera instanceof THREE.PerspectiveCamera ? factor / Math.max(0.01, depth) : factor
        const previous = levels[slot]
        let level = pixels >= this.lodPixels[0] ? 0 : pixels >= this.lodPixels[1] ? 1 : 2
        if (previous !== 255 && level !== previous) {
          const boundary = this.lodPixels[level > previous ? previous : level]
          if (level > previous ? pixels > boundary * 0.85 : pixels < boundary * 1.15) level = previous
        }
        level = Math.min(level, this.geometryIds.length - 1)
        levels[slot] = level
        if (this.getGeometryIdAt(slot) !== this.geometryIds[level]) this.setGeometryIdAt(slot, this.geometryIds[level])
      }
    }
    super.onBeforeRender(...args)
  }

  /**
   * 使用精修部件的局部包围盒作为拾取代理，避免鼠标移动时扫描模型全部三角形。
   * 命中仍返回原业务槽位，距离按世界坐标计算，保持前后车辆排序和双击跟随。
   */
  override raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
    if (!this.visible || this.pickBounds.isEmpty()) return
    for (const slot of this.activeSlots) {
      this.scratchMatrix.fromArray(this.instanceMatrix.array, slot * 16).premultiply(this.matrixWorld)
      this.pickInverse.copy(this.scratchMatrix).invert()
      this.pickRay.copy(raycaster.ray).applyMatrix4(this.pickInverse)
      if (this.pickRay.intersectBox(this.pickBounds, this.pickPoint) === null) continue
      this.pickPoint.applyMatrix4(this.scratchMatrix)
      const distance = this.pickPoint.distanceTo(raycaster.ray.origin)
      if (distance < raycaster.near || distance > raycaster.far) continue
      intersects.push({ distance, point: this.pickPoint.clone(), object: this, batchId: slot, instanceId: slot })
    }
  }

  /**
   * 批次只释放自己的合批几何和矩阵、颜色纹理，原模型材质仍由资源所有者释放。
   * 严格模式可能重复清理，幂等保护避免释放已置空的批次纹理。
   */
  override dispose(): this {
    if (!this.disposed) { this.disposed = true; super.dispose() }
    return this
  }
}
