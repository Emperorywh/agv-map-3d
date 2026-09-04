/**
 * 车辆标签图集（SPEC §5.1、§6.4、§7.2；TASK-011）。
 *
 * 职责：
 * 1. createLabelCellBook：纯图集单元账本——「槽位 → 已绘文字」缓存、按需
 *    重绘回调与脏计数；同名重绘、对空单元清除均为 no-op，供测试以注入
 *    回调完整复现真实画布行为；
 * 2. createVehicleLabelAtlas：真实 2048×2048 Canvas 工厂——256 个 256×64
 *    名称槽（8 列 × 32 行），名称增加或变化只重绘目标单元，flush 每帧至多
 *    触发一次纹理上载；中文名称可用（与地图名称同一字体栈）；
 * 3. createVehicleBadgeAtlas：7 个业务状态芯片的固定小图集——启动时一次性
 *    栅格化、全批次共享、永不重绘；chipUvOf 提供状态 → 图集 UV 的纯查表。
 * 边界：本模块是车辆标签的唯一栅格化入口；不使用 DOM/drei Html/每车独立
 *       Sprite 或材质；地图名称图集属 map-visualization（两者互不共享）。
 *       状态色、电量条、选中态与告警态不进入名称纹理——它们由标签材质的
 *       实例属性与 shader 绘制（SPEC §6.4），电量变化绝不触碰本模块。
 * 关键不变量：
 * 1. 单元即槽位：名称槽序号与实例槽位序号一一对应（cell = slot），本模块
 *    不做二次分配——槽位的分配/回收由实例槽位表驱动 ensureCell/clearCell；
 * 2. 只重绘变化单元：内容相同的 ensureCell 与已为空的 clearCell 都是 no-op，
 *    绘制以单元裁剪（clip），文字绝不溢出到相邻槽位；
 * 3. 上载合并：一帧内多次绘制只累计脏计数，flush 后由调用方置一次
 *    texture.needsUpdate（带 mipmap 的整纹理上载，名称变化为低频事件）；
 * 4. 环境无 Canvas 2D 上下文时抛稳定错误码 VEHICLE_LABEL_ATLAS_UNAVAILABLE，
 *    调用方降级为不显示标签并记录诊断，不阻断车辆主体渲染。
 */
import * as THREE from 'three'
import { StructuredError } from '@/shared/diagnostics'
import type { VehicleOperation } from '../model/types'
import { LABEL_FONT_FAMILY, shellColorOf } from './fleetAppearance'

/** 名称图集几何：2048×2048 画布容纳 256 个 256×64 名称槽（8 列 × 32 行） */
export const LABEL_ATLAS_SIZE = 2048
export const LABEL_CELL_W_PX = 256
export const LABEL_CELL_H_PX = 64
export const LABEL_ATLAS_CELLS = 256
const LABEL_CELLS_PER_ROW = LABEL_ATLAS_SIZE / LABEL_CELL_W_PX

/** 名称文字在单元内占用的水平比例：右侧留给状态芯片（芯片由 shader 绘制） */
export const LABEL_NAME_AREA_MAX_FRAC = 0.66
/** 名称字号（像素）：单元高 64px 内的平衡值（描边 + 中英均可读） */
export const LABEL_FONT_PX = 24

/** 图集单元的归一化 UV 矩形（纹理 v 向上，画布 y 向下已翻转） */
export interface LabelCellUv {
  readonly u0: number
  readonly v0: number
  readonly u1: number
  readonly v1: number
}

/** 槽位序号 → 图集 UV 矩形（纯函数，槽位即单元序号） */
export function labelCellUv(slot: number): LabelCellUv {
  const col = slot % LABEL_CELLS_PER_ROW
  const row = Math.floor(slot / LABEL_CELLS_PER_ROW)
  const x0 = col * LABEL_CELL_W_PX
  const y0 = row * LABEL_CELL_H_PX
  return {
    u0: x0 / LABEL_ATLAS_SIZE,
    u1: (x0 + LABEL_CELL_W_PX) / LABEL_ATLAS_SIZE,
    v0: 1 - (y0 + LABEL_CELL_H_PX) / LABEL_ATLAS_SIZE,
    v1: 1 - y0 / LABEL_ATLAS_SIZE,
  }
}

/**
 * 纯图集单元账本：内容缓存 + 按需重绘。onPaint(slot, text|null) 的 text 为
 * null 表示清除该单元。全部绘制都经内容比对去重——「只重绘目标单元」。
 */
export interface LabelCellBook {
  /** 确保单元内容为 text；实际重绘返回 true，内容未变化为 no-op 返回 false */
  ensureCell(slot: number, text: string): boolean
  /** 清除单元；已为空为 no-op 返回 false */
  clearCell(slot: number): boolean
  /** 查询单元当前文字（空单元为 null） */
  textAt(slot: number): string | null
  /** 自上次 flush 以来的重绘/清除次数，并清零计数（帧末合并上载用） */
  flushDirty(): number
  /** 清空全部单元（对已占用单元逐个回调清除） */
  dispose(): void
}

export function createLabelCellBook(
  capacity: number,
  onPaint: (slot: number, text: string | null) => void,
): LabelCellBook {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError('图集单元容量必须为正整数')
  }
  const cells: (string | null)[] = new Array<string | null>(capacity).fill(null)
  let dirtyCount = 0

  return {
    ensureCell(slot, text) {
      if (slot < 0 || slot >= capacity) {
        return false
      }
      if (cells[slot] === text) {
        return false
      }
      cells[slot] = text
      dirtyCount += 1
      onPaint(slot, text)
      return true
    },
    clearCell(slot) {
      if (slot < 0 || slot >= capacity || cells[slot] === null) {
        return false
      }
      cells[slot] = null
      dirtyCount += 1
      onPaint(slot, null)
      return true
    },
    textAt: (slot) => (slot >= 0 && slot < capacity ? cells[slot] : null),
    flushDirty() {
      const count = dirtyCount
      dirtyCount = 0
      return count
    },
    dispose() {
      for (let slot = 0; slot < capacity; slot += 1) {
        if (cells[slot] !== null) {
          cells[slot] = null
          onPaint(slot, null)
        }
      }
      dirtyCount = 0
    },
  }
}

/** 已构建的车辆名称图集：纹理 + 单元账本；纹理由本对象拥有并释放 */
export interface VehicleLabelAtlas {
  /** 生产实现为 CanvasTexture；材质只依赖 Texture 基类（测试可注入替身） */
  readonly texture: THREE.Texture
  readonly book: LabelCellBook
  /** 槽位 → UV 矩形（单元即槽位，纯查表） */
  cellUv(slot: number): LabelCellUv
  /** 帧末合并上载：有重绘时置一次 texture.needsUpdate */
  flush(): void
  /** 幂等释放纹理 */
  dispose(): void
}

/**
 * 真实名称图集工厂：2048×2048 Canvas + 256 个 256×64 槽。
 * 无 2D 上下文（如 jsdom 测试环境）时抛 VEHICLE_LABEL_ATLAS_UNAVAILABLE，
 * 由调用方降级为不渲染标签层并记录诊断。
 */
export function createVehicleLabelAtlas(): VehicleLabelAtlas {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (context === null) {
    throw new StructuredError({
      code: 'VEHICLE_LABEL_ATLAS_UNAVAILABLE',
      message: '当前环境无 Canvas 2D 上下文，车辆标签层降级为不显示',
      context: { atlasSize: LABEL_ATLAS_SIZE, cells: LABEL_ATLAS_CELLS },
    })
  }
  canvas.width = LABEL_ATLAS_SIZE
  canvas.height = LABEL_ATLAS_SIZE

  // 单元绘制：深色描边 + 白色填充（任意状态底色上可读），按单元裁剪防溢出
  const paint = (slot: number, text: string | null): void => {
    const col = slot % LABEL_CELLS_PER_ROW
    const row = Math.floor(slot / LABEL_CELLS_PER_ROW)
    const x0 = col * LABEL_CELL_W_PX
    const y0 = row * LABEL_CELL_H_PX
    context.clearRect(x0, y0, LABEL_CELL_W_PX, LABEL_CELL_H_PX)
    if (text === null || text.length === 0) {
      return
    }
    context.save()
    context.beginPath()
    context.rect(x0, y0, LABEL_CELL_W_PX, LABEL_CELL_H_PX)
    context.clip()
    const font = `600 ${LABEL_FONT_PX}px ${LABEL_FONT_FAMILY}`
    context.font = font
    context.textAlign = 'left'
    context.textBaseline = 'middle'
    // 名称绘制在单元左侧（右侧留白给状态芯片），垂直居中
    const textX = x0 + 10
    const textY = y0 + LABEL_CELL_H_PX / 2
    context.lineWidth = 3
    context.strokeStyle = 'rgba(8, 10, 14, 0.9)'
    context.strokeText(text, textX, textY)
    context.fillStyle = '#ffffff'
    context.fillText(text, textX, textY)
    context.restore()
  }

  const book = createLabelCellBook(LABEL_ATLAS_CELLS, paint)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 4

  return {
    texture,
    book,
    cellUv: (slot) => labelCellUv(slot),
    flush() {
      if (book.flushDirty() > 0) {
        texture.needsUpdate = true
      }
    },
    dispose() {
      /**
       * 开发严格模式会在清理后复用同一纹理并重新上传，不能永久标记为已释放。
       * 底层纹理释放本身安全可重复，真正卸载时再次释放当前 GPU 分配。
       */
      book.dispose()
      texture.dispose()
    },
  }
}

/* ==================== 状态芯片副徽标图集（固定内容，全批次共享） ==================== */

/** 芯片图集几何：1024×32 画布，8 个 128×32 单元（7 个业务状态 + 1 备用） */
export const BADGE_ATLAS_W_PX = 1024
export const BADGE_ATLAS_H_PX = 32
export const BADGE_CELL_W_PX = 128
const BADGE_CELL_COUNT = BADGE_ATLAS_W_PX / BADGE_CELL_W_PX

/** 芯片图集的固定状态次序（下标即单元序号；第 8 格留空备用） */
const BADGE_OPERATIONS: readonly VehicleOperation[] = [
  'FAULT',
  'PAUSED',
  'CHARGING',
  'TRAFFIC_WAIT',
  'EXECUTING',
  'IDLE',
  'UNKNOWN',
]

const BADGE_ZERO_UV: readonly [number, number, number, number] = [0, 0, 0, 0]

/** 状态 → 芯片图集 UV（纯查表）；null/UNKNOWN 返回零矩形（shader 端隐藏） */
export function badgeChipUv(operation: VehicleOperation | null): readonly [number, number, number, number] {
  if (operation === null) {
    return BADGE_ZERO_UV
  }
  const index = BADGE_OPERATIONS.indexOf(operation)
  if (index < 0 || index >= BADGE_CELL_COUNT) {
    return BADGE_ZERO_UV
  }
  const u0 = index / BADGE_CELL_COUNT
  const u1 = (index + 1) / BADGE_CELL_COUNT
  return [u0, 0, u1, 1]
}

/** 已构建的状态芯片图集；纹理由本对象拥有并释放 */
export interface VehicleBadgeAtlas {
  readonly texture: THREE.Texture
  /** 幂等释放纹理 */
  dispose(): void
}

/**
 * 状态芯片图集工厂：按固定状态次序把「彩色圆角芯片 + 白色状态文字」一次性
 * 栅格化。芯片颜色与主状态车体色同表（shellColorOf），副徽标保留最后已知
 * 业务状态的颜色语义。无 2D 上下文时抛 VEHICLE_LABEL_ATLAS_UNAVAILABLE。
 */
export function createVehicleBadgeAtlas(): VehicleBadgeAtlas {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (context === null) {
    throw new StructuredError({
      code: 'VEHICLE_LABEL_ATLAS_UNAVAILABLE',
      message: '当前环境无 Canvas 2D 上下文，车辆标签层降级为不显示',
      context: { width: BADGE_ATLAS_W_PX, height: BADGE_ATLAS_H_PX },
    })
  }
  canvas.width = BADGE_ATLAS_W_PX
  canvas.height = BADGE_ATLAS_H_PX

  const font = `600 16px ${LABEL_FONT_FAMILY}`
  for (let index = 0; index < BADGE_OPERATIONS.length; index += 1) {
    const operation = BADGE_OPERATIONS[index]
    const x0 = index * BADGE_CELL_W_PX
    context.save()
    context.beginPath()
    context.rect(x0, 0, BADGE_CELL_W_PX, BADGE_ATLAS_H_PX)
    context.clip()
    // 芯片底色 = 该业务状态的车体色（同表映射，保持全场景色彩语义一致）
    context.fillStyle = shellColorOf(operation)
    roundRect(context, x0 + 3, 4, BADGE_CELL_W_PX - 6, BADGE_ATLAS_H_PX - 8, 6)
    context.fill()
    context.font = font
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillStyle = '#ffffff'
    context.fillText(operation, x0 + BADGE_CELL_W_PX / 2, BADGE_ATLAS_H_PX / 2)
    context.restore()
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false

  return {
    texture,
    dispose() {
      /**
       * 芯片图集同样允许严格模式清理后的重新上传。
       * 资源换代时总是发出释放事件，避免每次恢复遗留一张旧纹理。
       */
      texture.dispose()
    },
  }
}

/** 圆角矩形路径（Canvas 无原生 roundRect 时的最小实现） */
function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  context.beginPath()
  context.moveTo(x + r, y)
  context.lineTo(x + w - r, y)
  context.quadraticCurveTo(x + w, y, x + w, y + r)
  context.lineTo(x + w, y + h - r)
  context.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  context.lineTo(x + r, y + h)
  context.quadraticCurveTo(x, y + h, x, y + h - r)
  context.lineTo(x, y + r)
  context.quadraticCurveTo(x, y, x + r, y)
  context.closePath()
}
