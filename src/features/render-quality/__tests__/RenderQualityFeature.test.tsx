/*
 * Canvas 内质量控制器测试（TASK-014 / SPEC §6.5、§12.3）。
 *
 * 以 @react-three/test-renderer 的合成帧序列驱动真实 useFrame 采样路径：
 * 1. auto=true 且帧时间持续过载 → 等级逐级下降并写入低频 store + 结构化诊断；
 * 2. 车队规模决定目标档位：30fps 档下 30ms 帧不降级，60fps 档同帧时间降级；
 * 3. auto=false 完全旁路：持续过载也保持 0 级（测试/基准锁定默认画质）；
 * 4. 4 级 DPR 上限降为 1：基准 = min(maxDpr, 设备像素比)，降级后 setDpr(1)；
 * 5. 组件渲染 null：场景内不产生任何对象。
 */
import { StrictMode } from 'react'
import { act } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import ReactThreeTestRenderer from '@react-three/test-renderer'
import { useThree } from '@react-three/fiber'
import { createDiagnosticsReporter, type DiagnosticRecord } from '@/shared/diagnostics'
import {
  RenderQualityFeature,
  QUALITY_LEVEL_CHANGED_CODE,
} from '@/features/render-quality'
import { useRenderQualityStore } from '@/features/render-quality/model/renderQualityStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type TestRenderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>

async function advance(renderer: TestRenderer, frames: number, delta: number): Promise<void> {
  await act(async () => {
    renderer.advanceFrames(frames, delta)
  })
}

/** DPR 探针：捕获 store 中的当前视口像素比（setDpr 的落地值） */
let probeDpr = 0
function DprProbe(): null {
  probeDpr = useThree((state) => state.viewport.dpr)
  return null
}

interface MountOptions {
  readVehicleCount: () => number
  maxDpr?: number
  auto?: boolean
}

async function mountQuality(
  options: MountOptions,
  strict = false,
): Promise<{
  renderer: TestRenderer
  records: DiagnosticRecord[]
  flushDiagnostics: () => void
}> {
  const records: DiagnosticRecord[] = []
  const diagnostics = createDiagnosticsReporter({ sink: (record) => records.push(record) })
  const tree = (
    <>
      <DprProbe />
      <RenderQualityFeature
        readVehicleCount={options.readVehicleCount}
        maxDpr={options.maxDpr}
        auto={options.auto}
        diagnostics={diagnostics}
      />
    </>
  )
  const renderer = await ReactThreeTestRenderer.create(
    strict ? <StrictMode>{tree}</StrictMode> : tree,
  )
  return { renderer, records, flushDiagnostics: () => diagnostics.flush() }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
  useRenderQualityStore.getState().setQualityLevel(0)
})

describe('RenderQualityFeature（TASK-014）', () => {
  it('合成帧序列持续过载：等级逐级降入 store 并记录诊断指标', async () => {
    const { renderer, records, flushDiagnostics } = await mountQuality({
      readVehicleCount: () => 0, // 60fps：预算 16.7ms
    })
    cleanups.push(() => renderer.unmount())
    // 50ms/帧 > 17.5ms：降级发生在累计 3s（60 帧）后，每 5s 一级
    // → 3s(61帧) 1 级、8s(161帧) 2 级、13s(261帧) 3 级
    await advance(renderer, 70, 0.05)
    expect(useRenderQualityStore.getState().qualityLevel).toBe(1)
    await advance(renderer, 200, 0.05) // 累计 13.5s
    expect(useRenderQualityStore.getState().qualityLevel).toBe(3)
    // 诊断受采样窗口合并：首条立即发出，窗口内两次变化合并补发一条
    flushDiagnostics()
    const changes = records.filter((r) => r.code === QUALITY_LEVEL_CHANGED_CODE)
    expect(changes.length).toBe(2)
    expect(changes[0].count).toBe(1)
    expect(changes[0].context.direction).toBe('downgrade')
    expect(changes[0].context.to).toBe(1)
    expect(changes[0].context.targetFps).toBe(60)
    expect(changes[1].count).toBe(2)
    expect(changes[1].context.to).toBe(3) // 合并条保留最新内容
  })

  it('车队规模切换目标档位：30fps 档下 30ms 帧不降级，60fps 档同帧时间降级', async () => {
    const large = await mountQuality({ readVehicleCount: () => 150 })
    cleanups.push(() => large.renderer.unmount())
    // 30fps 预算 33.3ms：30ms < 33.3×1.05=35 → 不降级
    await advance(large.renderer, 200, 0.03)
    expect(useRenderQualityStore.getState().qualityLevel).toBe(0)
    await large.renderer.unmount()
    cleanups.pop()

    const small = await mountQuality({ readVehicleCount: () => 10 })
    cleanups.push(() => small.renderer.unmount())
    // 60fps 预算 16.7ms：30ms > 17.5 → 约 3s（100 帧）后降级
    await advance(small.renderer, 110, 0.03)
    expect(useRenderQualityStore.getState().qualityLevel).toBe(1)
  })

  it('auto=false 完全旁路：持续过载保持 0 级（基准锁定默认画质）', async () => {
    const { renderer } = await mountQuality({
      readVehicleCount: () => 0,
      auto: false,
    })
    cleanups.push(() => renderer.unmount())
    await advance(renderer, 400, 0.05)
    expect(useRenderQualityStore.getState().qualityLevel).toBe(0)
  })

  it('4 级 DPR 上限降为 1：基准 min(maxDpr, 设备像素比)，降级后 setDpr(1)', async () => {
    const original = window.devicePixelRatio
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
    try {
      const { renderer } = await mountQuality({
        readVehicleCount: () => 0,
        maxDpr: 2,
      })
      cleanups.push(() => renderer.unmount())
      // 挂载即应用基准上限：min(2, 2) = 2
      expect(probeDpr).toBe(2)
      // 持续过载至 4 级（18s = 360 帧）：DPR 上限降为 1
      await advance(renderer, 380, 0.05)
      expect(useRenderQualityStore.getState().qualityLevel).toBe(4)
      expect(probeDpr).toBe(1)
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: original })
    }
  })

  it('渲染 null 且 StrictMode 双挂载无重复监听残留', async () => {
    const { renderer } = await mountQuality(
      { readVehicleCount: () => 0, maxDpr: 2 },
      true,
    )
    cleanups.push(() => renderer.unmount())
    expect(renderer.scene.children).toHaveLength(0)
    await advance(renderer, 10, 0.05)
    expect(useRenderQualityStore.getState().qualityLevel).toBe(0)
  })
})
