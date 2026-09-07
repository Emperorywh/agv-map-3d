/**
 * 为实时车辆源接入本地静态快照，连接失败或长时间无首帧时启用。
 * 快照只重复发布原始位置与状态，不启动仿真；真实全量快照到达后恢复实时数据。
 * 实时地址被配置校验停用时允许 primary 为 null，立即使用同一份静态快照。
 * 两条入口共用订阅、取消与资源清理，地图启动不依赖实时连接是否可用。
 */
import {
  createDispatcherProtocolAdapter,
  type SnapshotEvent,
  type VehicleDataEvent,
  type VehicleDataSource,
} from '@/features/fleet-monitoring'
import { isAbortError, type DiagnosticsReporter } from '@/shared/diagnostics'

export function withStaticVehicleFallback(
  primary: VehicleDataSource | null,
  mapId: string | Promise<string>,
  staleAfterMs: number,
  diagnostics?: DiagnosticsReporter,
): VehicleDataSource {
  const subscribers = new Set<(event: VehicleDataEvent) => void>()
  let cleanup: (() => void) | null = null
  let session: Promise<void> | null = null
  let sequence = 0
  let requestFallback: (() => void) | null = null

  /**
   * 两种来源共用递增序号，避免回退与恢复时序号倒退。
   * 订阅者异常单独隔离，不能打断其他车辆消费者或连接清理。
   */
  const publish = (event: VehicleDataEvent): void => {
    const next = { ...event, sequence: ++sequence, receivedAt: performance.now() }
    for (const cb of [...subscribers]) {
      try {
        cb(next)
      } catch (error) {
        diagnostics?.report('VEHICLE_FALLBACK_SUBSCRIBER_ERROR', 'warn', '车辆事件订阅者执行失败', {
          reason: String(error),
        })
      }
    }
  }

  return {
    connect(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) {
        return Promise.reject(new DOMException('车辆连接已中止', 'AbortError'))
      }
      if (session !== null) return session

      /**
       * 每次连接独立持有请求、计时器与订阅，卸载时整体失效。
       * 即使旧请求在下一次挂载后才返回，也不能覆盖新会话的实时车辆。
       */
      const controller = new AbortController()
      let active = true
      let live = false
      let loading = false
      let snapshot: SnapshotEvent | null = null
      let refreshTimer: ReturnType<typeof setInterval> | null = null
      let resolveSession!: () => void
      let rejectSession!: (error: unknown) => void
      const promise = new Promise<void>((resolve, reject) => {
        resolveSession = resolve
        rejectSession = reject
      })
      session = promise

      const stopRefresh = (): void => {
        if (refreshTimer !== null) clearInterval(refreshTimer)
        refreshTimer = null
        requestFallback = null
      }
      const showFallback = async (): Promise<void> => {
        if (!active || live || loading || refreshTimer !== null) return
        loading = true
        try {
          if (snapshot === null) {
            const [resolvedMapId, response] = await Promise.all([
              mapId,
              fetch(new URL('json/vehicleList.json', document.baseURI), { signal: controller.signal }),
            ])
            if (!response.ok) throw new Error(`车辆快照请求失败：HTTP ${response.status}`)
            const vehicles: unknown = await response.json()
            if (!Array.isArray(vehicles)) throw new Error('车辆快照必须为数组')
            const decoded = createDispatcherProtocolAdapter({ mapId: resolvedMapId, diagnostics })
              .decode(JSON.stringify({ vehicles }))
            if (!decoded.ok) throw decoded.error
            if (decoded.message.type !== 'snapshot') throw new Error('车辆快照解析失败')
            snapshot = { ...decoded.message, mapId: resolvedMapId, receivedAt: 0 }
          }
          if (!active || live) return

          /**
           * 重复发布同一份快照只维持状态可见性，位置和朝向始终不变。
           * 避免静态演示在新鲜度超时后全部变灰，原始业务状态继续展示。
           */
          const emitSnapshot = (): void => {
            if (active && !live && snapshot !== null) publish(snapshot)
          }
          requestFallback = emitSnapshot
          emitSnapshot()
          refreshTimer = setInterval(emitSnapshot, Math.max(1, Math.min(1_000, staleAfterMs / 2)))
          resolveSession()
        } catch (error) {
          if (active && !live && !isAbortError(error)) {
            diagnostics?.report('VEHICLE_FALLBACK_FAILED', 'warn', '本地车辆快照加载失败', {
              reason: String(error),
            })
          }
        } finally {
          loading = false
        }
      }

      /**
       * 握手一直挂起时也能显示车辆，不依赖浏览器漫长的网络超时。
       * 恢复必须以真实全量快照为准，仅连接打开或心跳不能清除模拟车辆。
       */
      const fallbackTimer = setTimeout(() => { void showFallback() }, 3_000)
      const unsubscribeEvent = primary?.onEvent((event) => {
        if (event.type === 'snapshot') {
          live = true
          clearTimeout(fallbackTimer)
          stopRefresh()
        }
        if (live) publish(event)
      })
      const unsubscribeStatus = primary?.onStatusChange((status) => {
        if (status === 'RECONNECTING' || status === 'ERROR') {
          live = false
          void showFallback()
        }
      })
      const onAbort = (): void => {
        rejectSession(new DOMException('车辆连接已中止', 'AbortError'))
        cleanup?.()
      }
      cleanup = (): void => {
        active = false
        clearTimeout(fallbackTimer)
        stopRefresh()
        unsubscribeEvent?.()
        unsubscribeStatus?.()
        signal?.removeEventListener('abort', onAbort)
        controller.abort()
        primary?.disconnect()
        resolveSession()
        session = null
        cleanup = null
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      /**
       * 无实时源时立即加载快照，不等待握手超时，也不尝试不安全的地址。
       * 有实时源时维持原有重连与全量快照恢复逻辑。
       */
      if (primary === null) {
        void showFallback()
      } else {
        void primary.connect(controller.signal).then(resolveSession, (error: unknown) => {
          if (active && !isAbortError(error)) void showFallback()
        })
      }
      return promise
    },
    disconnect(): void {
      cleanup?.()
    },
    requestSnapshot(): void {
      requestFallback?.()
      primary?.requestSnapshot()
    },
    get status() {
      // 无实时源时保持未连接状态，避免把静态快照误标成实时连接成功。
      // 快照的展示由车辆事件驱动，与连接状态独立。
      return primary?.status ?? 'IDLE'
    },
    onStatusChange: (cb) => primary?.onStatusChange(cb) ?? (() => {}),
    onEvent(cb) {
      subscribers.add(cb)
      return () => { subscribers.delete(cb) }
    },
  }
}
