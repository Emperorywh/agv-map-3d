/**
 * 帧时间采样与迟滞控制 Hook（SPEC §6.5、§12.2「hooks/useAdaptiveQuality.ts —
 * 帧时间采样与迟滞控制」；TASK-014）。
 *
 * 职责：在唯一 Canvas 的帧循环内持续采样真实帧时间并喂入质量迟滞状态机——
 *       每帧把 R3F delta 换算为毫秒样本，累计单调帧时间作为裁决时钟；车队
 *       规模跨越 100 台阈值时切换目标帧率；等级跃迁写入低频质量 store 并记
 *       录结构化诊断指标（QUALITY_LEVEL_CHANGED）。
 * 边界：本 Hook 只产生「等级」这一低频输出，不直接修改任何渲染器状态或其
 *       他 Feature——能力开关映射归 app 组合层，DPR 由 RenderQualityFeature
 *       统一应用。auto=false 时完全旁路（不采样、不裁决、不改等级），供测
 *       试与性能基准锁定默认画质。
 * 关键不变量：
 * 1. 帧样本、平滑窗口、迟滞计时器全部保存在 ref 内的普通对象中，绝不进入
 *    React state 或 zustand（SPEC §4/§12.5）；进入 store 的只有等级跃迁；
 * 2. 裁决时钟是「累计帧时间」（每帧 += dt×1000），不读取真实墙钟——真实循
 *    环与测试渲染器的 advanceFrames 共用同一确定性语义；
 * 3. options 经 ref 透传：帧回调闭包恒定，读写 readVehicleCount/auto/
 *    diagnostics 的最新值不重建 useFrame 订阅；
 * 4. 状态机实例与组件生命周期一致：随挂载创建、随卸载丢弃，StrictMode 的
 *    setup→cleanup→setup 重建全新状态机（无跨挂载残留）。
 */
import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import type { DiagnosticsReporter } from '@/shared/diagnostics'
import {
  createQualityPolicy,
  targetFpsForVehicleCount,
} from '../model/qualityPolicy'
import { useRenderQualityStore } from '../model/renderQualityStore'

export interface UseAdaptiveQualityOptions {
  /** 车队规模读取器（app 注入运行时 count 的只读闭包）；每帧读取一次 */
  readVehicleCount: () => number
  /** 自动降级开关；false = 完全旁路（测试/基准锁定默认画质） */
  auto: boolean
  /** 结构化诊断通道（质量变化指标）；缺省不记录 */
  diagnostics?: DiagnosticsReporter
}

/** 质量等级变化的结构化诊断码（跨模块稳定合同） */
export const QUALITY_LEVEL_CHANGED_CODE = 'QUALITY_LEVEL_CHANGED'

export function useAdaptiveQuality(options: UseAdaptiveQualityOptions): void {
  // options 经 ref 透传（不变量 3）
  const optionsRef = useRef(options)
  optionsRef.current = options

  // 状态机与裁决时钟：ref 内普通对象，逐帧更新绝不触碰 React（不变量 1）
  const policyRef = useRef<ReturnType<typeof createQualityPolicy> | null>(null)
  if (policyRef.current === null) {
    policyRef.current = createQualityPolicy({
      targetFps: targetFpsForVehicleCount(options.readVehicleCount()),
    })
  }
  const nowRef = useRef(0)

  useFrame((_, delta) => {
    const policy = policyRef.current
    if (policy === null) {
      return
    }
    const { readVehicleCount, auto, diagnostics } = optionsRef.current
    // 车队规模 → 目标帧率：跨越 100 台阈值时切换预算（策略内部重置持续计时）
    const count = readVehicleCount()
    const fps = targetFpsForVehicleCount(count)
    if (policy.targetFps() !== fps) {
      policy.setTargetFps(fps)
    }
    if (!auto) {
      return
    }
    // 累计单调帧时间（不变量 2）；负 delta 视为时钟异常跳过
    const dtMs = delta * 1000
    if (!Number.isFinite(dtMs) || dtMs < 0) {
      return
    }
    nowRef.current += dtMs
    const decision = policy.pushSample(dtMs, nowRef.current)
    if (decision.changed) {
      // 等级跃迁：写低频 store（组合层经只读订阅映射能力开关）+ 诊断指标
      useRenderQualityStore.getState().setQualityLevel(decision.level)
      diagnostics?.report(
        QUALITY_LEVEL_CHANGED_CODE,
        'info',
        decision.direction === 'downgrade' ? '帧预算过载，质量降级一级' : '帧预算空裕，质量恢复一级',
        {
          from: decision.direction === 'downgrade' ? decision.level - 1 : decision.level + 1,
          to: decision.level,
          direction: decision.direction,
          avgFrameMs: Math.round(decision.avgFrameMs * 100) / 100,
          targetFps: decision.targetFps,
          vehicleCount: count,
        },
      )
    }
  })
}
