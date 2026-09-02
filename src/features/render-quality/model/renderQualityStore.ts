/**
 * 当前质量等级低频 Store（SPEC §12.2「model/renderQualityStore.ts — 当前质量
 * 等级低频状态」；TASK-014）。
 *
 * 职责：以独立 zustand store 持有自适应质量控制的唯一低频输出——当前质量等
 *       级（0～4）。写入只发生在等级跃迁时刻，由迟滞策略保证两次写入间隔至
 *       少 5s（降级）或 30s（恢复），因此任何订阅者都不会被高频打扰。
 * 边界：本 store 是 Feature 内部状态，不经 Feature 公开入口导出可写引用——
 *       外部只经 useQualityLevel / subscribeQualityLevel 只读消费；帧样本、
 *       平滑窗口与迟滞计时器绝不进入本 store（SPEC §4：高频数据不进 React/
 *       zustand）。跨 Feature 协作（能力开关映射）由 app 组合层经本只读视图
 *       完成，其他 Feature 不感知本 store。
 * 关键不变量：
 * 1. 写入幂等：等级未变化时重复写入是 no-op，低频订阅者不被无变化通知打扰；
 * 2. 唯一写入方是 render-quality 内部的自适应 Hook；等级只能落在 [0, 4] 区间
 *    内由策略钳制，本 store 不做二次裁决（纵深防御由类型与策略共同保证）。
 */
import { create } from 'zustand'
import { QUALITY_LEVEL_MAX, QUALITY_LEVEL_MIN, type QualityLevel } from './qualityPolicy'

export interface RenderQualityState {
  /** 当前质量等级；0 完整画质，4 最低画质 */
  qualityLevel: QualityLevel
  /**
   * 等级跃迁写入（幂等）；仅 render-quality 内部自适应 Hook 调用。入参放宽
   * 为 number 并在写入前钳制进 [0, 4]——本 store 是运行时写边界，防御越界。
   */
  setQualityLevel: (level: number) => void
}

export const useRenderQualityStore = create<RenderQualityState>((set, get) => ({
  qualityLevel: QUALITY_LEVEL_MIN,
  setQualityLevel: (level) => {
    // 钳制进合法区间（纵深防御），同值写入为 no-op
    const safe = (
      level < QUALITY_LEVEL_MIN
        ? QUALITY_LEVEL_MIN
        : level > QUALITY_LEVEL_MAX
          ? QUALITY_LEVEL_MAX
          : level
    ) as QualityLevel
    if (get().qualityLevel !== safe) {
      set({ qualityLevel: safe })
    }
  },
}))
