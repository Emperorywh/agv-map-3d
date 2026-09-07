/**
 * 每个资源代只为整个车队创建一套模型资源，加载期间先显示可运行的程序模型。
 * 异步完成时检查所属资源代是否仍存活，卸载和上下文恢复不会遗留旧模型。
 */
import { useEffect, useMemo, useState } from 'react'
import { createVehicleResources, type VehicleResources } from '../scene/createVehicleGeometry'
import { loadIndustrialVehicleModel } from '../scene/industrialVehicleModel'
import { loadShelfModel } from '@/shared/industrial/shelfModel'

export function useVehicleResources(generation: number): VehicleResources {
  const fallback = useMemo(() => { void generation; return createVehicleResources() }, [generation])
  const [loaded, setLoaded] = useState<{ generation: number; resources: VehicleResources } | null>(null)
  useEffect(() => () => fallback.dispose(), [fallback])
  /**
   * 精修资源提交后回收加载占位资源，避免首帧程序模型的 GPU 缓冲长期保留。
   * 资源换代换批次身份，由帧同步的全量重写机制回填，释放占位不影响后续渲染。
   */
  useEffect(() => {
    if (loaded?.generation === generation) fallback.dispose()
  }, [loaded, generation, fallback])
  useEffect(() => {
    let active = true
    let resources: VehicleResources | null = null
    /**
     * 车体与满载架独立加载，任一资源失败只影响自身，继续保留对应程序回退。
     * 两项完成后统一交接所有权，卸载后完成的资源立即释放，不遗留标签贴图。
     */
    void Promise.allSettled([loadIndustrialVehicleModel(), loadShelfModel('loaded')]).then(([vehicleResult, shelfResult]) => {
      const model = vehicleResult.status === 'fulfilled' ? vehicleResult.value : undefined
      const shelf = shelfResult.status === 'fulfilled' ? shelfResult.value : undefined
      if (!active) { model?.dispose(); shelf?.dispose(); return }
      if (vehicleResult.status === 'rejected') console.warn('工业 AGV 模型不可用，继续使用程序模型', vehicleResult.reason)
      if (shelfResult.status === 'rejected') console.warn('满载货架不可用，继续使用托盘纸箱', shelfResult.reason)
      /**
       * 资源构造成功才转移所有权，构造异常时回收已解析的原始模型。
       * 防止几何创建失败后留下尚未交给车队管理的内嵌贴图。
       */
      try { resources = createVehicleResources(model, shelf) }
      catch (error) { model?.dispose(); shelf?.dispose(); throw error }
      setLoaded({ generation, resources })
    }).catch((error: unknown) => {
      if (active) console.warn('工业 AGV 模型不可用，继续使用程序模型', error)
    })
    return () => { active = false; resources?.dispose() }
  }, [generation])
  return loaded?.generation === generation ? loaded.resources : fallback
}
