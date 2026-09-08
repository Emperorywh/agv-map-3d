/**
 * 每个库区站点放置一个静态料箱，坐标沿用地图的世界变换，全部实例共享模型资源。
 * 加载和清理跟随地图及上下文资源代，异步完成时已卸载的模型立即释放。
 */
import { useEffect, useMemo, useRef } from 'react'
import type * as THREE from 'three'
import type { WorldTransform } from '@/shared/spatial'
import type { MapModel } from '../model/types'
import { loadMaterialBinModel } from '../scene/materialBinModel'
import { buildMaterialBinLayout } from '../scene/materialBinLayout'
import { createMaterialBinInstances } from '../scene/materialBinInstances'
import { useRenderQuality } from '@/shared/rendering/renderQuality'

export function MaterialBinLayer({ mapModel, worldTransform }: { mapModel: MapModel; worldTransform: WorldTransform }) {
  const root = useRef<THREE.Group>(null)
  const quality = useRenderQuality()
  const placements = useMemo(() => buildMaterialBinLayout(mapModel, worldTransform), [mapModel, worldTransform])
  useEffect(() => {
    if (placements.length === 0) return
    const parent = root.current
    let active = true
    let resource: Awaited<ReturnType<typeof loadMaterialBinModel>> | null = null
    let instances: ReturnType<typeof createMaterialBinInstances> | null = null
    void loadMaterialBinModel().then((loaded) => {
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
  }, [placements, quality])
  return <group ref={root} name="map-material-bin" dispose={null} />
}
