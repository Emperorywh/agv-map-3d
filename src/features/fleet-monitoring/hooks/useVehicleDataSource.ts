/**
 * 车辆数据源 React 生命周期 Hook（SPEC §3.1、§4、§11.5、§12.5；TASK-007、
 * TASK-015）。
 *
 * 职责：把一个 VehicleDataSource 实例对称地接入车队高频运行时——挂载时建立
 *       事件订阅、状态订阅、1Hz freshness ticker 并发起连接；清理时按相反
 *       顺序完整释放（退订 → 停 ticker → 摘除可见性监听 → 中止连接信号 →
 *       手动断开）。同时以 visibilitychange 管理后台节流（SPEC §11.5）：页
 *       面隐藏时暂停 ticker 并立即重算一次 freshness；回前台时立即重算
 *       freshness、强制全量脏标记并恢复 ticker。全部生命周期约束都为
 *       React StrictMode 的 setup→cleanup→setup 而设计。
 * 边界：纯数据接线，不渲染任何 DOM、不创建 Three.js 对象；高频事件只写入
 *       运行时的普通 Map 与脏集合（绝不进入 React state/zustand，SPEC §4）；
 *       状态变化仅通过低频回调上抛，由调用方决定落点。数据源连接与可见性
 *       完全解耦——隐藏期间 WS 与 Mock 均不断开，事件继续归并进运行时，
 *       每车只保留最新快照（旧状态被覆盖，无事件回放）。
 * 关键不变量：
 * 1. 一次性接线：同一 effect 生命周期内恰好一次 connect、一组订阅、一个
 *    ticker、一个 visibilitychange 监听；StrictMode 双执行收敛为「断开旧的
 *    → 建立新的」，任意时刻至多一条活跃连接、事件至多应用一次（依赖 source
 *    与 runtime 的引用稳定性）；
 * 2. 对称清理：清理函数与建立动作一一对应，卸载后源再发出的事件/状态回调
 *    已被退订，可见性监听已摘除（卸载后的隐藏/回前台不触达运行时）；
 * 3. AbortSignal 联动：effect 持有自己的 AbortController，清理时先中止再
 *    disconnect——连接进行中被取消时以 AbortError 结束且不留重连计时器；
 * 4. 无数据源（source=null）是合法稳态：不连接、不订阅、不监听可见性，状态
 *    回调收到 IDLE，静态地图照常渲染（SPEC §11.2「WS 断连不显示全局 UI」
 *    的同构扩展）；
 * 5. ticker 只在前台运行（TASK-015）：挂载即隐藏时不启动；隐藏即暂停并在
 *    暂停前立即 tick 一次（freshness 冻结在隐藏时刻的真相）；回前台立即
 *    tick 一次（后台期间静默的车辆一次性跃迁 STALE，不依赖节流的定时器），
 *    随后 markAllDirty 强制全量 diff——配合渲染层「回前台首个渲染帧消费全
 *    部脏槽位」，实现与最新快照的一帧对齐、无中间运动回放。
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

    // 高频路径：事件 → 运行时普通 Map/脏集合，绝不触碰 React state。
    // 页面隐藏期间照常工作（数据源不断开）：每车只保留最新状态，
    // 脏标记在集合内按实体键去重累积，回前台由首个渲染帧一次性消费。
    const unsubscribeEvent = source.onEvent((event) => {
      const diff = runtime.applyEvent(event)
      optionsRef.current.onDiffApplied?.(diff)
    })
    // 低频路径：连接状态罕见变化，交由调用方决定落点（Provider 存 React state）
    const unsubscribeStatus = source.onStatusChange((status) => {
      optionsRef.current.onStatusChange?.(status)
    })

    // 1Hz freshness ticker：只在 FRESH/STALE 边界改写运行时并标脏。
    // ticker 的存在性即「前台」状态：start/stop 幂等且互斥，隐藏期间绝不
    // 依赖被浏览器节流的定时器做 freshness 裁决。
    let ticker: ReturnType<typeof setInterval> | null = null
    const startTicker = (): void => {
      if (ticker !== null) {
        return
      }
      ticker = setInterval(() => {
        runtime.tick(optionsRef.current.now?.() ?? performance.now())
      }, TICK_INTERVAL_MS)
    }
    const stopTicker = (): void => {
      if (ticker !== null) {
        clearInterval(ticker)
        ticker = null
      }
    }

    // 后台节流（SPEC §11.5；TASK-015）：监听回调内实时读取
    // document.visibilityState，不缓存事件间状态。隐藏：暂停前立即 tick，
    // freshness 冻结在隐藏时刻；回前台：立即 tick 一次（后台静默车一次性
    // 到位）+ markAllDirty（下一渲染帧全量重写实例缓冲，一帧对齐、无中间
    // 运动回放），再恢复 ticker。
    const handleVisibilityChange = (): void => {
      const now = optionsRef.current.now?.() ?? performance.now()
      if (document.visibilityState === 'hidden') {
        stopTicker()
        runtime.tick(now)
        return
      }
      runtime.tick(now)
      runtime.markAllDirty()
      startTicker()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    // 挂载即隐藏（页面在后台打开/切走后重挂载）：不启动 ticker，保持
    // 「ticker 只在前台运行」的语义；回前台由可见性监听恢复。
    if (document.visibilityState !== 'hidden') {
      startTicker()
    }

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
      stopTicker()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      controller.abort()
      source.disconnect()
    }
  }, [source, runtime])
}
