/**
 * 车辆标签图集（SPEC §5.1、§6.4、§7.2；TASK-011）。
 *
 * 职责：
 * 1. createLabelCellBook：纯图集单元账本——「槽位 → 已绘文字」缓存、按需
 *    重绘回调与脏计数；同名重绘、对空单元清除均为 no-op，供测试以注入
 *    回调完整复现真实画布行为；
 * 2. createVehicleLabelAtlas：真实 2048×4096 Canvas 工厂——256 个 256×128
 *    双行槽（8 列 × 32 行），编号或速度变化只重绘目标单元，flush 每帧至多
 *    触发一次纹理上载；中文名称可用（与地图名称同一字体栈）；
 * 3. createVehicleBadgeAtlas：完整业务状态芯片的固定小图集——启动时一次性
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
 *    texture.needsUpdate（带 mipmap 的整纹理上载，速度按显示精度去重）；
 * 4. 环境无 Canvas 2D 上下文时抛稳定错误码 VEHICLE_LABEL_ATLAS_UNAVAILABLE，
 *    调用方降级为不显示标签并记录诊断，不阻断车辆主体渲染。
 */
import * as THREE from 'three'
import { StructuredError } from '@/shared/diagnostics'
import type { VehicleOperation } from '../model/types'
import { LABEL_FONT_FAMILY, LABEL_TEXT_COLOR, VEHICLE_STATE_LABELS } from './fleetAppearance'

/**
 * 两行面板使用二比一单元，画布纵向扩展以保留每批次二百五十六个槽位。
 * 横向尺寸与实例分配保持一致，纵向尺寸单独用于画布与纹理坐标换算。
 */
export const LABEL_ATLAS_SIZE = 2048
export const LABEL_ATLAS_HEIGHT = 4096
export const LABEL_CELL_W_PX = 256
export const LABEL_CELL_H_PX = 128
export const LABEL_ATLAS_CELLS = 256
const LABEL_CELLS_PER_ROW = LABEL_ATLAS_SIZE / LABEL_CELL_W_PX

/**
 * 首行右侧留给状态灯，文字过长时省略而不挤压灯的位置。
 * 第二行字号略小，与中间电量条共同组成紧凑的信息层次。
 */
export const LABEL_NAME_AREA_MAX_FRAC = 0.75
export const LABEL_FONT_PX = 23

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
    v0: 1 - (y0 + LABEL_CELL_H_PX) / LABEL_ATLAS_HEIGHT,
    v1: 1 - y0 / LABEL_ATLAS_HEIGHT,
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
 * 真实名称图集工厂：2048×4096 Canvas + 256 个 256×128 双行槽。
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
  canvas.height = LABEL_ATLAS_HEIGHT

  /**
   * 首行绘制蓝色编号，次行绘制实际速度；状态与电量继续交给背景着色器。
   * 去掉旧版深色描边，保留单元裁剪并逐字省略长名称，防止覆盖状态灯。
   */
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
    const [name, speed] = text.split('\n')
    const textX = x0 + 18
    const maxWidth = LABEL_CELL_W_PX * LABEL_NAME_AREA_MAX_FRAC
    const characters = Array.from(name)
    const originalLength = characters.length
    while (characters.length > 0 && context.measureText(characters.join('') + (characters.length < originalLength ? '…' : '')).width > maxWidth) {
      characters.pop()
    }
    const title = characters.join('') + (characters.length < originalLength ? '…' : '')
    context.fillStyle = LABEL_TEXT_COLOR
    context.fillText(title, textX, y0 + LABEL_CELL_H_PX * 0.24)
    if (speed !== undefined) {
      context.font = `500 19px ${LABEL_FONT_FAMILY}`
      context.fillText(speed, textX, y0 + LABEL_CELL_H_PX * 0.76, LABEL_CELL_W_PX * 0.46)
    }
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

/**
 * 扩展为十六个状态单元，新增在线、避障、抱闸后仍保留空位。
 * 单元大小保持不变，现有标签着色器继续按查表得到的矩形采样。
 */
export const BADGE_ATLAS_W_PX = 2048
export const BADGE_ATLAS_H_PX = 32
export const BADGE_CELL_W_PX = 128
const BADGE_CELL_COUNT = BADGE_ATLAS_W_PX / BADGE_CELL_W_PX

/**
 * 固定次序保留原有七个状态槽，新增业务状态放在尾部。
 * 中英文显示均从共享状态字典获得，避免颜色与文字各自维护。
 */
const BADGE_OPERATIONS: readonly VehicleOperation[] = [
  'FAULT',
  'PAUSED',
  'CHARGING',
  'TRAFFIC_WAIT',
  'EXECUTING',
  'IDLE',
  'UNKNOWN',
  'ONLINE',
  'AVOIDING',
  'BRAKED',
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
 * 状态文字固定绘制成透明底蓝字，放在面板右下角，与参考图次行对齐。
 * 状态颜色由右上圆点表达，避免彩色芯片打断浅色面板的整体布局。
 * 无二维上下文时沿用原有降级路径，不影响车体渲染。
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

  const font = `500 19px ${LABEL_FONT_FAMILY}`
  for (let index = 0; index < BADGE_OPERATIONS.length; index += 1) {
    const operation = BADGE_OPERATIONS[index]
    const x0 = index * BADGE_CELL_W_PX
    context.save()
    context.beginPath()
    context.rect(x0, 0, BADGE_CELL_W_PX, BADGE_ATLAS_H_PX)
    context.clip()
    context.font = font
    context.textAlign = 'right'
    context.textBaseline = 'middle'
    context.fillStyle = LABEL_TEXT_COLOR
    /**
     * 使用中文状态名称辅助区分相近色系，保留既有副徽标布局。
     * 灯光颜色与文字来自同一状态键，避免展示内部英文派生名。
     */
    context.fillText(VEHICLE_STATE_LABELS[operation], x0 + BADGE_CELL_W_PX - 4, BADGE_ATLAS_H_PX / 2, BADGE_CELL_W_PX - 8)
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
