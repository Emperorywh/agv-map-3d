/**
 * 独立开发预览数据源，使用真实车辆校验和事件合同，绝不连接现场业务通道。
 * 控件只改变样板快照，载荷、故障、离线和过期仍由既有状态推导代码处理。
 */
import type { VehicleDataSource, VehicleDataEvent, SourceStatus } from '@/features/fleet-monitoring/data-source/contract'
import { validateVehicle } from '@/features/fleet-monitoring/model/validateVehicle'
import type { VehicleSnapshot } from '@/features/fleet-monitoring/model/types'

export interface PreviewSettings {
  count: number
  theta: number
  loaded: boolean
  state: 'EXECUTING' | 'CHARGING' | 'FAULT' | 'OFFLINE' | 'STALE'
  procedural: boolean
  moving: boolean
}

export function createPreviewSource(): VehicleDataSource & { configure(settings: PreviewSettings): void } {
  let settings: PreviewSettings = { count: 1, theta: 0, loaded: false, state: 'EXECUTING', procedural: false, moving: false }
  const listeners = new Set<(event: VehicleDataEvent) => void>()
  const statusListeners = new Set<(status: SourceStatus) => void>()
  let timer: ReturnType<typeof setInterval> | undefined
  let sequence = 0
  let status: SourceStatus = 'IDLE'
  let silent = false
  const emit = () => {
    /**
     * 过期由停止有效快照自然触发，不伪造旧接收时间或持续刷新新鲜度。
     * 切换控件时先发送最后一帧，再让真实运行时在十秒后进入过期状态。
     */
    if (silent) return
    const vehicles: VehicleSnapshot[] = []
    const now = performance.now()
    for (let i = 0; i < settings.count; i += 1) {
      const theta = settings.theta + (settings.moving ? now / 3500 : 0)
      const cx = settings.count === 1 ? 0 : (i % 20 - 9.5) * 2.2
      const cz = settings.count === 1 ? 1 : (Math.floor(i / 20) - 4.5) * 1.5
      const result = validateVehicle({
        agvKey: `preview-${i}`, agvName: `AGV ${String(i + 1).padStart(3, '0')}`,
        agvDimension: { length: settings.procedural ? 1.35 : 1.8, width: settings.procedural ? 0.85 : 0.7, loadLength: 1.6, loadWidth: 0.7, centerOffset: 0.25 },
        agvPosition: { x: cx - 0.25 * Math.cos(theta), y: -cz - 0.25 * Math.sin(theta), theta, localizationScore: 1 },
        batteryState: { batteryCharge: 78, batteryHealth: 100, batteryVoltage: 48, charging: settings.state === 'CHARGING' },
        connectionState: settings.state === 'OFFLINE' ? 'OFFLINE' : 'ONLINE', orderState: 'PROCESSING',
        loaded: settings.loaded, paused: false,
        errorEntryList: settings.state === 'FAULT' ? [{ message: '样板故障' }] : [],
      }, 'industrial-preview')
      if (result.ok) vehicles.push(result.snapshot)
    }
    const event: VehicleDataEvent = { type: 'snapshot', schemaVersion: '1', mapId: 'industrial-preview', sequence: ++sequence,
      receivedAt: now, vehicles }
    for (const listener of listeners) listener(event)
  }
  return {
    get status() { return status },
    async connect() {
      if (timer !== undefined) return
      status = 'OPEN'
      for (const listener of statusListeners) listener(status)
      emit()
      timer = setInterval(emit, 100)
    },
    disconnect() { clearInterval(timer); timer = undefined; status = 'CLOSED' },
    requestSnapshot: emit,
    onEvent(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
    onStatusChange(cb) { statusListeners.add(cb); return () => { statusListeners.delete(cb) } },
    configure(next) { settings = next; silent = false; emit(); silent = next.state === 'STALE' },
  }
}
