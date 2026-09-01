/*
 * 协议适配边界测试（TASK-007 / SPEC §3.2、§11.7）。
 *
 * 职责：锁定 WebSocketProtocolAdapter 合同与默认「未映射」适配器的行为——
 *       真实协议映射就绪前（TASK-021）对一切消息显式拒绝、不猜测结构、
 *       无法表达快照请求；错误码稳定可按码分支。
 * 边界：测试专属 JSON 信封适配器（fakeWebSocket.ts）的生命周期行为由
 *       WebSocketVehicleDataSource.test.ts 覆盖，本文件不重复。
 */
import { describe, expect, it } from 'vitest'
import { createUnmappedProtocolAdapter } from '../data-source/websocket/protocolAdapter'

describe('createUnmappedProtocolAdapter：真实映射就绪前显式拒绝（不猜测）', () => {
  it('对字符串帧、对象、二进制、null 一律返回 PROTOCOL_UNMAPPED 结构化错误', () => {
    const adapter = createUnmappedProtocolAdapter()
    const inputs: unknown[] = [
      '{"type":"snapshot","sequence":1,"vehicles":[]}',
      { type: 'heartbeat', sequence: 2 },
      new ArrayBuffer(8),
      null,
      42,
    ]
    for (const raw of inputs) {
      const result = adapter.decode(raw)
      expect(result.ok).toBe(false)
      if (result.ok) {
        continue
      }
      expect(result.error.code).toBe('PROTOCOL_UNMAPPED')
      // 上下文只描述形态，绝不携带负载内容（可能含敏感信息）
      expect(JSON.stringify(result.error.context)).not.toContain('snapshot')
    }
  })

  it('无法表达快照请求：encodeSnapshotRequest 返回 null（等待服务端推送）', () => {
    const adapter = createUnmappedProtocolAdapter()
    expect(adapter.encodeSnapshotRequest()).toBeNull()
  })

  it('每次拒绝都是独立错误实例，可安全进入采样诊断', () => {
    const adapter = createUnmappedProtocolAdapter()
    const first = adapter.decode('x')
    const second = adapter.decode('y')
    expect(first.ok).toBe(false)
    expect(second.ok).toBe(false)
    if (!first.ok && !second.ok) {
      expect(second.error).not.toBe(first.error)
      expect(second.error.code).toBe(first.error.code)
    }
  })
})
