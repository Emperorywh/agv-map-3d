/**
 * 质量等级只读视图（SPEC §12.3「render-quality — 只读质量状态、能力开关和根
 * 组件」；TASK-014）。
 *
 * 职责：向 app 组合层暴露当前质量等级的只读消费面——React 组件经
 *       useQualityLevel 精确订阅，非 React 协作经 subscribeQualityLevel 订阅
 *       跃迁。内部 zustand store 与写入口绝不外露。
 * 边界：只读。写入只发生在 render-quality 内部自适应 Hook 的等级跃迁路径；
 *       其他 Feature 不得（也无法）直接改写质量等级。
 * 关键不变量：
 * 1. useQualityLevel 是精确 selector 订阅：仅等级跃迁（受迟滞冷却约束的低频
 *    事件）触发订阅组件重渲染；
 * 2. subscribeQualityLevel 返回对称退订函数，登记时立即以当前等级回调一次，
 *    保证订阅方无需再读初始值即可建立一致视图。
 */
import { useRenderQualityStore } from '../model/renderQualityStore'
import type { QualityLevel } from '../model/qualityPolicy'

/** 当前质量等级的 React 订阅（精确 selector，低频跃迁才重渲染） */
export function useQualityLevel(): QualityLevel {
  return useRenderQualityStore((state) => state.qualityLevel)
}

/**
 * 非 React 的等级跃迁订阅：登记时立即以当前等级回调一次，此后每次跃迁回调；
 * 返回对称退订函数。
 */
export function subscribeQualityLevel(
  listener: (level: QualityLevel) => void,
): () => void {
  listener(useRenderQualityStore.getState().qualityLevel)
  return useRenderQualityStore.subscribe((state) => {
    listener(state.qualityLevel)
  })
}
