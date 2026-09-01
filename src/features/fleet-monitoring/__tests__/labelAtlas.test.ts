/*
 * 车辆标签图集测试（与实现共置；TASK-011 / SPEC §5.1、§6.4、§7.2）。
 *
 * 职责：锁定「图集化 WebGL 车辆标签」的纯逻辑合同：
 * 1. LabelCellBook：只重绘变化单元（同名幂等、改名重绘、清空幂等）、
 *    flushDirty 计数并清零、越界槽位隔离、dispose 清空已占用单元；
 * 2. labelCellUv：256 个 256×64 单元在 2048×2048 画布上互不重叠且填满，
 *    v 轴按画布 y 翻转（纹理 v 向上）；
 * 3. badgeChipUv：7 个业务状态各占独立单元，null/UNKNOWN 返回零矩形隐藏；
 * 4. 真实工厂在无 Canvas 2D 环境（jsdom）下抛稳定错误码，调用方可降级。
 */
import { describe, expect, it } from 'vitest'
import { StructuredError } from '@/shared/diagnostics'
import {
  badgeChipUv,
  createLabelCellBook,
  createVehicleBadgeAtlas,
  createVehicleLabelAtlas,
  labelCellUv,
  LABEL_ATLAS_CELLS,
  LABEL_ATLAS_SIZE,
  LABEL_CELL_H_PX,
  LABEL_CELL_W_PX,
} from '../scene/labelAtlas'

/** 绘制回调记录器：断言「只重绘目标单元」的核心证据 */
function makeRecorder(capacity = 8) {
  const paints: [number, string | null][] = []
  const book = createLabelCellBook(capacity, (slot, text) => paints.push([slot, text]))
  return { book, paints }
}

describe('LabelCellBook 单元账本', () => {
  it('只重绘变化单元：同名幂等、改名仅重绘目标单元、清空幂等', () => {
    const { book, paints } = makeRecorder()
    expect(book.ensureCell(1, 'AGV-01')).toBe(true)
    expect(book.ensureCell(1, 'AGV-01')).toBe(false) // 同名 no-op
    expect(book.ensureCell(2, 'AGV-02')).toBe(true)
    expect(book.ensureCell(1, 'AGV-01-R')).toBe(true) // 只重绘 1 号单元
    expect(paints).toEqual([
      [1, 'AGV-01'],
      [2, 'AGV-02'],
      [1, 'AGV-01-R'],
    ])
    expect(book.clearCell(2)).toBe(true)
    expect(book.clearCell(2)).toBe(false) // 已空 no-op
    expect(book.textAt(2)).toBe(null)
    expect(book.textAt(1)).toBe('AGV-01-R')
  })

  it('中文与含空格名称原样进入绘制回调（中文名称可用）', () => {
    const { book, paints } = makeRecorder()
    book.ensureCell(0, '包装车 07')
    book.ensureCell(3, '喷涂车间-3号')
    expect(paints).toEqual([
      [0, '包装车 07'],
      [3, '喷涂车间-3号'],
    ])
  })

  it('flushDirty 计数自上次清零以来的重绘次数；越界槽位为 no-op', () => {
    const { book, paints } = makeRecorder()
    book.ensureCell(0, 'A')
    book.ensureCell(1, 'B')
    expect(book.flushDirty()).toBe(2)
    expect(book.flushDirty()).toBe(0) // 清零后为 0
    expect(book.ensureCell(0, 'A')).toBe(false) // 同名不计数
    expect(book.flushDirty()).toBe(0)
    // 越界槽位：不绘制、不计数（逐项隔离，不抛异常）
    expect(book.ensureCell(-1, 'X')).toBe(false)
    expect(book.ensureCell(99, 'X')).toBe(false)
    expect(book.clearCell(99)).toBe(false)
    expect(paints).toHaveLength(2)
  })

  it('dispose 清空全部已占用单元（回收语义的兜底路径）', () => {
    const { book, paints } = makeRecorder()
    book.ensureCell(0, 'A')
    book.ensureCell(5, 'E')
    book.dispose()
    expect(book.textAt(0)).toBe(null)
    expect(book.textAt(5)).toBe(null)
    expect(paints.slice(2)).toEqual([
      [0, null],
      [5, null],
    ])
  })
})

describe('labelCellUv 单元排布', () => {
  it('256 个 256×64 单元互不重叠、恰好铺满 2048×2048，v 轴按画布翻转', () => {
    const cellsPerRow = LABEL_ATLAS_SIZE / LABEL_CELL_W_PX
    const rows = LABEL_ATLAS_SIZE / LABEL_CELL_H_PX
    expect(cellsPerRow * rows).toBe(LABEL_ATLAS_CELLS)
    // 单元边界全部落在 1/2048 网格上，且 (列, 行) 坐标两两不同：
    // 等尺寸单元网格坐标唯一 ⇔ 互不重叠 ⇔ 恰好铺满 8×32 网格
    const seen = new Set<string>()
    for (let slot = 0; slot < LABEL_ATLAS_CELLS; slot += 1) {
      const uv = labelCellUv(slot)
      expect(uv.u0).toBeGreaterThanOrEqual(0)
      expect(uv.u1).toBeLessThanOrEqual(1)
      expect(uv.v0).toBeGreaterThanOrEqual(0)
      expect(uv.v1).toBeLessThanOrEqual(1)
      expect(uv.u1).toBeGreaterThan(uv.u0)
      expect(uv.v1).toBeGreaterThan(uv.v0)
      const col = Math.round(uv.u0 * LABEL_ATLAS_SIZE / LABEL_CELL_W_PX)
      const row = Math.round((1 - uv.v1) * LABEL_ATLAS_SIZE / LABEL_CELL_H_PX)
      const key = `${col},${row}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
    expect(seen.size).toBe(LABEL_ATLAS_CELLS)
  })

  it('首单元、次行行首与末单元的边界 UV 正确', () => {
    const first = labelCellUv(0)
    expect(first.u0).toBe(0)
    expect(first.v1).toBe(1)
    expect(first.v0).toBeCloseTo(1 - LABEL_CELL_H_PX / LABEL_ATLAS_SIZE, 12)
    const secondRow = labelCellUv(LABEL_ATLAS_SIZE / LABEL_CELL_W_PX)
    expect(secondRow.u0).toBe(0)
    expect(secondRow.v1).toBeCloseTo(first.v0, 12)
    const last = labelCellUv(LABEL_ATLAS_CELLS - 1)
    expect(last.u1).toBe(1)
    expect(last.v0).toBe(0)
  })
})

describe('badgeChipUv 状态芯片查表', () => {
  it('7 个业务状态各占独立单元且不重叠；null 返回零矩形（隐藏）', () => {
    const operations = [
      'FAULT',
      'PAUSED',
      'CHARGING',
      'TRAFFIC_WAIT',
      'EXECUTING',
      'IDLE',
      'UNKNOWN',
    ] as const
    const seen: string[] = []
    for (const operation of operations) {
      const [u0, v0, u1, v1] = badgeChipUv(operation)
      expect(v0).toBe(0)
      expect(v1).toBe(1)
      expect(u1).toBeGreaterThan(u0)
      // 单元区间互不重叠
      const key = `${u0}`
      expect(seen).not.toContain(key)
      seen.push(key)
    }
    // null → 零矩形；UNKNOWN 的芯片隐藏决策在 labelChipOf（返回 null），
    // 查表本身对 7 个固定状态都给出合法单元
    expect(badgeChipUv(null)).toEqual([0, 0, 0, 0])
  })
})

describe('真实图集工厂在无 Canvas 2D 环境降级', () => {
  it('抛出 VEHICLE_LABEL_ATLAS_UNAVAILABLE 的 StructuredError（调用方降级为无标签层）', () => {
    for (const factory of [createVehicleLabelAtlas, createVehicleBadgeAtlas]) {
      try {
        factory()
        expect.unreachable('jsdom 无 2D 上下文时必须抛出')
      } catch (error) {
        expect(error).toBeInstanceOf(StructuredError)
        expect((error as StructuredError).code).toBe('VEHICLE_LABEL_ATLAS_UNAVAILABLE')
      }
    }
  })
})
