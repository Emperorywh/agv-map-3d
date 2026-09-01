/**
 * WebSocket 车辆数据源（SPEC §3.1～§3.3、§11.2、§11.7；TASK-007）。
 *
 * 职责：实现 VehicleDataSource 合同的 WebSocket 分支——管理连接生命周期、
 *       异常断开的抖动指数退避重连、数据通道静默看门狗、连接代次隔离、
 *       序号治理与全量快照基线门控，并把协议适配器产出的归一化消息打上
 *       地图上下文（mapId）与本地单调接收时间（receivedAt）后对外发布。
 * 边界：协议字段映射全部委托 WebSocketProtocolAdapter（见 protocolAdapter.ts），
 *       本模块不理解任何真实消息结构；单车校验、事件归并与新鲜度属下游
 *       fleet runtime；本模块不渲染 DOM、不创建 Three 对象、不持有 React 状态。
 * 关键不变量：
 * 1. connect/disconnect 幂等：重复 connect 复用进行中的会话；手动 disconnect
 *    清理全部计时器并进入 CLOSED 终态，之后可再次 connect（ StrictMode 与
 *    快速切换安全）；自动重连只由异常断开/静默超时触发，手动断开绝不重连；
 * 2. 连接代次（epoch）隔离：每次创建 socket 递增代次，旧 socket 的 open/
 *    message/close 一律失效——换连接后旧事件绝不进入新会话（SPEC §3.2）；
 * 3. 序号治理：同一连接内只接受严格递增的 sequence，重复或回退忽略并记
 *    采样告警；序号地板随每条新连接重置（新连接 = 新序号空间）；
 * 4. 全量基线门控：新连接在首个 snapshot 落地前拒绝 update/remove 孤立增量
 *    （heartbeat 只证明通道存活，允许通过）；snapshot 落地即建立基线并结束
 *    重连周期（SPEC §3.3「快照到达前保持 RECONNECTING」）；
 * 5. 退避：异常断开按 1s、2s、4s、8s… 封顶 30s 的基础间隔乘 80%～120% 随机
 *    抖动重连；连接连续稳定 60s 后退避级别重置；静默超时（15s 无有效通道
 *    事件）立即主动重连，不消耗退避级别；
 * 6. 连续解码失败达到阈值进入 ERROR 终态并停止自动重连（SPEC §11.7）——
 *    协议持续失配时重试无意义，恢复路径是显式 disconnect + connect。
 */
import {
  createDiagnosticsReporter,
  describeError,
  StructuredError,
  type DiagnosticsReporter,
} from '@/shared/diagnostics'
import { isFiniteNumber } from '@/shared/validation'
import type {
  SourceStatus,
  Unsubscribe,
  VehicleDataEvent,
  VehicleDataSource,
} from '../contract'
import type {
  NormalizedVehicleMessage,
  WebSocketProtocolAdapter,
} from './protocolAdapter'

/* ==================== 可调常量（SPEC §3.3） ==================== */

/** 退避基础间隔（毫秒）：1s 起步按 2 的幂增长 */
export const WS_RECONNECT_BASE_MS = 1_000
/** 退避封顶间隔（毫秒） */
export const WS_RECONNECT_MAX_MS = 30_000
/** 连接连续稳定该时长后重置退避级别（毫秒） */
export const WS_STABLE_RESET_MS = 60_000
/** 数据通道静默判定窗口（毫秒）：15s 无有效事件主动重连 */
export const WS_SILENT_AFTER_MS = 15_000
/** 连续解码失败进入 ERROR 的阈值（SPEC §11.7） */
export const WS_MAX_CONSECUTIVE_DECODE_FAILURES = 10

/** 抖动区间（基础间隔的 80%～120%，SPEC §3.3） */
const JITTER_MIN = 0.8
const JITTER_MAX = 1.2

/* ==================== WebSocket 注入抽象 ==================== */

/** 数据源依赖的最小 WebSocket 形态（浏览器 WebSocket 结构兼容） */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: (() => void) | null
  onclose: ((event?: { readonly code?: number; readonly reason?: string }) => void) | null
  onerror: ((event?: unknown) => void) | null
  onmessage: ((event: { readonly data: unknown }) => void) | null
}

/** socket 工厂：测试注入假 socket，生产使用全局 WebSocket */
export type WebSocketFactory = (url: string) => WebSocketLike

export const WS_READY_STATE_CONNECTING = 0
export const WS_READY_STATE_OPEN = 1

/**
 * 默认工厂：把浏览器 WebSocket 的事件模型转发为 WebSocketLike 的零参回调。
 * DOM 处理器签名（this + Event）与内部抽象不兼容，必须经 shim 转换；
 * readyState 用 getter 保持实时（连接状态机依赖它判断可发送时机）。
 */
const defaultSocketFactory: WebSocketFactory = (url) => {
  const ws = new WebSocket(url)
  const listeners = {
    onopen: null as (() => void) | null,
    onclose: null as ((event?: { readonly code?: number; readonly reason?: string }) => void) | null,
    onerror: null as ((event?: unknown) => void) | null,
    onmessage: null as ((event: { readonly data: unknown }) => void) | null,
  }
  ws.onopen = () => {
    listeners.onopen?.()
  }
  ws.onclose = (event) => {
    listeners.onclose?.({ code: event.code, reason: event.reason })
  }
  ws.onerror = (event) => {
    listeners.onerror?.(event)
  }
  ws.onmessage = (event) => {
    listeners.onmessage?.({ data: event.data })
  }
  return {
    get readyState(): number {
      return ws.readyState
    },
    send: (data: string): void => {
      ws.send(data)
    },
    close: (code?: number, reason?: string): void => {
      ws.close(code, reason)
    },
    get onopen(): (() => void) | null {
      return listeners.onopen
    },
    set onopen(handler: (() => void) | null) {
      listeners.onopen = handler
    },
    get onclose(): ((event?: { readonly code?: number; readonly reason?: string }) => void) | null {
      return listeners.onclose
    },
    set onclose(handler: ((event?: { readonly code?: number; readonly reason?: string }) => void) | null) {
      listeners.onclose = handler
    },
    get onerror(): ((event?: unknown) => void) | null {
      return listeners.onerror
    },
    set onerror(handler: ((event?: unknown) => void) | null) {
      listeners.onerror = handler
    },
    get onmessage(): ((event: { readonly data: unknown }) => void) | null {
      return listeners.onmessage
    },
    set onmessage(handler: ((event: { readonly data: unknown }) => void) | null) {
      listeners.onmessage = handler
    },
  }
}

/* ==================== 数据源实现 ==================== */

export interface WebSocketDataSourceOptions {
  /** WebSocket 服务地址（已经 loadRuntimeConfig 校验安全策略） */
  wsUrl: string
  /** 绑定的地图上下文：所有对外事件的 mapId 来源（合同不变量 4） */
  mapId: string
  /** 协议适配器：unknown → 归一化消息或结构化错误的唯一边界 */
  adapter: WebSocketProtocolAdapter
  /** socket 工厂；默认 new WebSocket(url)，测试注入假实现 */
  socketFactory?: WebSocketFactory
  /** 单调时钟；默认 performance.now()（receivedAt 与稳定性计时口径） */
  now?: () => number
  /** [0,1) 随机源；默认 Math.random，测试注入固定值锁定抖动 */
  random?: () => number
  /** 结构化诊断通道；默认创建独立控制台通道 */
  diagnostics?: DiagnosticsReporter
  /** 静默判定窗口；默认 15s */
  silentAfterMs?: number
  /** 退避基础间隔；默认 1s */
  reconnectBaseMs?: number
  /** 退避封顶间隔；默认 30s */
  reconnectMaxMs?: number
  /** 稳定重置阈值；默认 60s */
  stableResetMs?: number
  /** 连续解码失败阈值；默认 10 */
  maxConsecutiveDecodeFailures?: number
}

/**
 * 创建基于 WebSocket 的车辆数据源。
 * 返回对象满足 VehicleDataSource 全部合同：connect/disconnect 幂等、完整
 * SourceStatus、事件订阅与快照请求；内部状态对订阅者完全封闭。
 */
export function createWebSocketVehicleDataSource(
  options: WebSocketDataSourceOptions,
): VehicleDataSource {
  const wsUrl = options.wsUrl
  const mapId = options.mapId
  const adapter = options.adapter
  const socketFactory = options.socketFactory ?? defaultSocketFactory
  const now = options.now ?? ((): number => performance.now())
  const random = options.random ?? Math.random
  const diagnostics = options.diagnostics ?? createDiagnosticsReporter()
  const silentAfterMs = options.silentAfterMs ?? WS_SILENT_AFTER_MS
  const baseMs = options.reconnectBaseMs ?? WS_RECONNECT_BASE_MS
  const maxMs = options.reconnectMaxMs ?? WS_RECONNECT_MAX_MS
  const stableResetMs = options.stableResetMs ?? WS_STABLE_RESET_MS
  const maxDecodeFailures =
    options.maxConsecutiveDecodeFailures ?? WS_MAX_CONSECUTIVE_DECODE_FAILURES

  /* ---------- 内部状态（对订阅者封闭） ---------- */

  /** 当前活跃 socket；null 表示无连接（空闲/等待重连/终态） */
  let socket: WebSocketLike | null = null
  /** 连接代次：每次创建 socket 递增，旧 socket 的回调按代次失效 */
  let epoch = 0
  /** 当前连接是否已应用全量快照基线（每条新连接重置为 false） */
  let aligned = false
  /** 是否处于自动重连周期（异常断开或静默超时触发，基线落地即结束） */
  let reconnectCycle = false
  /** 手动断开终态（直到下一次 connect） */
  let manualClosed = false
  /** 连续解码失败 ERROR 终态（直到下一次 connect） */
  let errored = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  /** 退避级别：0 起步，每次异常断开 +1，稳定 60s 重置 */
  let backoffLevel = 0
  /** 当前连接打开时刻（毫秒，单调时钟）；60s 稳定重置依据 */
  let openedAt: number | null = null
  /** 当前连接已接受的最大序号；新连接重置（新序号空间） */
  let lastSequence: number | null = null
  /** 连续解码失败计数；任何成功解码清零 */
  let consecutiveDecodeFailures = 0

  /* ---------- connect() 会话 promise（幂等复用） ---------- */

  let sessionResolve: (() => void) | null = null
  let sessionReject: ((error: unknown) => void) | null = null
  /** 最近一次 connect() 返回的会话 promise；重复 connect 直接复用 */
  let sessionPromise: Promise<void> | null = null
  let sessionSignal: AbortSignal | null = null
  let sessionOnAbort: (() => void) | null = null

  /* ---------- 订阅者 ---------- */

  const eventSubscribers = new Set<(event: VehicleDataEvent) => void>()
  const statusSubscribers = new Set<(status: SourceStatus) => void>()
  let lastNotifiedStatus: SourceStatus = 'IDLE'

  /* ---------- 状态派生与发布 ---------- */

  /**
   * 派生 SourceStatus（单一事实源）：
   * - ERROR / CLOSED：两个终态优先；
   * - 有 socket：已对齐 → OPEN；未对齐 → 重连周期内 RECONNECTING，否则
   *   CONNECTING（首次连接建立基线前的诚实状态）；
   * - 无 socket：等待重连计时器 → RECONNECTING；否则 IDLE。
   */
  const currentStatus = (): SourceStatus => {
    if (errored) {
      return 'ERROR'
    }
    if (manualClosed) {
      return 'CLOSED'
    }
    if (socket !== null) {
      if (aligned) {
        return 'OPEN'
      }
      return reconnectCycle ? 'RECONNECTING' : 'CONNECTING'
    }
    return reconnectTimer !== null ? 'RECONNECTING' : 'IDLE'
  }

  const notifyStatus = (): void => {
    const next = currentStatus()
    if (next === lastNotifiedStatus) {
      return
    }
    lastNotifiedStatus = next
    for (const cb of [...statusSubscribers]) {
      try {
        cb(next)
      } catch {
        // 订阅者异常隔离：状态通知绝不打断数据源生命周期
      }
    }
  }

  const emitEvent = (event: VehicleDataEvent): void => {
    for (const cb of [...eventSubscribers]) {
      try {
        cb(event)
      } catch (error) {
        diagnostics.report(
          'WS_SUBSCRIBER_ERROR',
          'warn',
          '车辆事件订阅回调异常，已隔离',
          { reason: describeError(error) },
        )
      }
    }
  }

  /* ---------- 计时器管理 ---------- */

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  const clearSilenceTimer = (): void => {
    if (silenceTimer !== null) {
      clearTimeout(silenceTimer)
      silenceTimer = null
    }
  }

  /** 重新武装静默看门狗：socket 打开与每条有效通道事件都会调用 */
  const armSilenceTimer = (): void => {
    clearSilenceTimer()
    silenceTimer = setTimeout(handleSilenceTimeout, silentAfterMs)
  }

  /* ---------- 会话 promise 与 AbortSignal ---------- */

  const detachSessionSignal = (): void => {
    if (sessionSignal !== null && sessionOnAbort !== null) {
      sessionSignal.removeEventListener('abort', sessionOnAbort)
    }
    sessionSignal = null
    sessionOnAbort = null
  }

  const resolveSession = (): void => {
    sessionResolve?.()
    sessionResolve = null
    sessionReject = null
  }

  const rejectSession = (error: unknown): void => {
    sessionReject?.(error)
    sessionResolve = null
    sessionReject = null
  }

  const abortError = (): unknown =>
    new DOMException('WebSocket 连接已被中止', 'AbortError')

  /** AbortSignal 中止：拆除整条会话（连接中或已打开均适用） */
  const handleSessionAbort = (): void => {
    detachSessionSignal()
    clearSilenceTimer()
    clearReconnectTimer()
    const current = socket
    socket = null
    if (current !== null) {
      try {
        current.close()
      } catch {
        // 已关闭的 socket close 再抛出无意义，忽略
      }
    }
    aligned = false
    lastSequence = null
    rejectSession(abortError())
    notifyStatus()
  }

  /* ---------- 连接建立与重连 ---------- */

  /** 计算下一次异常重连延迟：基础间隔 × 抖动（80%～120%） */
  const computeReconnectDelay = (): number => {
    const base = Math.min(baseMs * 2 ** backoffLevel, maxMs)
    const jitter = JITTER_MIN + (JITTER_MAX - JITTER_MIN) * random()
    return base * jitter
  }

  const scheduleReconnect = (delayMs: number): void => {
    clearReconnectTimer()
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      openNewSocket()
    }, delayMs)
    notifyStatus()
  }

  /** 异常断开处理：稳定 60s 重置退避 → 抖动退避调度自动重连 */
  const handleAbnormalClose = (myEpoch: number): void => {
    if (epoch !== myEpoch || manualClosed || errored) {
      return
    }
    const stableDuration = openedAt !== null ? now() - openedAt : 0
    socket = null
    openedAt = null
    clearSilenceTimer()
    aligned = false
    lastSequence = null
    if (stableDuration >= stableResetMs) {
      // 连接连续稳定达到阈值：退避级别重置（SPEC §3.3）
      backoffLevel = 0
    }
    reconnectCycle = true
    const delayMs = computeReconnectDelay()
    backoffLevel += 1
    diagnostics.report(
      'WS_RECONNECT_SCHEDULED',
      'warn',
      '连接异常断开，已安排抖动退避重连',
      { attempt: backoffLevel, delayMs: Math.round(delayMs), stableDuration: Math.round(stableDuration) },
    )
    scheduleReconnect(delayMs)
  }

  /** 静默看门狗：15s 无有效通道事件 → 立即主动重连（不消耗退避级别） */
  const handleSilenceTimeout = (): void => {
    silenceTimer = null
    const current = socket
    if (current === null) {
      return
    }
    diagnostics.report(
      'WS_SILENT_RECONNECT',
      'warn',
      '数据通道持续静默，主动重建连接',
      { silentAfterMs, aligned },
    )
    // 先失效引用再关闭：旧 socket 的 onclose 不再驱动生命周期（代次隔离）
    socket = null
    openedAt = null
    try {
      current.close(4000, 'silent-channel')
    } catch {
      // 关闭失败无补救意义，新连接照常建立
    }
    aligned = false
    lastSequence = null
    reconnectCycle = true
    scheduleReconnect(0)
  }

  /** 创建并接管一条新连接（重连计时器到期或 connect() 入口） */
  const openNewSocket = (): void => {
    if (manualClosed || errored) {
      return
    }
    epoch += 1
    const myEpoch = epoch
    aligned = false
    lastSequence = null
    consecutiveDecodeFailures = 0
    let ws: WebSocketLike
    try {
      ws = socketFactory(wsUrl)
    } catch (error) {
      diagnostics.report(
        'WS_SOCKET_ERROR',
        'warn',
        'WebSocket 工厂同步创建失败，进入退避重连',
        { reason: describeError(error) },
      )
      handleAbnormalClose(myEpoch)
      return
    }
    socket = ws
    openedAt = null

    ws.onopen = (): void => {
      if (socket !== ws) {
        return
      }
      openedAt = now()
      armSilenceTimer()
      // 重连成功立即请求（或等待）全量快照（SPEC §3.3）
      requestSnapshotInternal()
      resolveSession()
      notifyStatus()
    }
    ws.onmessage = (event): void => {
      if (socket !== ws) {
        return
      }
      handleMessage(event?.data)
    }
    ws.onerror = (): void => {
      if (socket !== ws) {
        return
      }
      // onerror 之后浏览器必然触发 onclose：重连统一由 onclose 驱动
      diagnostics.report('WS_SOCKET_ERROR', 'warn', 'WebSocket 连接发生错误', {
        epoch: myEpoch,
      })
    }
    ws.onclose = (): void => {
      if (socket !== ws) {
        return
      }
      handleAbnormalClose(myEpoch)
    }
    notifyStatus()
  }

  /* ---------- 消息处理 ---------- */

  /** 解码失败达到阈值：进入 ERROR 终态并停止一切自动重连（SPEC §11.7） */
  const enterErrorState = (cause: StructuredError): void => {
    errored = true
    reconnectCycle = false
    clearSilenceTimer()
    clearReconnectTimer()
    const current = socket
    socket = null
    openedAt = null
    if (current !== null) {
      try {
        current.close(4000, 'decode-failures')
      } catch {
        // 忽略关闭异常：终态不再重连
      }
    }
    diagnostics.report(
      'WS_ERROR',
      'error',
      '连续解码失败达到阈值，数据源进入 ERROR 终态；恢复需显式 disconnect 后重新 connect',
      { threshold: maxDecodeFailures, cause: cause.code },
    )
    notifyStatus()
  }

  const handleMessage = (raw: unknown): void => {
    const result = adapter.decode(raw)
    if (!result.ok) {
      consecutiveDecodeFailures += 1
      diagnostics.report(
        'WS_DECODE_FAILED',
        'warn',
        '原始消息无法映射为归一化事件，整条拒绝且不影响现有数据',
        { code: result.error.code, reason: result.error.message },
      )
      if (consecutiveDecodeFailures >= maxDecodeFailures) {
        enterErrorState(result.error)
      }
      return
    }
    consecutiveDecodeFailures = 0
    // 有效通道事件：重置静默看门狗（含被序号门控忽略的重复帧——数据仍在流动）
    armSilenceTimer()
    applyNormalizedMessage(result.message)
  }

  /** 序号治理 + 基线门控 + 上下文补全：归一化消息 → 对外事件 */
  const applyNormalizedMessage = (message: NormalizedVehicleMessage): void => {
    const { sequence } = message
    if (!isFiniteNumber(sequence)) {
      // 适配器合同保证有限序号；此处纵深防御，绝不发布无序号事件
      diagnostics.report('WS_DECODE_FAILED', 'warn', '归一化消息缺少有限序号，已丢弃', {
        type: message.type,
      })
      return
    }
    if (lastSequence !== null && sequence <= lastSequence) {
      // 重复或回退序号：忽略并记录采样告警（SPEC §3.2）
      diagnostics.report(
        'WS_SEQUENCE_STALE',
        'warn',
        '事件序号重复或回退，已忽略',
        { sequence, lastSequence },
      )
      return
    }
    lastSequence = sequence

    if ((message.type === 'update' || message.type === 'remove') && !aligned) {
      // 新连接快照前的孤立增量：拒绝（SPEC §3.3；remove 同样需要基线语境）
      diagnostics.report(
        'WS_ORPHAN_INCREMENT',
        'warn',
        '全量快照基线建立前的孤立增量，已拒绝',
        { type: message.type, sequence },
      )
      return
    }

    const event: VehicleDataEvent = buildEvent(message, sequence)
    if (message.type === 'snapshot') {
      // 全量基线落地：数据通道对齐，重连周期结束（状态转 OPEN）
      aligned = true
      reconnectCycle = false
    }
    emitEvent(event)
    notifyStatus()
  }

  /** 补全地图上下文与本地单调接收时间（合同不变量 2） */
  const buildEvent = (
    message: NormalizedVehicleMessage,
    sequence: number,
  ): VehicleDataEvent => {
    const receivedAt = now()
    switch (message.type) {
      case 'snapshot':
        return {
          type: 'snapshot',
          schemaVersion: message.schemaVersion,
          mapId,
          sequence,
          receivedAt,
          vehicles: message.vehicles,
        }
      case 'update':
        return {
          type: 'update',
          schemaVersion: message.schemaVersion,
          mapId,
          sequence,
          receivedAt,
          vehicle: message.vehicle,
        }
      case 'remove':
        return {
          type: 'remove',
          schemaVersion: message.schemaVersion,
          mapId,
          sequence,
          receivedAt,
          agvKey: message.agvKey,
        }
      case 'heartbeat':
        return {
          type: 'heartbeat',
          schemaVersion: message.schemaVersion,
          mapId,
          sequence,
          receivedAt,
        }
    }
  }

  /* ---------- VehicleDataSource 合同实现 ---------- */

  const requestSnapshotInternal = (): void => {
    const current = socket
    if (current === null || current.readyState !== WS_READY_STATE_OPEN) {
      return
    }
    let frame: string | null
    try {
      frame = adapter.encodeSnapshotRequest()
    } catch (error) {
      diagnostics.report(
        'WS_SNAPSHOT_REQUEST_FAILED',
        'warn',
        '构造快照请求帧失败，退化为等待服务端推送',
        { reason: describeError(error) },
      )
      return
    }
    if (frame === null) {
      // 适配器无法表达快照请求：等待服务端主动推送全量快照
      return
    }
    try {
      current.send(frame)
    } catch (error) {
      diagnostics.report(
        'WS_SNAPSHOT_REQUEST_FAILED',
        'warn',
        '快照请求帧发送失败',
        { reason: describeError(error) },
      )
    }
  }

  const connect = (signal?: AbortSignal): Promise<void> => {
    // 幂等：连接中 / 已打开 / 等待重连 → 复用进行中的会话 promise
    if (socket !== null || reconnectTimer !== null) {
      return sessionPromise ?? Promise.resolve()
    }
    // 终态复位：ERROR / CLOSED 后允许显式重新 connect（唯一恢复路径）
    errored = false
    manualClosed = false
    reconnectCycle = false
    backoffLevel = 0
    clearSilenceTimer()
    clearReconnectTimer()
    detachSessionSignal()
    if (signal?.aborted) {
      return Promise.reject(abortError())
    }
    const promise = new Promise<void>((resolve, reject) => {
      sessionResolve = resolve
      sessionReject = reject
    })
    sessionPromise = promise
    if (signal) {
      sessionSignal = signal
      sessionOnAbort = (): void => {
        handleSessionAbort()
      }
      signal.addEventListener('abort', sessionOnAbort, { once: true })
    }
    openNewSocket()
    return promise
  }

  /**
   * 手动断开：清理全部计时器与 signal 监听，关闭 socket，进入 CLOSED 终态；
   * 绝不触发自动重连；幂等（重复调用无副作用）。
   * 手动断开同时解除 ERROR 终态（显式接管即手动恢复路径的一部分）。
   */
  const disconnect = (): void => {
    manualClosed = true
    reconnectCycle = false
    errored = false
    clearSilenceTimer()
    clearReconnectTimer()
    detachSessionSignal()
    // 等待中的 connect 会话以「被手动断开取代」语义正常结束
    resolveSession()
    const current = socket
    socket = null
    openedAt = null
    if (current !== null) {
      try {
        current.close(1000, 'client-disconnect')
      } catch {
        // 忽略关闭异常：终态不再重连
      }
    }
    aligned = false
    lastSequence = null
    consecutiveDecodeFailures = 0
    notifyStatus()
  }

  return {
    connect,
    disconnect,
    requestSnapshot: requestSnapshotInternal,
    get status(): SourceStatus {
      return currentStatus()
    },
    onEvent(cb: (event: VehicleDataEvent) => void): Unsubscribe {
      eventSubscribers.add(cb)
      return () => {
        eventSubscribers.delete(cb)
      }
    },
    onStatusChange(cb: (status: SourceStatus) => void): Unsubscribe {
      statusSubscribers.add(cb)
      return () => {
        statusSubscribers.delete(cb)
      }
    },
  }
}
