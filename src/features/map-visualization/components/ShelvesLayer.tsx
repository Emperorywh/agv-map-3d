/**
 * 地面空架与满载架按材质实例化，保留原模型尺寸、材质及阴影。
 * 布局、异步加载和释放绑定同一地图资源代，切图及上下文恢复时完整重建。
 */
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { WorldTransform } from '@/shared/spatial'
import { loadShelfModel, type ShelfModel, type ShelfVariant } from '@/shared/industrial/shelfModel'
import type { MapModel } from '../model/types'
import type { FactoryLayout } from '../model/factoryLayout'
import { buildShelfLayout } from '../scene/shelfLayout'
import { GROUND_SURFACE_Y } from '../scene/mapAppearance'
import { StaticLodBatch } from '@/shared/rendering/staticLodBatch'
import { useRenderQuality } from '@/shared/rendering/renderQuality'

export function ShelvesLayer({ mapModel, worldTransform, layout }: { mapModel: MapModel; worldTransform: WorldTransform; layout: FactoryLayout }) {
  const quality = useRenderQuality()
  const root = useRef<THREE.Group>(null)
  const placements = useMemo(() => buildShelfLayout(mapModel, worldTransform, layout), [mapModel, worldTransform, layout])
  useEffect(() => {
    const parent = root.current
    let active = true
    const models: ShelfModel[] = []
    const meshes: StaticLodBatch[] = []
    for (const variant of ['empty', 'loaded'] as const satisfies readonly ShelfVariant[]) {
      const positions = placements.filter((placement) => placement.variant === variant)
      if (positions.length === 0) continue
      void loadShelfModel(variant).then((model) => {
        if (!active) { model.dispose(); return }
        models.push(model)
        const matrix = new THREE.Matrix4()
        /**
         * 十二米网格让相邻库位共用批次，近景可先剔除屏幕外的整个库区。
         * 批内仍逐货架剔除并选择几何，避免一座可见货架带动全地图提交顶点。
         */
        const cells = new Map<string, typeof positions>()
        for (const placement of positions) {
          const key = `${Math.floor(placement.x / 12)}:${Math.floor(placement.z / 12)}`
          const cell = cells.get(key) ?? []
          cell.push(placement)
          cells.set(key, cell)
        }
        for (const [key, cell] of cells) {
          const matrices = new Float32Array(cell.length * 16)
          for (let index = 0; index < cell.length; index += 1) {
            const placement = cell[index]
            matrix.makeRotationY(placement.rotation).setPosition(placement.x, GROUND_SURFACE_Y, placement.z).toArray(matrices, index * 16)
          }
          for (const part of Object.values(model.parts)) {
            /**
             * 所有画质都提供三档几何，地面货架与车载货架共用辅助通道的最低档预算。
             * 高画质只在主画面保留原模型，阴影与倒影不再重复提交精修部件。
             */
            const levels = [part.geometry, ...(part.lodGeometries ?? [])]
            const mesh = new StaticLodBatch(levels, part.material, matrices, 1.8, quality.lodPixels)
            meshes.push(mesh)
            mesh.name = `map-shelves-${variant}-${part.material.name}-${key}`
            parent?.add(mesh)
          }
        }
      }).catch((error: unknown) => { if (active) console.warn(`地面货架加载失败：${variant}`, error) })
    }
    return () => {
      active = false
      for (const mesh of meshes) { parent?.remove(mesh); mesh.dispose() }
      for (const model of models) model.dispose()
    }
  }, [placements, quality])
  return <group ref={root} name="map-shelves" dispose={null} />
}
