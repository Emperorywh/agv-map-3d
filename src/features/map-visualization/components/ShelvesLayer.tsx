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

export function ShelvesLayer({ mapModel, worldTransform, layout }: { mapModel: MapModel; worldTransform: WorldTransform; layout: FactoryLayout }) {
  const root = useRef<THREE.Group>(null)
  const placements = useMemo(() => buildShelfLayout(mapModel, worldTransform, layout), [mapModel, worldTransform, layout])
  useEffect(() => {
    const parent = root.current
    let active = true
    const models: ShelfModel[] = []
    const meshes: THREE.InstancedMesh[] = []
    for (const variant of ['empty', 'loaded'] as const satisfies readonly ShelfVariant[]) {
      const positions = placements.filter((placement) => placement.variant === variant)
      if (positions.length === 0) continue
      void loadShelfModel(variant).then((model) => {
        if (!active) { model.dispose(); return }
        models.push(model)
        const matrix = new THREE.Matrix4()
        for (const part of Object.values(model.parts)) {
          const mesh = new THREE.InstancedMesh(part.geometry, part.material, positions.length)
          meshes.push(mesh)
          mesh.name = `map-shelves-${variant}-${part.material.name}`
          mesh.castShadow = true
          mesh.receiveShadow = true
          mesh.raycast = () => {}
          for (let index = 0; index < positions.length; index += 1) {
            const placement = positions[index]
            matrix.makeRotationY(placement.rotation).setPosition(placement.x, GROUND_SURFACE_Y, placement.z)
            mesh.setMatrixAt(index, matrix)
          }
          mesh.computeBoundingSphere()
          parent?.add(mesh)
        }
      }).catch((error: unknown) => { if (active) console.warn(`地面货架加载失败：${variant}`, error) })
    }
    return () => {
      active = false
      for (const mesh of meshes) { parent?.remove(mesh); mesh.dispose() }
      for (const model of models) model.dispose()
    }
  }, [placements])
  return <group ref={root} name="map-shelves" dispose={null} />
}
