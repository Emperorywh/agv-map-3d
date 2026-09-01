/**
 * 地图名称图集生命周期 Hook（SPEC §5.1、§7.2、§12.5；TASK-005）。
 *
 * 职责：以当前生效视图的 MapModel 为输入，收集全部地图名称条目并经注入的
 *       工厂构建名称图集（Canvas 栅格化），管理其创建、失败降级与对称释放，
 *       向图层组件提供唯一的共享图集引用。
 * 边界：本 Hook 只管理图集资源，不创建几何、不上载 GPU 数据；工厂默认为
 *       createMapNameAtlas（真实 Canvas），测试可注入替身；工厂抛出的稳定
 *       错误（如无 Canvas 2D 上下文）被降级为 null 并记录结构化诊断——名称
 *       缺失不阻断地图其余内容（SPEC §11.12 隔离精神）。
 * 关键不变量：
 * 1. 图集单一所有者：同一视图内所有图层共享同一实例；更换视图（MapModel
 *    变化）或卸载时旧图集在其 effect 清理中被释放，无跨视图泄漏；
 * 2. StrictMode 安全：effect 的 setup→cleanup→setup 表现为「创建→释放→重建」，
 *    提前卸载时立即释放刚创建的实例，任何时刻场景引用的图集都是有效的；
 * 3. 失败只降级名称：工厂抛错时视图、地标与外沿图层照常渲染；
 * 4. 注入通道优先；未注入 diagnostics 时使用仅创建一次的默认通道（引用稳定）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createDiagnosticsReporter,
  describeError,
  type DiagnosticsReporter,
} from '@/shared/diagnostics'
import type { MapModel } from '../model/types'
import {
  collectMapNameLabels,
  createMapNameAtlas,
  type MapNameAtlas,
  type MapNameLabelSpec,
} from '../scene/mapNameAtlas'

/** 图集工厂合同：默认真实 Canvas 工厂；测试注入替身 */
export type MapNameAtlasFactory = typeof createMapNameAtlas

export interface UseMapNameAtlasOptions {
  /** 图集工厂注入点；默认 createMapNameAtlas */
  factory?: MapNameAtlasFactory
  /** 结构化诊断通道；默认创建独立通道 */
  diagnostics?: DiagnosticsReporter
}

/**
 * 管理地图名称图集：MapModel 变化时重建，卸载/替换时释放；失败降级为 null。
 */
export function useMapNameAtlas(
  mapModel: MapModel | null,
  options: UseMapNameAtlasOptions = {},
): MapNameAtlas | null {
  const factory = options.factory ?? createMapNameAtlas
  const fallbackDiagnosticsRef = useRef<DiagnosticsReporter | null>(null)
  if (fallbackDiagnosticsRef.current === null) {
    fallbackDiagnosticsRef.current = createDiagnosticsReporter()
  }
  const diagnostics = options.diagnostics ?? fallbackDiagnosticsRef.current

  // 名称条目随 MapModel 派生：同一视图（冻结模型）下引用稳定，不重复收集
  const labels = useMemo<readonly MapNameLabelSpec[] | null>(
    () => (mapModel !== null ? collectMapNameLabels(mapModel) : null),
    [mapModel],
  )

  const [atlas, setAtlas] = useState<MapNameAtlas | null>(null)

  useEffect(() => {
    if (labels === null) {
      setAtlas(null)
      return
    }
    try {
      const created = factory(labels)
      setAtlas(created)
      return () => {
        created.dispose()
      }
    } catch (error) {
      // 图集创建失败（如无 Canvas 2D）：降级为无名称，记录诊断后继续
      diagnostics.report('MAP_NAME_ATLAS_FAILED', 'warn', '地图名称图集创建失败，名称图层降级为不显示', {
        reason: describeError(error),
        labelCount: labels.length,
      })
      setAtlas(null)
    }
  }, [labels, factory, diagnostics])

  return atlas
}
