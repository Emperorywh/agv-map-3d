/**
 * 独占区静态几何构建（SPEC §2.3、§5.1、§11.12；TASK-005；P1-7 视觉差距修订）。
 *
 * 职责：把 7 个独占区分组的成员物理路径合并为一个低透明度蓝色外沿的静态
 *       BufferGeometry（全部分组共用一个几何 = 一个 Draw Call），并按视觉
 *       差距分析 P1-7（8.1 路线 2）新增「成员路径采样点凸包」的半透明面填
 *       充几何（第二个 Draw Call）——Reference 的独占区是「半透明蓝色面填
 *       充 + 亮色描边」，此前只有外沿条带。另为每个分组计算「成员节点包围
 *       盒中心」的名称锚点，供近景名称四边形合批。
 * 边界：输入为只读 MapModel、统一 WorldTransform 与 TASK-004 的物理路径索引
 *       （MapGeometry.physical）；本模块只产出几何与锚点，不创建材质/Mesh、
 *       不进 React；空间语义之外不参与任何调度或控制（SPEC §2.3）。
 * 关键不变量：
 * 1. 逐项隔离（SPEC §2.3/§11.12）：分组中引用不存在节点/边的成员只跳过该
 *    引用，不阻断分组其余成员，更不阻断其他分组——MapModel 经 validateMap
 *    后成员引用必然有效，此处跳过属于纵深防御，测试以手工模型直接驱动；
 * 2. 外沿的物理路径去重：同一分组的正反向成员边映射到同一物理路径时只画一
 *    条；多个分组共享的物理路径在全图范围内也只画一条。面填充按分组独立收
 *    集成员路径采样点（共享路径同时进入两个分组的凸包，区域语义正确）；
 * 3. 名称锚点 = 成员节点世界坐标的 AABB 中心（不是成员边几何），无有效成员
 *    节点的分组不产生锚点；
 * 4. 外沿条带宽度来自 mapAppearance（比路面宽），高度烘焙在
 *    EXCLUSIVE_OUTLINE_Y（路面之下），只露出宽出路面的蓝色边缘；面填充烘
 *    焙在 EXCLUSIVE_FILL_Y（外沿之上、路面之下），凸包沿边外扩
 *    EXCLUSIVE_FILL_PADDING_M 保证盖住路缘，退化（共线）时降级为包围矩形；
 * 5. 本模块创建的 BufferGeometry 由返回值 dispose() 明确释放（创建者释放），
 *    幂等可重复调用。
 */
import * as THREE from 'three'
import type { MapModel } from '../model/types'
import type { WorldTransform } from '@/shared/spatial'
import { appendPolylineStrip, type PhysicalPathIndex } from './buildMapGeometry'
import { appendConvexHullFill } from './hull2d'
import {
  EXCLUSIVE_FILL_PADDING_M,
  EXCLUSIVE_FILL_Y,
  EXCLUSIVE_OUTLINE_WIDTH_M,
  EXCLUSIVE_OUTLINE_Y,
} from './mapAppearance'

/** 独占区名称锚点：成员节点包围盒中心（世界坐标） */
export interface GroupNameAnchor {
  readonly groupId: string
  readonly name: string
  readonly x: number
  readonly z: number
}

/** 已构建的独占区静态几何（GPU 资源由本对象拥有并释放） */
export interface ExclusiveGroupsBuild {
  /** 全部分组成员物理路径合并的蓝色外沿条带（静态合批） */
  readonly outline: THREE.BufferGeometry
  /** 全部分组合并的半透明面填充（成员路径凸包，静态合批；P1-7） */
  readonly fill: THREE.BufferGeometry
  /** 每个含有效成员节点的分组一个名称锚点 */
  readonly nameAnchors: readonly GroupNameAnchor[]
  /** 实际参与外沿构建的物理路径数（跨分组去重后，测试与诊断用） */
  readonly usedPhysicalPathCount: number
  /** 释放本对象创建的全部 GPU 几何；幂等 */
  dispose(): void
}

/**
 * 构建独占区外沿几何与名称锚点。
 * 成员边 → 物理路径索引映射缺失的引用被跳过（隔离）；零长度段不产生几何。
 */
export function buildExclusiveGroupsGeometry(
  mapModel: MapModel,
  worldTransform: WorldTransform,
  physical: PhysicalPathIndex,
): ExclusiveGroupsBuild {
  const positions: number[] = []
  const indices: number[] = []
  const fillPositions: number[] = []
  const fillIndices: number[] = []
  const anchors: GroupNameAnchor[] = []
  // 物理路径全图去重：不同分组（或同分组正反向边）共享的路径只构建一次
  const usedPathIndexes = new Set<number>()
  const halfWidth = EXCLUSIVE_OUTLINE_WIDTH_M / 2

  for (const group of mapModel.groupList) {
    // 成员节点：包围盒中心（逐项跳过无法解析的引用——纵深防御）
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const nodeId of group.memberNodeIds) {
      const node = mapModel.nodes.get(nodeId)
      if (node === undefined) {
        continue
      }
      const world = worldTransform.toWorldXZ(node.x, node.y)
      if (world.x < minX) minX = world.x
      if (world.x > maxX) maxX = world.x
      if (world.z < minZ) minZ = world.z
      if (world.z > maxZ) maxZ = world.z
    }
    if (Number.isFinite(minX)) {
      anchors.push({
        groupId: group.id,
        name: group.name,
        x: (minX + maxX) / 2,
        z: (minZ + maxZ) / 2,
      })
    }

    // 成员边 → 物理路径（映射缺失的引用逐项跳过）。面填充按分组独立收集
    // 采样点（共享路径同属两个分组的凸包，区域语义正确）；外沿条带仍按全图
    // 去重：同一物理路径只画一条。
    const outlinePathIndexes: number[] = []
    const fillPoints: { x: number; z: number }[] = []
    for (const edgeId of group.memberEdgeIds) {
      const pathIndex = physical.physicalPathIndexOfEdge.get(edgeId)
      if (pathIndex === undefined) {
        continue
      }
      const path = physical.physicalPaths[pathIndex]
      for (const p of path.points) {
        fillPoints.push(worldTransform.toWorldXZ(p.x, p.y))
      }
      if (usedPathIndexes.has(pathIndex)) {
        continue
      }
      usedPathIndexes.add(pathIndex)
      outlinePathIndexes.push(pathIndex)
    }

    // 面填充：成员路径采样点凸包 + 沿边外扩（P1-7；无有效点则跳过）。
    // 凸包/外扩/三角化数学已提取为 hull2d 共享模块（P0-5.5 仓储区域色块复用）
    appendConvexHullFill(fillPositions, fillIndices, fillPoints, EXCLUSIVE_FILL_PADDING_M, EXCLUSIVE_FILL_Y)

    // 物理路径 → 世界坐标外沿条带（与 TASK-004 路面同一 strip 展开，更宽；
    // 端帽同样补圆片，蓝色外沿包住路面的圆头端，路口处覆盖关系一致）
    for (const pathIndex of outlinePathIndexes) {
      const path = physical.physicalPaths[pathIndex]
      const worldPoints = path.points.map((p) => worldTransform.toWorldXZ(p.x, p.y))
      appendPolylineStrip(
        positions,
        indices,
        worldPoints,
        halfWidth,
        EXCLUSIVE_OUTLINE_Y,
        { capStart: true, capEnd: true },
      )
    }
  }

  const outline = new THREE.BufferGeometry()
  outline.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  outline.setIndex(indices)
  outline.computeBoundingSphere()

  const fill = new THREE.BufferGeometry()
  fill.setAttribute('position', new THREE.Float32BufferAttribute(fillPositions, 3))
  fill.setIndex(fillIndices)
  fill.computeBoundingSphere()

  let disposed = false
  return {
    outline,
    fill,
    nameAnchors: Object.freeze(anchors),
    usedPhysicalPathCount: usedPathIndexes.size,
    dispose() {
      // 幂等释放：StrictMode 卸载与视图原子替换都会触发
      if (disposed) {
        return
      }
      disposed = true
      outline.dispose()
      fill.dispose()
    },
  }
}

