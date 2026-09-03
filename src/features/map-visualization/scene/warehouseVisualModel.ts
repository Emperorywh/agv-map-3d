/**
 * 仓储聚合视觉模型（视觉对齐改造 P0-5.5）。
 *
 * 职责：把 1,185 个 warehouse 节点从「逐点方垫」聚合为少量可理解的展示单
 *       元——仓储区域（zone，节点间距聚类 + 凸包轮廓）与货架行（row，区
 *       域内按主轴方向 + 副轴投影间距聚类得到的有向矩形）。渲染层据此：
 *       全厂总览只显示区域色块、作业区显示货架行轮廓、车辆近景才显示单个
 *       库位方垫（由场景等级门控，见 sceneDetail）。
 * 边界：纯数据聚类，不创建 Three.js 对象、不进 React；输入为只读 MapModel
 *       与统一 WorldTransform。本模块的聚类是「缺少显式视觉配置时的降级启
 *       发式」（按间距、共线关系与方向），结论必须允许未来被独立视觉配置
 *       （仓储区域 ID/多边形/行列/朝向）覆盖（改造说明 §5.5）。
 * 关键不变量：
 * 1. 每个仓库节点恰好归属一个 zone 与一个 row（或退化单点行），聚合无遗
 *    漏、无重复；世界坐标只经统一 WorldTransform 转换一次；
 * 2. 空间网格近邻查询：间距阈值聚类按 3×3 邻域查格，构建耗时与节点数近
 *    线性（1,185 节点一次性构建，不在帧循环内）；
 * 3. 行矩形由成员点在主轴/副轴上的投影包络决定，角度取区域主轴方向（协
 *    方差主特征向量）；L 形等非凸区域的行方向是近似，允许配置覆盖。
 */
import type { MapModel } from '../model/types'
import type { WorldTransform } from '@/shared/spatial'
import {
  WAREHOUSE_CLUSTER_SPACING_M,
  WAREHOUSE_ROW_END_PAD_M,
  WAREHOUSE_ROW_GAP_M,
  WAREHOUSE_ROW_MIN_WIDTH_M,
} from './mapAppearance'
import { convexHull2D } from './hull2d'

/** 仓储区域（zone）：一组相邻仓库节点的凸包轮廓块（总览色块语义） */
export interface WarehouseZone {
  /** 区域序号：按成员首节点出现顺序稳定编号 */
  readonly index: number
  readonly nodeIds: readonly string[]
  /** 区域凸包顶点（世界坐标，xz 平面；按成员点集凸包） */
  readonly hull: readonly { readonly x: number; readonly z: number }[]
  /** 区域成员中心（世界坐标，诊断与测试用） */
  readonly centerX: number
  readonly centerZ: number
  readonly rows: readonly WarehouseRow[]
}

/** 货架行（row）：区域内一条共线仓库节点的有向矩形轮廓（作业区语义） */
export interface WarehouseRow {
  /** 行中心（世界坐标） */
  readonly centerX: number
  readonly centerZ: number
  /** 行方向角（弧度，绕 y 轴；主轴方向） */
  readonly angle: number
  /** 行轮廓长（主轴方向，米）与宽（副轴方向，米） */
  readonly lengthM: number
  readonly widthM: number
  readonly nodeIds: readonly string[]
}

/** 仓储聚合结果（纯数据） */
export interface WarehouseVisualModel {
  readonly zones: readonly WarehouseZone[]
  /** 全部货架行数（诊断与测试用） */
  readonly rowCount: number
}

/**
 * 构建仓储聚合视觉模型：间距聚类成 zone → 协方差主轴定方向 → 副轴投影一
 * 维间距聚类成行。单节点 zone 退化为单点行（轮廓 = 最小可读方垫尺寸）。
 */
export function buildWarehouseVisualModel(
  mapModel: MapModel,
  worldTransform: WorldTransform,
): WarehouseVisualModel {
  const nodes = mapModel.nodeList.filter((node) => node.category === 'warehouse')
  if (nodes.length === 0) {
    return { zones: Object.freeze([]), rowCount: 0 }
  }

  const points = nodes.map((node) => worldTransform.toWorldXZ(node.x, node.y))

  // —— 间距聚类（并查集 + 空间网格 3×3 邻域）——
  const spacing = WAREHOUSE_CLUSTER_SPACING_M
  const cellSize = Math.max(spacing, 1e-3)
  const grid = new Map<string, number[]>()
  points.forEach((p, index) => {
    const key = `${Math.floor(p.x / cellSize)},${Math.floor(p.z / cellSize)}`
    const list = grid.get(key)
    if (list === undefined) {
      grid.set(key, [index])
    } else {
      list.push(index)
    }
  })
  const parent = Array.from({ length: nodes.length }, (_, i) => i)
  const find = (x: number): number => {
    let root = x
    while (parent[root] !== root) {
      root = parent[root]
    }
    while (parent[x] !== root) {
      const next = parent[x]
      parent[x] = root
      x = next
    }
    return root
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) {
      parent[rb] = ra
    }
  }
  points.forEach((p, index) => {
    const gx = Math.floor(p.x / cellSize)
    const gz = Math.floor(p.z / cellSize)
    for (let ox = -1; ox <= 1; ox += 1) {
      for (let oz = -1; oz <= 1; oz += 1) {
        const neighbors = grid.get(`${gx + ox},${gz + oz}`)
        if (neighbors === undefined) {
          continue
        }
        for (const other of neighbors) {
          if (other > index) {
            const q = points[other]
            if (Math.hypot(q.x - p.x, q.z - p.z) <= spacing) {
              union(index, other)
            }
          }
        }
      }
    }
  })

  // 根 → 成员索引（保持节点出现顺序）
  const membersByRoot = new Map<number, number[]>()
  for (let index = 0; index < nodes.length; index += 1) {
    const root = find(index)
    const list = membersByRoot.get(root)
    if (list === undefined) {
      membersByRoot.set(root, [index])
    } else {
      list.push(index)
    }
  }

  const zones: WarehouseZone[] = []
  let rowCount = 0
  for (const memberIndexes of membersByRoot.values()) {
    const memberPoints = memberIndexes.map((i) => points[i])
    const hull = convexHull2D(memberPoints)
    let centerX = 0
    let centerZ = 0
    for (const p of memberPoints) {
      centerX += p.x
      centerZ += p.z
    }
    centerX /= memberPoints.length
    centerZ /= memberPoints.length

    const rows = clusterRows(memberPoints, memberIndexes, nodes)
    rowCount += rows.length
    zones.push({
      index: zones.length,
      nodeIds: Object.freeze(memberIndexes.map((i) => nodes[i].id)),
      hull: Object.freeze(hull),
      centerX,
      centerZ,
      rows: Object.freeze(rows),
    })
  }

  return { zones: Object.freeze(zones), rowCount }
}

/**
 * 区域内货架行聚类：协方差主特征向量定主轴，成员向副轴投影后按一维间距
 * 阈值切分行；每行取主/副轴投影包络（加端部延伸与最小宽度）成有向矩形。
 */
function clusterRows(
  memberPoints: readonly { x: number; z: number }[],
  memberIndexes: readonly number[],
  nodes: readonly MapModel['nodeList'][number][],
): WarehouseRow[] {
  // 协方差主轴：2×2 对称矩阵特征向量解析解
  let mx = 0
  let mz = 0
  for (const p of memberPoints) {
    mx += p.x
    mz += p.z
  }
  mx /= memberPoints.length
  mz /= memberPoints.length
  let sxx = 0
  let szz = 0
  let sxz = 0
  for (const p of memberPoints) {
    sxx += (p.x - mx) ** 2
    szz += (p.z - mz) ** 2
    sxz += (p.x - mx) * (p.z - mz)
  }
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz)
  // 主轴（大特征值方向）与副轴
  const axisX = { x: Math.cos(theta), z: Math.sin(theta) }
  const axisZ = { x: -Math.sin(theta), z: Math.cos(theta) }

  // 副轴投影一维聚类（排序 + 间距阈值切分）
  interface Slot {
    readonly index: number
    readonly cross: number
  }
  const slots: Slot[] = memberPoints.map((p, i) => ({
    index: i,
    cross: p.x * axisZ.x + p.z * axisZ.z,
  }))
  slots.sort((a, b) => a.cross - b.cross)

  const groups: Slot[][] = []
  let current: Slot[] = [slots[0]]
  for (let i = 1; i < slots.length; i += 1) {
    if (slots[i].cross - slots[i - 1].cross <= WAREHOUSE_ROW_GAP_M) {
      current.push(slots[i])
    } else {
      groups.push(current)
      current = [slots[i]]
    }
  }
  groups.push(current)

  const rows: WarehouseRow[] = []
  for (const group of groups) {
    if (group.length === 0) {
      continue
    }
    let alongMin = Infinity
    let alongMax = -Infinity
    let crossMin = Infinity
    let crossMax = -Infinity
    for (const slot of group) {
      const p = memberPoints[slot.index]
      const along = p.x * axisX.x + p.z * axisX.z
      alongMin = Math.min(alongMin, along)
      alongMax = Math.max(alongMax, along)
      crossMin = Math.min(crossMin, slot.cross)
      crossMax = Math.max(crossMax, slot.cross)
    }
    // 中心由投影包络中点合成（世界坐标）
    const alongCenter = (alongMin + alongMax) / 2
    const crossCenter = (crossMin + crossMax) / 2
    rows.push({
      centerX: axisX.x * alongCenter + axisZ.x * crossCenter,
      centerZ: axisX.z * alongCenter + axisZ.z * crossCenter,
      angle: Math.atan2(axisX.z, axisX.x),
      lengthM:
        alongMax - alongMin + WAREHOUSE_ROW_END_PAD_M * 2,
      widthM: Math.max(
        crossMax - crossMin + WAREHOUSE_ROW_END_PAD_M * 2,
        WAREHOUSE_ROW_MIN_WIDTH_M,
      ),
      nodeIds: Object.freeze(group.map((slot) => nodes[memberIndexes[slot.index]].id)),
    })
  }
  return rows
}
