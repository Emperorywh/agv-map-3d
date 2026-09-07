/**
 * 静态设施每种材质合批，实例按当前绘制相机剔除并选择中远景几何。
 * 原始几何由资产所有者释放；批次仅持有合批副本和自己的数据纹理。
 */
import * as THREE from 'three'
import { ProjectedLod } from './projectedLod'

export class StaticLodBatch extends THREE.BatchedMesh {
  private readonly geometryIds: number[]
  private readonly placements: Float32Array
  private readonly lod: ProjectedLod
  private disposed = false

  constructor(levels: readonly THREE.BufferGeometry[], material: THREE.Material, placements: Float32Array, diameter: number, thresholds: readonly [number, number]) {
    super(placements.length / 16, levels.reduce((sum, geometry) => sum + geometry.getAttribute('position').count, 0), levels.reduce((sum, geometry) => sum + (geometry.index?.count ?? 0), 0), material)
    this.placements = placements
    this.lod = new ProjectedLod(placements.length / 16, diameter, thresholds)
    this.geometryIds = levels.map((geometry) => this.addGeometry(geometry))
    const matrix = new THREE.Matrix4()
    for (let offset = 0; offset < placements.length; offset += 16) this.setMatrixAt(this.addInstance(this.geometryIds[0]), matrix.fromArray(placements, offset))
    /**
     * 不透明设施不做逐部件深度排序，减少每个通道反复排序的 CPU 成本。
     * 整批包围球提供粗筛，批内视锥剔除继续排除画面之外的设施。
     */
    this.sortObjects = false
    this.perObjectFrustumCulled = true
    this.castShadow = true
    this.receiveShadow = true
    this.matrixAutoUpdate = false
    this.raycast = () => {}
    this.computeBoundingSphere()
  }

  override onBeforeRender(...args: Parameters<THREE.BatchedMesh['onBeforeRender']>): void {
    if (this.geometryIds.length > 1) {
      this.lod.prepare(args[0], args[2], this.matrixWorld, args[4])
      for (let slot = 0; slot < this.placements.length / 16; slot += 1) {
        const offset = slot * 16
        const level = Math.min(this.lod.select(slot, this.placements[offset + 12], this.placements[offset + 13], this.placements[offset + 14]), this.geometryIds.length - 1)
        if (this.getGeometryIdAt(slot) !== this.geometryIds[level]) this.setGeometryIdAt(slot, this.geometryIds[level])
      }
    }
    super.onBeforeRender(...args)
  }

  /**
   * 严格模式与资源恢复可能重复触发清理，避免再次释放已经置空的批次纹理。
   * 材质和源几何继续归加载句柄所有，不在批次中重复释放。
   */
  override dispose(): this {
    if (!this.disposed) { this.disposed = true; super.dispose() }
    return this
  }
}
