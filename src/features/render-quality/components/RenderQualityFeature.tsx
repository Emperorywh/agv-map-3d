/**
 * Canvas 内质量控制器（SPEC §12.2「components/RenderQualityFeature.tsx —
 * Canvas 内质量控制器」、§12.3「render-quality — 独立采样帧时间并输出质量等
 * 级，不直接修改其他 Feature 的状态」；TASK-014）。
 *
 * 职责：render-quality 的场景公开根组件——组合帧时间采样（useAdaptiveQuality）
 *       与 DPR 上限应用；渲染 null（质量只体现在渲染器行为，不产生场景对象
 *       或 DOM）。DPR 是本 Feature 直接拥有的渲染器能力：基准画质取
 *       config.renderer.maxDpr 与设备像素比的较小值，4 级降为 1（SPEC §6.5
 *       行动 4），经 R3F setDpr 生效（低频：受迟滞冷却约束）。
 * 边界：不触碰地图/车队/相机的任何对象；质量等级到各 Feature 能力开关的映
 *       射由 app 组合层完成（SPEC §12.3），本组件只输出等级与 DPR。
 * 关键不变量：
 * 1. 唯一 DPR 写入方：挂载期间 DPR 由本组件独占写入（组合层不得再设 Canvas
 *    dpr），卸载不恢复——Canvas 生命周期与场景一致，无需还原；
 * 2. auto=false：等级立即复位为 0 且采样旁路（测试/基准锁定默认画质）；
 *    auto 重新开启后由状态机从当前负载重新观察；
 * 3. 等级订阅是低频的：zustand selector 只在等级跃迁（≥5s 间隔）时触发本组
 *    件重渲染，帧样本永不进入 React（SPEC §4）；
 * 4. StrictMode 安全：全部副作用为幂等写入（setQualityLevel 同值 no-op、
 *    setDpr 同值幂等），setup→cleanup→setup 无监听残留。
 */
import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import type { DiagnosticsReporter } from '@/shared/diagnostics'
import { effectiveDprFor } from '../model/qualityPolicy'
import { useRenderQualityStore } from '../model/renderQualityStore'
import { useAdaptiveQuality } from '../hooks/useAdaptiveQuality'

export interface RenderQualityFeatureProps {
  /** 车队规模读取器（app 注入运行时 count 的只读闭包），决定目标帧率档位 */
  readVehicleCount: () => number
  /** 基准 DPR 上限（config.renderer.maxDpr）；缺省 2（R3F 默认上限） */
  maxDpr?: number
  /** 自动降级开关；默认 true；false = 锁定 0 级并旁路采样（测试/基准） */
  auto?: boolean
  /** 结构化诊断通道（质量变化指标）；缺省不记录 */
  diagnostics?: DiagnosticsReporter
}

export function RenderQualityFeature({
  readVehicleCount,
  maxDpr = 2,
  auto = true,
  diagnostics,
}: RenderQualityFeatureProps) {
  const setDpr = useThree((state) => state.setDpr)

  // 采样与迟滞裁决：auto=false 时 Hook 内部完全旁路
  useAdaptiveQuality({ readVehicleCount, auto, diagnostics })

  // 低频等级订阅：仅在等级跃迁时重渲染并重算 DPR（不变量 3）
  const level = useRenderQualityStore((state) => state.qualityLevel)

  // auto=false 即锁定 0 级（幂等写入）：基准/测试的确定性保证（不变量 2）
  useEffect(() => {
    if (!auto) {
      useRenderQualityStore.getState().setQualityLevel(0)
    }
  }, [auto])

  // DPR 上限应用：基准 = min(maxDpr, 设备像素比)，4 级降为 1（不变量 1）
  useEffect(() => {
    setDpr(effectiveDprFor(level, maxDpr, window.devicePixelRatio))
  }, [setDpr, level, maxDpr])

  return null
}
