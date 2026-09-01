/**
 * 独占区静态几何构建（SPEC §2.3、§5.1、§11.12；TASK-005）。
 *
 * 职责：把 7 个独占区分组的成员物理路径合并为一个低透明度蓝色外沿的静态
 *       BufferGeometry（全部分组共用一个几何 = 一个 Draw Call），并为每个
 *       分组计算「成员节点包围盒中心」的名称锚点，供近景名称四边形合批。
 * 边界：输入为只读 MapModel、统一 WorldTransform 与 TASK-004 的物理路径索引
 *       （MapGeometry.physical）；本模块只产出几何与锚点，不创建材质/Mesh、
 *       不进 React；空间语义之外不参与任何调度或控制（SPEC §2.3）。
 * 关键不变量：
 * 1. 逐项隔离（SPEC §2.3/§11.12）：分组中引用不存在节点/边的成员只跳过该
 *    引用，不阻断分组其余成员，更不阻断其他分组——MapModel 经 validateMap
 *    后成员引用必然有效，此处跳过属于纵深防御，测试以手工模型直接驱动；
 * 2. 物理路径去重：同一分组的正反向成员边映射到同一物理路径时只画一条；
 *    多个分组共享的物理路径在全图范围内也只画一条；
 * 3. 名称锚点 = 成员节点世界坐标的 AABB 中心（不是成员边几何），无有效成员
 *    节点的分组不产生锚点；
 * 4. 外沿条带宽度来自 mapAppearance（比路面宽），高度烘焙在
 *    EXCLUSIVE_OUTLINE_Y（路面之下），只露出宽出路面的蓝色边缘；
 * 5. 本模块创建的 BufferGeometry 由返回值 dispose() 明确释放（创建者释放），
 *    幂等可重复调用。
 */
import * as THREE from 'three'
import type { MapModel } from '../model/types'
import type { WorldTransform } from '@/shared/spatial'
import type { PhysicalPathIndex } from './buildMapGeometry'
import { EXCLUSIVE_OUTLINE_WIDTH_M, EXCLUSIVE_OUTLINE_Y } from './mapAppearance'

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

    // 成员边 → 物理路径（映射缺失的引用逐项跳过）
    const groupPathIndexes: number[] = []
    for (const edgeId of group.memberEdgeIds) {
      const pathIndex = physical.physicalPathIndexOfEdge.get(edgeId)
      if (pathIndex === undefined || usedPathIndexes.has(pathIndex)) {
        continue
      }
      usedPathIndexes.add(pathIndex)
      groupPathIndexes.push(pathIndex)
    }

    // 物理路径 → 世界坐标外沿条带（与 TASK-004 路面同样的展开方式，更宽）
    for (const pathIndex of groupPathIndexes) {
      const path = physical.physicalPaths[pathIndex]
      const worldPoints = path.points.map((p) => worldTransform.toWorldXZ(p.x, p.y))
      for (let i = 1; i < worldPoints.length; i += 1) {
        const a = worldPoints[i - 1]
        const b = worldPoints[i]
        const segmentLength = Math.hypot(b.x - a.x, b.z - a.z)
        if (segmentLength === 0) {
          continue
        }
        const dirX = (b.x - a.x) / segmentLength
        const dirZ = (b.z - a.z) / segmentLength
        const normalX = -dirZ * halfWidth
        const normalZ = dirX * halfWidth
        const base = positions.length / 3
        positions.push(
          a.x + normalX,
          EXCLUSIVE_OUTLINE_Y,
          a.z + normalZ,
          a.x - normalX,
          EXCLUSIVE_OUTLINE_Y,
          a.z - normalZ,
          b.x - normalX,
          EXCLUSIVE_OUTLINE_Y,
          b.z - normalZ,
          b.x + normalX,
          EXCLUSIVE_OUTLINE_Y,
          b.z + normalZ,
        )
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
      }
    }
  }

  const outline = new THREE.BufferGeometry()
  outline.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  outline.setIndex(indices)
  outline.computeBoundingSphere()

  let disposed = false
  return {
    outline,
    nameAnchors: Object.freeze(anchors),
    usedPhysicalPathCount: usedPathIndexes.size,
    dispose() {
      // 幂等释放：StrictMode 卸载与视图原子替换都会触发
      if (disposed) {
        return
      }
      disposed = true
      outline.dispose()
    },
  }
}
