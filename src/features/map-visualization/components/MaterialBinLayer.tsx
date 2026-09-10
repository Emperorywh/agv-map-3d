/**
 * 每个库区站点放置一个静态资产，按连通区域分别复用托盘或三层货架模型。
 * 加载和清理跟随地图及上下文资源代，异步完成时已卸载的模型立即释放。
 */
import { useEffect, useMemo, useRef } from 'react'
import type * as THREE from 'three'
import type { WorldTransform } from '@/shared/spatial'
import type { MapModel } from '../model/types'
import { loadMaterialBinModel } from '../scene/materialBinModel'
import { buildMaterialBinLayout, type MaterialBinPlacement, type MaterialBinVariant } from '../scene/materialBinLayout'
import { createMaterialBinInstances } from '../scene/materialBinInstances'
import { useRenderQuality } from '@/shared/rendering/renderQuality'

export function MaterialBinLayer({ mapModel, worldTransform }: { mapModel: MapModel; worldTransform: WorldTransform }) {
  /**
   * 按资产类型拆成两个互斥实例集合，每个库位只出现在其中一组。
   * 分组随地图变更重建，区域模型独立加载和释放，不影响其他库位显示。
   */
  const placements = useMemo(() => {
    const groups: Record<MaterialBinVariant, MaterialBinPlacement[]> = { pallet: [], rack: [] }
    for (const placement of buildMaterialBinLayout(mapModel, worldTransform)) groups[placement.variant].push(placement)
    return groups
  }, [mapModel, worldTransform])
  return <group name="map-material-bin" dispose={null}>
    <MaterialBinGroup variant="pallet" placements={placements.pallet} />
    <MaterialBinGroup variant="rack" placements={placements.rack} />
  </group>
}

/**
 * 每种模型单独沿用原有合批、异步取消和卸载清理逻辑。
 * 货架只有一个几何档位，距离变化时始终保留货架外观。
 */
function MaterialBinGroup({ variant, placements }: { variant: MaterialBinVariant; placements: readonly MaterialBinPlacement[] }) {
  const root = useRef<THREE.Group>(null)
  const quality = useRenderQuality()
  useEffect(() => {
    if (placements.length === 0) return
    const parent = root.current
    let active = true
    let resource: Awaited<ReturnType<typeof loadMaterialBinModel>> | null = null
    let instances: ReturnType<typeof createMaterialBinInstances> | null = null
    void loadMaterialBinModel(variant).then((loaded) => {
      if (!active) { loaded.dispose(); return }
      try {
        /**
         * 料箱与车体、设施共用投影阈值，取消三分之一阈值导致的过早高模切换。
         * 全档位装配低模供阴影与倒影使用，高画质主画面仍按自己的阈值选档。
         */
        instances = createMaterialBinInstances(loaded.group, placements, quality.lodPixels, loaded.lodGroups)
        resource = loaded
        parent?.add(instances.group)
      } catch (error) {
        loaded.dispose()
        throw error
      }
    }).catch((error: unknown) => { if (active) console.warn('库区站点料箱加载失败', error) })
    return () => {
      active = false
      if (instances !== null) parent?.remove(instances.group)
      instances?.dispose()
      resource?.dispose()
    }
  }, [placements, quality, variant])
  return <group ref={root} name={`map-material-bin-${variant}`} dispose={null} />
}
