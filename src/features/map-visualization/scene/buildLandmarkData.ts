/**
 * 地标语义实例数据构建（SPEC §2.1、§5.1；TASK-005；P0-5 移除仓库名称锚点与
 * 方垫；P2-2 停车点拆分为凸起 slab 数据）。
 *
 * 职责：遍历一次只读 MapModel，把业务语义整理为「纯数据」的实例变换，供
 *       LandmarksLayer 一次性创建静态合批 InstancedMesh：
 *       - charge 节点：充电桩立柱、底部光环、呼吸灯（与 P2-1 闪电贴花）共用
 *         的世界平移；
 *       - park 节点：凸起 slab 的平移+非等比缩放矩阵（P2-2）与停车符号字形
 *         的世界锚点。
 *       （视觉差距分析 P0-5：warehouse 节点的名称锚点与地面方垫已整体移除——
 *       Reference 中不存在仓库标识文字与方垫。）
 * 边界：输入必须来自 createMapModel 的只读 MapModel（已校验、有限坐标）；
 *       本模块不创建 Three.js 对象、不进 React、不知道图集存在（名称锚点
 *       由图层与图集单元 join）。position 逐项取自节点坐标，无引用可悬空。
 * 关键不变量：
 * 1. 数量恒等：pile/ring/light 平移数 = charge 节点数；停车 slab 数 = park
 *    锚点数 = park 节点数（当前地图 59 / 2）；
 * 2. 矩阵为列主序 4×4，只含平移（桩/灯/环/名称）或平移+xz/sy 非等比缩放
 *    （停车 slab），旋转恒为单位——地标不依赖可能为 null 的节点 angle；
 * 3. 停车 slab 为单一语义色（紫），由图层材质直接取色、不走实例颜色；
 * 4. 世界坐标只经统一 WorldTransform 转换一次，与路径/节点图层完全同源
 *    （SPEC §2.5：所有对象复用同一坐标转换）。
 */
import type { MapModel } from '../model/types'
import type { WorldTransform } from '@/shared/spatial'
import {
  PARK_PAD_SIZE_M,
  PARK_SLAB_HALO_SIZE_RATIO,
  PARK_SLAB_HEIGHT_M,
} from './mapAppearance'

/** 停车符号字形锚点（紫色方垫中心） */
export interface ParkGlyphAnchor {
  readonly nodeId: string
  readonly x: number
  readonly z: number
}

/** 地标实例静态数据（纯 Float32Array 与只读锚点，无 GPU 对象） */
export interface LandmarkData {
  /** charge 节点数：立柱/光环/呼吸灯/闪电贴花实例的实例数 */
  readonly chargeCount: number
  /** 立柱/呼吸灯/光环/闪电贴花共用的世界平移矩阵（列主序 16×chargeCount） */
  readonly chargeMatrices: Float32Array
  /** 停车凸起 slab 实例数 = park 节点数 */
  readonly parkSlabCount: number
  /** 停车 slab 平移+非等比缩放矩阵（列主序 16×parkSlabCount） */
  readonly parkSlabMatrices: Float32Array
  /** 停车微光光晕平移+缩放矩阵（列主序 16×parkSlabCount；P2-2，与 slab 一一对应） */
  readonly parkHaloMatrices: Float32Array
  /** 停车符号锚点（数量 = park 节点数） */
  readonly parkAnchors: readonly ParkGlyphAnchor[]
}

/**
 * 构建地标实例静态数据。单次遍历节点列表，每类语义各自累积；世界坐标由
 * worldTransform.toWorldXZ 统一转换（原点为地图包围盒中心）。
 */
export function buildLandmarkData(
  mapModel: MapModel,
  worldTransform: WorldTransform,
): LandmarkData {
  const chargePositions: { x: number; z: number }[] = []
  const slabMatrices: number[] = []
  const haloMatrices: number[] = []
  const parkAnchors: ParkGlyphAnchor[] = []

  for (const node of mapModel.nodeList) {
    const world = worldTransform.toWorldXZ(node.x, node.y)
    if (node.category === 'charge') {
      chargePositions.push({ x: world.x, z: world.z })
      continue
    }
    if (node.category === 'warehouse') {
      // P0-5：仓库节点的方垫与名称锚点均已整体移除
      continue
    }
    if (node.category === 'park') {
      pushSlabMatrix(slabMatrices, world.x, world.z, PARK_PAD_SIZE_M, PARK_SLAB_HEIGHT_M)
      pushHaloMatrix(haloMatrices, world.x, world.z, PARK_PAD_SIZE_M * PARK_SLAB_HALO_SIZE_RATIO)
      parkAnchors.push({ nodeId: node.id, x: world.x, z: world.z })
    }
  }

  const chargeCount = chargePositions.length
  const chargeMatrices = new Float32Array(chargeCount * 16)
  for (let i = 0; i < chargePositions.length; i += 1) {
    writeTranslation(chargeMatrices, i * 16, chargePositions[i].x, 0, chargePositions[i].z)
  }

  return {
    chargeCount,
    chargeMatrices,
    parkSlabCount: parkAnchors.length,
    parkSlabMatrices: new Float32Array(slabMatrices),
    parkHaloMatrices: new Float32Array(haloMatrices),
    parkAnchors: Object.freeze(parkAnchors),
  }
}

/**
 * 追加停车 slab 的「平移 + xz/sy 非等比缩放」列主序矩阵：几何底面烘焙在
 * y=0（单位盒上移 0.5），矩阵只给足迹边长、板厚与地面平移。
 */
function pushSlabMatrix(
  target: number[],
  x: number,
  z: number,
  sizeM: number,
  heightM: number,
): void {
  pushScaleMatrix(target, x, z, sizeM, heightM, 0)
}

/** 追加停车微光光晕的「平移 + xz 等比缩放」矩阵（高度烘焙在光晕几何内） */
function pushHaloMatrix(
  target: number[],
  x: number,
  z: number,
  sizeM: number,
): void {
  pushScaleMatrix(target, x, z, sizeM, 1, 0)
}

/** 追加「平移 + xz 等比 + y 独立缩放」的列主序矩阵（y 平移 = 基线高度） */
function pushScaleMatrix(
  target: number[],
  x: number,
  z: number,
  sizeM: number,
  scaleY: number,
  y: number,
): void {
  const base = target.length
  for (let i = 0; i < 16; i += 1) {
    target.push(i === 0 || i === 5 || i === 10 || i === 15 ? 1 : 0)
  }
  target[base] = sizeM
  target[base + 5] = scaleY
  target[base + 10] = sizeM
  target[base + 12] = x
  target[base + 13] = y
  target[base + 14] = z
}

/** 写入一个「仅平移」的列主序单位矩阵 */
function writeTranslation(
  target: Float32Array,
  offset: number,
  x: number,
  y: number,
  z: number,
): void {
  target[offset] = 1
  target[offset + 5] = 1
  target[offset + 10] = 1
  target[offset + 12] = x
  target[offset + 13] = y
  target[offset + 14] = z
  target[offset + 15] = 1
}
