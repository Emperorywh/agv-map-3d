/**
 * 全部库区料箱共享一份已校准资产，按材质合批并逐实例剔除不可见节点。
 * 三档均由资产加载器提供，近景保留原模型，中远景使用包含低面数托盘的派生资产。
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { StaticLodBatch } from '@/shared/rendering/staticLodBatch'
import type { MaterialBinPlacement } from './materialBinLayout'
import { GROUND_SURFACE_Y } from './mapAppearance'

export function createMaterialBinInstances(model: THREE.Group, placements: readonly MaterialBinPlacement[], lodPixels: readonly [number, number], lodGroups: readonly THREE.Group[] = []) {
  const group = new THREE.Group()
  const batches: StaticLodBatch[] = []
  const geometries = new Set<THREE.BufferGeometry>()
  const models = [model, ...lodGroups]
  const parts = new Map<string, { material: THREE.Material; levels: THREE.BufferGeometry[][] }>()
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    group.clear()
    for (const batch of batches) batch.dispose()
  }
  /**
   * 模型导出层级包含镜像缩放，烘焙到几何后需要同步翻转三角形绕序。
   * 保留顶点法线和 UV，避免批量渲染时外表面被背面剔除或托盘贴图翻面。
   */
  const bake = (geometry: THREE.BufferGeometry, matrix: THREE.Matrix4) => {
    geometries.add(geometry)
    geometry.applyMatrix4(matrix)
    if (matrix.determinant() < 0) {
      const index = geometry.getIndex()!
      for (let offset = 0; offset < index.count; offset += 3) {
        const first = index.getX(offset)
        index.setX(offset, index.getX(offset + 2))
        index.setX(offset + 2, first)
      }
    }
    return geometry
  }
  try {
    /**
     * 按材质名匹配离线导出的三档几何，所有档位复用原模型材质与贴图。
     * 每档烘焙同一归一化变换，镜像层级的三角形绕序仍由统一入口修正。
     */
    for (const [level, current] of models.entries()) {
      current.updateMatrixWorld(true)
      current.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return
        if (object instanceof THREE.SkinnedMesh || Array.isArray(object.material) || object.geometry.index === null) throw new Error('料箱需要带索引的静态单材质子网格')
        const part = parts.get(object.material.name) ?? { material: object.material, levels: models.map<THREE.BufferGeometry[]>(() => []) }
        part.levels[level].push(bake(object.geometry.clone(), object.matrixWorld))
        parts.set(object.material.name, part)
      })
    }
    const matrices = new Float32Array(placements.length * 16)
    const matrix = new THREE.Matrix4()
    for (let index = 0; index < placements.length; index += 1) {
      const placement = placements[index]
      matrix.makeRotationY(placement.rotation).setPosition(placement.x, GROUND_SURFACE_Y, placement.z).toArray(matrices, index * 16)
    }
    for (const part of parts.values()) {
      const { material } = part
      const levels = part.levels.map((pieces) => {
        if (pieces.length === 0) throw new Error('料箱低模缺少材质分区')
        const geometry = mergeGeometries(pieces, false)
        if (geometry === null) throw new Error('料箱模型顶点属性不兼容')
        geometries.add(geometry)
        return geometry
      })
      const batch = new StaticLodBatch(levels, material, matrices, 1.8, lodPixels)
      batches.push(batch)
      batch.name = `map-material-bin-${material.name}`
      batch.sortObjects = material.transparent
      /**
       * 胶带只是纸箱表面的透明装饰，箱体与托盘已经提供完整实体阴影。
       * 透明胶带不再单独投影，避免每个库位增加一份重复的深度绘制。
       */
      batch.castShadow = !material.transparent
      group.add(batch)
    }
    group.userData.nodeIds = placements.map((placement) => placement.nodeId)
    return { group, dispose }
  } catch (error) {
    dispose()
    throw error
  } finally {
    /**
     * 合批已复制几何数据，临时烘焙副本和合并结果在装配结束后立即释放。
     * 原始材质与贴图仍归模型加载句柄所有，由图层在卸载时统一清理。
     */
    for (const geometry of geometries) geometry.dispose()
  }
}
