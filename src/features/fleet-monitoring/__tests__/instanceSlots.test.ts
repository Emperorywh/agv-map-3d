/*
 * 实例槽位管理测试（TASK-010 / SPEC §4、§6.3、§11.13）。
 *
 * 覆盖：分配幂等、空闲复用、扩批边界（0/1/200/250/256/257/512/513 容量
 * 语义）、硬上限等待队列 FIFO 补录、删除清场、拾取反向映射互逆、随机增删
 * 压力下与参考模型一致。
 */
import { describe, expect, it } from 'vitest'
import {
  createInstanceSlotTable,
  SLOT_BATCH_CAPACITY,
  SLOT_CAPACITY_STEP,
  SLOT_HARD_CAP,
} from '../model/instanceSlots'

/** 用 key 数组批量分配并返回槽位结果（null = 等待队列） */
function acquireAll(
  table: ReturnType<typeof createInstanceSlotTable>,
  keys: readonly string[],
): (Readonly<{ batch: number; slot: number }> | null)[] {
  return keys.map((key) => table.acquire(key))
}

describe('instanceSlots（TASK-010）', () => {
  it('默认容量合同：批次 256、步长 256、硬上限 512', () => {
    expect(SLOT_BATCH_CAPACITY).toBe(256)
    expect(SLOT_CAPACITY_STEP).toBe(256)
    expect(SLOT_HARD_CAP).toBe(512)
  })

  it('重复 acquire 幂等返回同一槽位；renderedCount 只计一次', () => {
    const table = createInstanceSlotTable()
    const first = table.acquire('k1')
    const second = table.acquire('k1')
    expect(first).toEqual(second)
    expect(table.renderedCount).toBe(1)
    expect(table.batchCount).toBe(1)
  })

  it('单批次内容量边界：0/1/200/250/256 台', () => {
    // 0 台：空表尚无批次（批次按需创建）
    const empty = createInstanceSlotTable()
    expect(empty.batchCount).toBe(0)
    expect(empty.renderedCount).toBe(0)

    // 1/200/250/256 台：单批次（250 台压力模式不扩批）
    for (const count of [1, 200, 250, 256]) {
      const table = createInstanceSlotTable()
      acquireAll(
        table,
        Array.from({ length: count }, (_, i) => `k${i}`),
      )
      expect(table.renderedCount).toBe(count)
      expect(table.batchCount).toBe(1)
      expect(table.unrenderedCount).toBe(0)
    }
  })

  it('257 台扩为两批；512 台仍为两批且全部渲染', () => {
    const table = createInstanceSlotTable()
    acquireAll(
      table,
      Array.from({ length: 257 }, (_, i) => `k${i}`),
    )
    expect(table.batchCount).toBe(2)
    expect(table.renderedCount).toBe(257)

    acquireAll(
      table,
      Array.from({ length: 512 }, (_, i) => `k${i}`),
    )
    expect(table.batchCount).toBe(2)
    expect(table.renderedCount).toBe(512)
    expect(table.unrenderedCount).toBe(0)
  })

  it('513 台超硬上限：512 台渲染、1 台等待且记录未渲染数', () => {
    const table = createInstanceSlotTable()
    acquireAll(
      table,
      Array.from({ length: 513 }, (_, i) => `k${i}`),
    )
    expect(table.renderedCount).toBe(512)
    expect(table.unrenderedCount).toBe(1)
    expect(table.batchCount).toBe(2)
    // 等待者没有槽位
    expect(table.get('k512')).toBeUndefined()
  })

  it('删除释放槽位；新实体复用空闲槽位（空闲链表）', () => {
    const table = createInstanceSlotTable()
    table.acquire('a')
    const b = table.acquire('b')
    table.acquire('c')
    const freed = table.release('b')
    expect(freed?.freed).toEqual(b)
    expect(table.renderedCount).toBe(2)

    const d = table.acquire('d')
    expect(d).toEqual(b) // 复用刚释放的槽位
    expect(table.batchCount).toBe(1)
  })

  it('硬上限满时释放触发等待队列 FIFO 补录，槽位直接易主', () => {
    const table = createInstanceSlotTable({ batchCapacity: 2, hardCap: 2 })
    acquireAll(table, ['a', 'b'])
    expect(table.acquire('c')).toBeNull() // 等待
    expect(table.acquire('d')).toBeNull() // 等待
    expect(table.unrenderedCount).toBe(2)

    const result = table.release('a')
    // a 的槽位直接转派给队首 c：无归还槽位，渲染层须对 c 全量写入
    expect(result).toEqual({ freed: null, admitted: 'c' })
    expect(table.get('c')).toEqual({ batch: 0, slot: 0 })
    expect(table.unrenderedCount).toBe(1)
    expect(table.resolve(0, 0)).toBe('c')

    // 再释放：队首 d 补录
    expect(table.release('b')).toEqual({ freed: null, admitted: 'd' })
    expect(table.unrenderedCount).toBe(0)
  })

  it('release 未持有键为 no-op；release 后 resolve 不再命中', () => {
    const table = createInstanceSlotTable({ batchCapacity: 1, hardCap: 2 })
    table.acquire('a')
    expect(table.release('ghost')).toEqual({ freed: null, admitted: null })
    expect(table.release('a')).not.toBeNull()
    expect(table.resolve(0, 0)).toBeUndefined()
    expect(table.get('a')).toBeUndefined()
  })

  it('拾取反向映射与正向查询严格互逆（含跨批次）', () => {
    const table = createInstanceSlotTable({ batchCapacity: 2, hardCap: 4 })
    const keys = ['a', 'b', 'c', 'd']
    const slots = acquireAll(table, keys)
    for (let i = 0; i < keys.length; i += 1) {
      const slot = slots[i]
      expect(table.get(keys[i])).toEqual(slot)
      expect(table.resolve(slot!.batch, slot!.slot)).toBe(keys[i])
    }
    // 空槽位（本例 2 批 × 2 容量 = 4 槽全部占用后无空槽；再造一批截断批次）
    expect(table.resolve(1, 5)).toBeUndefined()
    expect(table.resolve(9, 0)).toBeUndefined()
  })

  it('硬上限非整批倍数时末批截断：截断槽位永不分配', () => {
    // batchCapacity=3, hardCap=4 → 两批：首批 3 槽 + 末批 1 槽
    const table = createInstanceSlotTable({ batchCapacity: 3, hardCap: 4 })
    const slots = acquireAll(table, ['a', 'b', 'c', 'd'])
    expect(table.batchCount).toBe(2)
    expect(slots[3]).toEqual({ batch: 1, slot: 0 })
    expect(table.acquire('e')).toBeNull() // 满载等待
    // 释放末批唯一槽位后复用仍截断在合法范围
    table.release('d')
    const e = table.acquire('e')
    expect(e).toEqual({ batch: 1, slot: 0 })
  })

  it('随机增删压力：与参考模型一致（渲染数/未渲染数/互逆映射）', () => {
    // 简单可复现 LCG，避免依赖全局随机源
    let state = 20260901
    const nextRandom = (): number => {
      state = (state * 1103515245 + 12345) % 2147483648
      return state / 2147483648
    }

    const table = createInstanceSlotTable({ batchCapacity: 8, hardCap: 16 })
    /** 参考模型：当前已渲染键集合与等待队列（FIFO） */
    const rendered = new Set<string>()
    const waiting: string[] = []
    let serial = 0
    /** 批次数只增不减：跟踪历史峰值（批次创建后不因清空而回收） */
    let peakBatches = 0

    for (let step = 0; step < 500; step += 1) {
      if (nextRandom() < 0.55 || (rendered.size === 0 && waiting.length === 0)) {
        const key = `v${serial++}`
        const slot = table.acquire(key)
        if (slot === null) {
          waiting.push(key)
        } else {
          rendered.add(key)
        }
      } else if (rendered.size > 0) {
        const keys = [...rendered]
        const victim = keys[Math.floor(nextRandom() * keys.length)]
        const result = table.release(victim)
        rendered.delete(victim)
        if (result.admitted !== null) {
          waiting.shift()
          rendered.add(result.admitted)
        }
      }
      peakBatches = Math.max(
        peakBatches,
        rendered.size === 0 ? 0 : Math.min(2, Math.ceil(rendered.size / 8)),
      )
      // 不变量核对：数量守恒 + 映射互逆
      expect(table.renderedCount).toBe(rendered.size)
      expect(table.unrenderedCount).toBe(waiting.length)
      expect(table.renderedCount + table.unrenderedCount).toBeLessThanOrEqual(serial)
      expect(table.batchCount).toBe(peakBatches)
      for (const key of rendered) {
        const slot = table.get(key)!
        expect(table.resolve(slot.batch, slot.slot)).toBe(key)
      }
    }
  })

  it('非法构造参数立即暴露', () => {
    expect(() => createInstanceSlotTable({ batchCapacity: 0 })).toThrow(RangeError)
    expect(() => createInstanceSlotTable({ batchCapacity: 8, hardCap: 4 })).toThrow(RangeError)
  })
})
