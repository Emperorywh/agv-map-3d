/**
 * 车辆数据源 React 生命周期 Hook（SPEC §3.1、§4、§12.5；TASK-007）。
 *
 * 职责：把一个 VehicleDataSource 实例对称地接入车队高频运行时——挂载时建立
 *       事件订阅、状态订阅、1Hz freshness ticker 并发起连接；清理时按相反
 *       顺序完整释放（退订 → 停 ticker → 中止连接信号 → 手动断开）。全部
 *       生命周期约束都为 React StrictMode 的 setup→cleanup→setup 而设计。
 * 边界：纯数据接线，不渲染任何 DOM、不创建 Three.js 对象；高频事件只写入
 *       运行时的普通 Map 与脏集合（绝不进入 React state/zustand，SPEC §4）；
 *       状态变化仅通过低频回调上抛，由调用方决定落点。
 * 关键不变量：
 * 1. 一次性接线：同一 effect 生命周期内恰好一次 connect、一组订阅、一个
 *    ticker；StrictMode 双执行收敛为「断开旧的 → 建立新的」，任意时刻至多
 *    一条活跃连接、事件至多应用一次（依赖 source 与 runtime 的引用稳定性）；
 * 2. 对称清理：清理函数与建立动作一一对应，卸载后源再发出的事件/状态回调
 *    已被退订，不会触达已卸载组件；
 * 3. AbortSignal 联动：effect 持有自己的 AbortController，清理时先中止再
 *    disconnect——连接进行中被取消时以 AbortError 结束且不留重连计时器；
 * 4. 无数据源（source=null）是合法稳态：不连接、不订阅，状态回调收到 IDLE，
 *    静态地图照常渲染（SPEC §11.2「WS 断连不显示全局 UI」的同构扩展）。
 */
import { useEffect, useRef } from 'react'
import { isAbortError } from '@/shared/diagnostics'
import type { FleetDiff, FleetRuntime } from '../model/createFleetRuntime'
import type { SourceStatus, VehicleDataSource } from '../data-source/contract'

/** freshness ticker 周期：1Hz 只做 FRESH/STALE 跃迁（SPEC §4） */
const TICK_INTERVAL_MS = 1_000

export interface UseVehicleDataSourceOptions {
  /** 单调时钟；默认 performance.now()，供 runtime.tick 判定过期 */
  now?: () => number
  /** 低频状态回调（CONNECTING/OPEN/RECONNECTING 等 rare 变化） */
  onStatusChange?: (status: SourceStatus) => void
  /** 连接以非取消方式失败时的上报口（诊断由 Provider 注入） */
  onConnectError?: (error: unknown) => void
  /**
   * 事件归并后的差异回调（TASK-012）：removed 差异在此处可转发为低频
   * store 命令（如清除被删车辆的选中状态）。回调在高频事件路径上执行，
   * 实现必须廉价且不得触碰 React state。
   */
  onDiffApplied?: (diff: FleetDiff) => void
}

/**
 * 把数据源接入运行时的唯一生命周期入口。
 * source 与 runtime 必须传稳定引用（由 Provider 或调用方持有），否则将按
 * 引用变化拆除并重建连接——这是「快速 source 切换」的既定语义。
 */
export function useVehicleDataSource(
  source: VehicleDataSource | null,
  runtime: FleetRuntime,
  options: UseVehicleDataSourceOptions = {},
): void {
  // options 经 ref 透传：回调允许每次渲染变化，但不作为 effect 依赖，
  // 避免调用方传内联回调导致连接反复重建
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    if (source === null) {
      optionsRef.current.onStatusChange?.('IDLE')
      return
    }
    const controller = new AbortController()

    // 高频路径：事件 → 运行时普通 Map/脏集合，绝不触碰 React state
    const unsubscribeEvent = source.onEvent((event) => {
      const diff = runtime.applyEvent(event)
      optionsRef.current.onDiffApplied?.(diff)
    })
    // 低频路径：连接状态罕见变化，交由调用方决定落点（Provider 存 React state）
    const unsubscribeStatus = source.onStatusChange((status) => {
      optionsRef.current.onStatusChange?.(status)
    })

    // 1Hz freshness ticker：只在 FRESH/STALE 边界改写运行时并标脏
    const ticker = setInterval(() => {
      runtime.tick(optionsRef.current.now?.() ?? performance.now())
    }, TICK_INTERVAL_MS)

    // 连接失败（非取消）由数据源内部记诊断；此处只吞掉 AbortError，
    // 避免 StrictMode 清理竞态产生未处理的 promise 拒绝
    source.connect(controller.signal).catch((error: unknown) => {
      if (!isAbortError(error)) {
        optionsRef.current.onConnectError?.(error)
      }
    })

    return () => {
      unsubscribeEvent()
      unsubscribeStatus()
      clearInterval(ticker)
      controller.abort()
      source.disconnect()
    }
  }, [source, runtime])
}
