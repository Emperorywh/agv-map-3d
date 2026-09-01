/**
 * 车辆实例槽位管理（SPEC §4、§6.3、§11.13；TASK-010）。
 *
 * 职责：为实例批渲染层管理「实体键 → (批次, 槽位)」的分配与回收——批次容量
 *       256（满足 250 台压力模式）、超出时按 256 步长扩批、运行时硬上限默认
 *       512；删除释放的槽位经空闲栈复用；超过硬上限时实体进入等待队列（快照
 *       保留在车队运行时，本表只记录未渲染数量），槽位一有空闲立即按 FIFO
 *       补录。
 * 边界：纯数据结构，不依赖 React、Three.js 或车队运行时；矩阵/颜色的实际
 *       写入由渲染同步层完成，本模块只回答「谁在哪个槽位、谁没被渲染」。
 *       实体键为 (mapId, agvKey) 编码，与本 Feature 其他模型一致。
 * 关键不变量：
 * 1. 同一实体键至多持有一个槽位：重复 acquire 幂等返回既有槽位，绝不重复
 *    分配（渲染层以「每槽一车」为前提写矩阵）；
 * 2. 批次只按整块容量扩张且绝不超硬上限：每个批次的可用槽位号严格小于其
 *    capacity（末批按硬上限截断），空闲栈里只有合法槽位号；
 * 3. 槽位回收与补录原子：release 释放的槽位若存在等待实体则立即转派（正反
 *    向映射同步改写）；空闲栈非空时等待队列必为空——两者不会同时非空；
 * 4. 正反向映射严格互逆：resolve(batch, slot) 与 get(key) 一一对应，供外壳
 *    拾取把 (batchId, instanceId) 映射回实体键（SPEC §5.2）。
 */

/** 默认批次容量：初始一批 256，满足 250 台压力模式（SPEC §4） */
export const SLOT_BATCH_CAPACITY = 256

/** 扩批步长与运行时硬上限（SPEC §4：按 256 步长扩批，硬上限默认 512） */
export const SLOT_CAPACITY_STEP = 256
export const SLOT_HARD_CAP = 512

/** 一个已分配的实例槽位：批次序号与批次内槽位序号（均从 0 起） */
export interface VehicleSlot {
  readonly batch: number
  readonly slot: number
}

export interface CreateInstanceSlotTableOptions {
  /** 批次容量；默认 256 */
  batchCapacity?: number
  /** 运行时硬上限（可渲染实例总数）；默认 512 */
  hardCap?: number
}

/** release 的结果：freed 为实际归还的槽位；admitted 为该槽位立即转派的
 *  等待实体（渲染层须对其做一次全量写入）。两者互斥且可同时为 null。 */
export interface ReleaseResult {
  readonly freed: VehicleSlot | null
  readonly admitted: string | null
}

export interface InstanceSlotTable {
  /** 为实体分配槽位；已持有则幂等返回；硬上限满时进入等待队列并返回 null */
  acquire(key: string): VehicleSlot | null
  /** 释放实体槽位（供空闲复用）；未持有为 no-op 返回双 null */
  release(key: string): ReleaseResult
  /** 查询实体当前槽位 */
  get(key: string): VehicleSlot | undefined
  /** 拾取反向映射：(batchId, instanceId) → 实体键；空槽位返回 undefined */
  resolve(batch: number, slot: number): string | undefined
  /** 当前批次数量（渲染层据此决定挂载几个批次对象） */
  readonly batchCount: number
  /** 已持有槽位的实体数 */
  readonly renderedCount: number
  /** 因硬上限未渲染的实体数（快照仍保留在车队运行时，SPEC §11.13） */
  readonly unrenderedCount: number
  /** 全部已渲染实体键（插入序稳定，全量重写用） */
  keys(): readonly string[]
}

interface BatchState {
  /** 本批次可用槽位数（≤ 批次容量；末批按硬上限截断） */
  capacity: number
  /** 空闲槽位栈：LIFO 复用最近释放的槽位（缓存友好且行为可复现） */
  free: number[]
  /** 本批次已占用量 */
  used: number
}

export function createInstanceSlotTable(
  options: CreateInstanceSlotTableOptions = {},
): InstanceSlotTable {
  const batchCapacity = options.batchCapacity ?? SLOT_BATCH_CAPACITY
  const hardCap = options.hardCap ?? SLOT_HARD_CAP
  if (!Number.isInteger(batchCapacity) || batchCapacity <= 0) {
    throw new RangeError('批次容量必须为正整数')
  }
  if (!Number.isInteger(hardCap) || hardCap < batchCapacity) {
    throw new RangeError('硬上限必须为不小于批次容量的正整数')
  }

  const batches: BatchState[] = []
  const keyToSlot = new Map<string, VehicleSlot>()
  /** 反向映射：扁平槽位索引（batch × capacity + slot）→ 实体键，拾取 O(1) */
  const slotToKey = new Map<number, string>()
  /** 等待队列（FIFO）：仅在硬上限满时积累，槽位释放时按序补录 */
  const waiting: string[] = []

  const flatIndex = (slot: VehicleSlot): number => slot.batch * batchCapacity + slot.slot

  /** 新建一批并占用其 0 号槽位给 key；其余槽位按「弹栈即升序」预入空闲栈 */
  const expandAndAssign = (key: string): VehicleSlot => {
    const total = batches.length * batchCapacity
    const capacity = Math.min(batchCapacity, hardCap - total)
    const batch: BatchState = { capacity, free: [], used: 1 }
    for (let s = capacity - 1; s >= 1; s -= 1) {
      batch.free.push(s)
    }
    batches.push(batch)
    const ref: VehicleSlot = { batch: batches.length - 1, slot: 0 }
    keyToSlot.set(key, ref)
    slotToKey.set(flatIndex(ref), key)
    return ref
  }

  const acquire = (key: string): VehicleSlot | null => {
    const existing = keyToSlot.get(key)
    if (existing !== undefined) {
      return existing
    }
    // 等待队列非空（必为硬上限满）：当前实体排队，先到先得不插队
    if (waiting.length > 0) {
      waiting.push(key)
      return null
    }
    // 任意批次有空闲槽位则复用（空闲链表，SPEC §4）
    for (let b = 0; b < batches.length; b += 1) {
      const free = batches[b].free
      if (free.length > 0) {
        const slot = free.pop() as number
        const ref: VehicleSlot = { batch: b, slot }
        keyToSlot.set(key, ref)
        slotToKey.set(flatIndex(ref), key)
        batches[b].used += 1
        return ref
      }
    }
    // 全满：未达硬上限则扩一批；否则实体排队等待（快照保留，SPEC §11.13）
    if (batches.length * batchCapacity < hardCap) {
      return expandAndAssign(key)
    }
    waiting.push(key)
    return null
  }

  const release = (key: string): ReleaseResult => {
    const slot = keyToSlot.get(key)
    if (slot === undefined) {
      return { freed: null, admitted: null }
    }
    keyToSlot.delete(key)
    batches[slot.batch].used -= 1
    // 原子转派：刚释放的槽位直接给等待队列头（FIFO 补录，不变量 3）；
    // 转派结果上抛，渲染层对补录实体立即全量写入
    const next = waiting.shift()
    if (next !== undefined) {
      keyToSlot.set(next, slot)
      slotToKey.set(flatIndex(slot), next)
      batches[slot.batch].used += 1
      return { freed: null, admitted: next }
    }
    slotToKey.delete(flatIndex(slot))
    batches[slot.batch].free.push(slot.slot)
    return { freed: slot, admitted: null }
  }

  return {
    acquire,
    release,
    get: (key) => keyToSlot.get(key),
    resolve: (batch, slot) => slotToKey.get(batch * batchCapacity + slot),
    get batchCount(): number {
      return batches.length
    },
    get renderedCount(): number {
      return keyToSlot.size
    },
    get unrenderedCount(): number {
      return waiting.length
    },
    keys: () => [...keyToSlot.keys()],
  }
}
