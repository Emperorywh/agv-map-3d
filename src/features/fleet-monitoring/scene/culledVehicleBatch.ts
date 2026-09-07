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
  private disposed = false

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number) {
    /**
     * 尚未加载的精修部件只有空几何，以零顶点占位建立稳定槽位。
     * 每种真实几何只拷贝一次，不改变顶点、法线、索引或材质参数。
     */
    const empty = new THREE.BufferGeometry()
    empty.setAttribute('position', new THREE.Float32BufferAttribute([], 3))
    const source = geometry.hasAttribute('position') ? geometry : empty
    super(capacity, source.getAttribute('position').count, source.index?.count ?? 0, material)
    const geometryId = this.addGeometry(source)
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
  }

  /**
   * 只在原有脏帧提交矩阵和颜色，固定槽号不会随相机筛选或绘制排序改变。
   * 零缩放直接标为不可绘制，从提交列表移除，避免不可见部件仍执行顶点着色器。
   */
  commit(matrixDirty: boolean, colorDirty: boolean): void {
    if (!matrixDirty && !colorDirty) return
    for (let slot = 0; slot < this.instanceMatrix.count; slot += 1) {
      if (matrixDirty) {
        const matrix = this.scratchMatrix.fromArray(this.instanceMatrix.array, slot * 16)
        const e = matrix.elements
        const visible = e[0] !== 0 || e[5] !== 0 || e[10] !== 0
        this.setVisibleAt(slot, visible)
        if (visible) this.setMatrixAt(slot, matrix)
      }
      if (colorDirty && this.instanceColor !== null) {
        this.scratchColor.fromArray(this.instanceColor.array, slot * 3)
        this.setColorAt(slot, this.scratchColor)
      }
    }
  }

  /**
   * 多绘制拾取结果的批内编号对应原业务槽位，转换为原交互接口的 instanceId。
   * 悬停、单击、双击跟随和标签继续使用同一槽位表，不受剔除顺序影响。
   */
  override raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
    const start = intersects.length
    super.raycast(raycaster, intersects)
    for (let index = start; index < intersects.length; index += 1) {
      intersects[index].instanceId = intersects[index].batchId
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
