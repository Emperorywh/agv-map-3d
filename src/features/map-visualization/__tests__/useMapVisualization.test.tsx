/*
 * 地图场景生命周期 Hook 测试（与实现共置；TASK-004）。
 *
 * 职责：以注入的 loadMap 桩覆盖场景侧地图生命周期的全部合同：
 * 1. bootstrap 种子直接建模（不重复拉取）；
 * 2. 无种子时网络加载成功产出视图；
 * 3. 首次失败保持清屏（无视图），指数退避自动重试直至成功；
 * 4. 已有场景时刷新失败保留旧场景，恢复后原子替换并释放旧几何；
 * 5. 卸载/描述符变化取消进行中的加载与重试；
 * 6. StrictMode 双执行幂等。
 */
import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDiagnosticsReporter,
  type DiagnosticRecord,
} from '@/shared/diagnostics'
import { IDENTITY_AFFINE } from '@/shared/spatial'
import { createMapModel } from '@/features/map-visualization/model/createMapModel'
import { validateMap } from '@/features/map-visualization/model/validateMap'
import {
  useMapVisualization,
  type MapViewDescriptor,
  type MapViewSeed,
} from '@/features/map-visualization/hooks/useMapVisualization'
import type { LoadMapOptions, LoadMapResult } from '@/features/map-visualization/services/loadMap'
import { makeLineEdge, makeNode } from './fixtures'

afterEach(() => {
  vi.useRealTimers()
})

/** 微任务冲刷：让当前挂起的 Promise 链（加载成功/失败）走完 */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function buildModel(nodeX: number): ReturnType<typeof createMapModel> {
  return createMapModel(
    validateMap({
      nodes: [
        makeNode({ id: 'a', name: 'A', x: nodeX, y: 0 }),
        makeNode({ id: 'b', name: 'B', x: nodeX + 3, y: 4 }),
      ],
      edges: [makeLineEdge({ id: 'e1', snodeId: 'a', enodeId: 'b', sx: nodeX, sy: 0, ex: nodeX + 3, ey: 4 })],
      zones: [],
      nodeEdgeGroups: [],
    }),
  )
}

function stubResult(model = buildModel(0)): LoadMapResult {
  return { mapModel: model.mapModel, worldTransform: model.worldTransform, url: 'http://t/map.json', anomalies: [] }
}

function makeDescriptor(mapUrl: string, seed?: MapViewSeed): MapViewDescriptor {
  const base: MapViewDescriptor = { mapUrl, coordinateTransform: IDENTITY_AFFINE }
  return seed === undefined ? base : { ...base, initial: seed }
}

function makeRecorder() {
  const records: DiagnosticRecord[] = []
  const diagnostics = createDiagnosticsReporter({ sink: (record) => records.push(record) })
  return { records, diagnostics }
}

describe('useMapVisualization：种子与加载', () => {
  it('携带 bootstrap 种子时直接建模产出视图，不重复发起加载', () => {
    const loadMapImpl = vi.fn()
    const { mapModel, worldTransform } = buildModel(0)
    const { result } = renderHook(
      () =>
        useMapVisualization(makeDescriptor('http://t/map.json', { mapModel, worldTransform }), {
          loadMapImpl,
        }),
    )
    expect(result.current.view).not.toBeNull()
    expect(result.current.view!.version).toBe(1)
    expect(result.current.view!.sourceUrl).toBe('http://t/map.json')
    expect(result.current.view!.mapModel).toBe(mapModel)
    expect(result.current.view!.geometry.nodeInstances.count).toBe(2)
    expect(result.current.reloading).toBe(false)
    expect(loadMapImpl).not.toHaveBeenCalled()
  })

  it('无种子时经 loadMap 加载成功产出视图', async () => {
    const loadMapImpl = vi.fn(async (_options: LoadMapOptions) => stubResult())
    const { result } = renderHook(() => useMapVisualization(makeDescriptor('http://t/map.json'), { loadMapImpl }))
    await flushMicrotasks()
    expect(result.current.view).not.toBeNull()
    expect(result.current.reloading).toBe(false)
    expect(loadMapImpl).toHaveBeenCalledTimes(1)
    expect(loadMapImpl).toHaveBeenCalledWith(
      expect.objectContaining({ mapUrl: 'http://t/map.json' }),
    )
  })

  it('StrictMode 双执行幂等：种子只建模一次、版本不重复递增', () => {
    const loadMapImpl = vi.fn()
    const { mapModel, worldTransform } = buildModel(0)
    const { result } = renderHook(
      () => useMapVisualization(makeDescriptor('http://t/map.json', { mapModel, worldTransform }), { loadMapImpl }),
      { wrapper: StrictMode },
    )
    expect(result.current.view).not.toBeNull()
    expect(result.current.view!.version).toBe(1)
    expect(loadMapImpl).not.toHaveBeenCalled()
  })
})

describe('useMapVisualization：失败重试与恢复', () => {
  it('首次失败保持无视图（清屏色），按指数退避自动重试直至成功', async () => {
    vi.useFakeTimers()
    const { records, diagnostics } = makeRecorder()
    const loadMapImpl = vi.fn(async () => stubResult())
    loadMapImpl.mockImplementationOnce(async () => {
      throw new Error('network down')
    })
    const { result } = renderHook(() =>
      useMapVisualization(makeDescriptor('http://t/map.json'), { loadMapImpl, diagnostics }),
    )

    await flushMicrotasks()
    // 首次失败：尚无有效场景 → 保持清屏色（无视图），已记录重试诊断
    expect(result.current.view).toBeNull()
    expect(result.current.reloading).toBe(true)
    const firstRetry = records.find((record) => record.code === 'MAP_SCENE_LOAD_RETRY')
    expect(firstRetry).toBeDefined()
    expect(firstRetry!.context.attempt).toBe(1)
    expect(firstRetry!.context.delayMs).toBe(1000)

    // 退避 1s 后第二次尝试成功
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(result.current.view).not.toBeNull()
    expect(result.current.reloading).toBe(false)
    expect(loadMapImpl).toHaveBeenCalledTimes(2)
    expect(records.some((record) => record.code === 'MAP_SCENE_RECOVERED')).toBe(true)
  })

  it('退避间隔逐次翻倍且封顶 30s', async () => {
    vi.useFakeTimers()
    const { records, diagnostics } = makeRecorder()
    const loadMapImpl = vi.fn(async () => {
      throw new Error('still down')
    })
    renderHook(() => useMapVisualization(makeDescriptor('http://t/map.json'), { loadMapImpl, diagnostics }))

    await flushMicrotasks()
    // 首次尝试已由 flushMicrotasks 触发；其后每次推进触发下一次尝试
    const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000, 30000]
    for (let i = 1; i < expectedDelays.length; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(expectedDelays[i - 1])
      })
    }
    const retries = records.filter((record) => record.code === 'MAP_SCENE_LOAD_RETRY')
    expect(retries).toHaveLength(expectedDelays.length)
    expect(retries.map((record) => record.context.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(retries.map((record) => record.context.delayMs)).toEqual(expectedDelays)
  })

  it('已有场景时刷新失败保留旧场景；恢复后原子替换并释放旧几何', async () => {
    vi.useFakeTimers()
    const { diagnostics } = makeRecorder()
    const oldModel = buildModel(0)
    const newModel = buildModel(100)
    const loadMapImpl = vi.fn(async () => stubResult(newModel))
    // 第一次刷新尝试失败，第二次成功
    loadMapImpl.mockImplementationOnce(async () => {
      throw new Error('refresh failed')
    })

    const { result, rerender } = renderHook(
      (props: { descriptor: MapViewDescriptor }) =>
        useMapVisualization(props.descriptor, { loadMapImpl, diagnostics }),
      {
        initialProps: {
          descriptor: makeDescriptor('http://t/map.json', {
            mapModel: oldModel.mapModel,
            worldTransform: oldModel.worldTransform,
          }),
        },
      },
    )
    const oldView = result.current.view!
    expect(oldView.version).toBe(1)
    const disposeSpy = vi.spyOn(oldView.geometry, 'dispose')

    // mapUrl 变化触发刷新；第一次尝试失败 → 旧场景原样保留
    await rerender({ descriptor: makeDescriptor('http://t/map2.json') })
    await flushMicrotasks()
    expect(result.current.view).toBe(oldView)
    expect(result.current.view!.version).toBe(1)
    expect(result.current.reloading).toBe(true)
    expect(disposeSpy).not.toHaveBeenCalled()

    // 退避后恢复成功 → 原子替换为新视图，旧几何在提交后释放
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    const newView = result.current.view!
    expect(newView).not.toBe(oldView)
    expect(newView.version).toBe(2)
    expect(newView.sourceUrl).toBe('http://t/map2.json')
    expect(newView.mapModel).toBe(newModel.mapModel)
    expect(newView.geometry).not.toBe(oldView.geometry)
    // 新视图提交渲染后，旧几何的所有权 effect 已释放它
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('卸载取消进行中的加载与重试计时器', async () => {
    vi.useFakeTimers()
    const { diagnostics } = makeRecorder()
    const loadMapImpl = vi.fn(async () => {
      throw new Error('down')
    })
    const { unmount } = renderHook(() =>
      useMapVisualization(makeDescriptor('http://t/map.json'), { loadMapImpl, diagnostics }),
    )
    await flushMicrotasks()
    expect(loadMapImpl).toHaveBeenCalledTimes(1)
    unmount()
    // 卸载后重试计时器被清理：长时间推进不再产生新尝试
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000)
    })
    expect(loadMapImpl).toHaveBeenCalledTimes(1)
  })

  it('描述符置空清空视图并释放几何', async () => {
    const loadMapImpl = vi.fn()
    const { mapModel, worldTransform } = buildModel(0)
    const { result, rerender } = renderHook(
      (props: { descriptor: MapViewDescriptor | null }) =>
        useMapVisualization(props.descriptor, { loadMapImpl }),
      {
        initialProps: {
          descriptor: makeDescriptor('http://t/map.json', { mapModel, worldTransform }),
        } as { descriptor: MapViewDescriptor | null },
      },
    )
    const oldView = result.current.view!
    const disposeSpy = vi.spyOn(oldView.geometry, 'dispose')
    await rerender({ descriptor: null })
    expect(result.current.view).toBeNull()
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('取消信号随加载传递；竞态完成的结果被丢弃', async () => {
    vi.useFakeTimers()
    let capturedSignal: AbortSignal | null = null
    const loadMapImpl = vi.fn(async (options: { signal?: AbortSignal }) => {
      capturedSignal = options.signal ?? null
      // 挂起直到被取消后以 AbortError 拒绝（模拟真实 fetch 取消行为）
      await new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        )
      })
      return stubResult()
    })
    const { result, unmount } = renderHook(() =>
      useMapVisualization(makeDescriptor('http://t/map.json'), { loadMapImpl }),
    )
    await flushMicrotasks()
    unmount()
    expect(capturedSignal!.aborted).toBe(true)
    await flushMicrotasks()
    // AbortError 被静默吞掉：无视图、无重试诊断
    expect(result.current.view).toBeNull()
    expect(result.current.reloading).toBe(true)
  })
})
