/**
 * 节点站点实心圆台几何。
 *
 * 职责：按 mapAppearance 的节点分层常量构建「暗色底座 → 状态色实心柱身」
 *       的合并圆台堆叠——每层侧壁为圆柱/圆台面（CylinderGeometry 开口筒），
 *       层顶为平面圆盘（Circle）；各部件带顶点色亮度乘数（最终色 =
 *       实例色 × 乘数），柱身顶面乘数 >1 借 ACES 色调映射产生过曝辉光。
 *       顶点色与 instanceColor 在着色器中相乘，仍是一个 InstancedMesh
 *       一趟 Draw Call。
 * 边界：纯几何工厂（无材质、无实例、不进 React）；LOD 淡出注入归
 *       semanticMaterials，实例上载归 NodesLayer。
 * 关键不变量：
 * 1. 部件按「自下而上」顺序合并（画家序兜底），底座外沿 = NODE_OUTER_RADIUS_M
 *    ≤ 半路宽（P0-3 尺度链）；除各层顶面外不生成任何底面/不可见面（节点立于
 *    NODE_Y 台阶上，底面永远不可见），整体不再二次旋转（各部件自行放置）；
 * 2. 全部半径/高度/倒角/乘数只来自 mapAppearance 常量，本文件不含视觉数值；
 * 3. 合并后立即释放源几何；顶点总数 < 65536，索引保持 Uint16。
 */
import * as THREE from 'three'
import {
  NODE_BASE_CHAMFER_M,
  NODE_BASE_HEIGHT_M,
  NODE_BASE_MARGIN_M,
  NODE_BASE_STRENGTH,
  NODE_CIRCLE_SEGMENTS,
  NODE_RADIUS_M,
  NODE_SIDE_STRENGTH,
  NODE_TOP_CHAMFER_M,
  NODE_TOP_CHAMFER_STRENGTH,
  NODE_TOP_M,
  NODE_TOP_STRENGTH,
} from './mapAppearance'

/** 单个几何部件：kind 决定源几何形状，colorStrength 为顶点色亮度乘数 */
type NodeStackPart = {
  /** 圆台侧壁：radiusBottom@yBottom → radiusTop@yTop（不开口顶底面） */
  kind: 'side'
  radiusBottomM: number
  radiusTopM: number
  yBottomM: number
  yTopM: number
  colorStrength: number
} | {
  /** 平面圆盘：radius @y（朝上） */
  kind: 'disc'
  radiusM: number
  yM: number
  colorStrength: number
}

/** 两层圆台：暗色底座 → 状态色实心柱身（自下而上） */
function buildNodeStackParts(): NodeStackPart[] {
  const baseOuter = NODE_RADIUS_M + NODE_BASE_MARGIN_M
  const baseChamferTop = baseOuter - NODE_BASE_CHAMFER_M
  const topChamferBottomY = NODE_TOP_M - NODE_TOP_CHAMFER_M
  const topChamferRadius = NODE_RADIUS_M - NODE_TOP_CHAMFER_M
  return [
    // ── 第 1 层：暗色底座（最宽，嵌入地面的台阶 + 暗轮廓） ──
    { kind: 'side', radiusBottomM: baseOuter, radiusTopM: baseChamferTop, yBottomM: 0, yTopM: NODE_BASE_CHAMFER_M, colorStrength: NODE_BASE_STRENGTH },
    { kind: 'side', radiusBottomM: baseChamferTop, radiusTopM: baseChamferTop, yBottomM: NODE_BASE_CHAMFER_M, yTopM: NODE_BASE_HEIGHT_M, colorStrength: NODE_BASE_STRENGTH },
    { kind: 'disc', radiusM: baseChamferTop, yM: NODE_BASE_HEIGHT_M, colorStrength: NODE_BASE_STRENGTH },
    // ── 第 2 层：状态色实心柱身（直筒侧壁 + 顶外沿倒角过曝提亮 + 整块顶面） ──
    { kind: 'side', radiusBottomM: NODE_RADIUS_M, radiusTopM: NODE_RADIUS_M, yBottomM: NODE_BASE_HEIGHT_M, yTopM: topChamferBottomY, colorStrength: NODE_SIDE_STRENGTH },
    { kind: 'side', radiusBottomM: NODE_RADIUS_M, radiusTopM: topChamferRadius, yBottomM: topChamferBottomY, yTopM: NODE_TOP_M, colorStrength: NODE_TOP_CHAMFER_STRENGTH },
    { kind: 'disc', radiusM: topChamferRadius, yM: NODE_TOP_M, colorStrength: NODE_TOP_STRENGTH },
  ]
}

function createPartGeometry(part: NodeStackPart): THREE.BufferGeometry {
  switch (part.kind) {
    case 'side': {
      const geometry = new THREE.CylinderGeometry(
        part.radiusTopM,
        part.radiusBottomM,
        part.yTopM - part.yBottomM,
        NODE_CIRCLE_SEGMENTS,
        1,
        true,
      )
      geometry.translate(0, (part.yTopM + part.yBottomM) / 2, 0)
      return geometry
    }
    case 'disc': {
      const geometry = new THREE.CircleGeometry(part.radiusM, NODE_CIRCLE_SEGMENTS)
      geometry.rotateX(-Math.PI / 2)
      geometry.translate(0, part.yM, 0)
      return geometry
    }
  }
}

export function createNodeStackGeometry(): THREE.BufferGeometry {
  const geometries = buildNodeStackParts().map((part) => ({
    part,
    geometry: createPartGeometry(part),
  }))

  let vertexTotal = 0
  let indexTotal = 0
  for (const { geometry } of geometries) {
    vertexTotal += geometry.getAttribute('position').count
    indexTotal += geometry.getIndex()!.count
  }
  const merged = new THREE.BufferGeometry()
  merged.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexTotal * 3), 3))
  merged.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(vertexTotal * 3), 3))
  merged.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(vertexTotal * 2), 2))
  merged.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vertexTotal * 3), 3))
  const indices = new Uint16Array(indexTotal)

  let vertexOffset = 0
  let indexOffset = 0
  for (const { part, geometry } of geometries) {
    const count = geometry.getAttribute('position').count
    for (const name of ['position', 'normal', 'uv'] as const) {
      ;(merged.getAttribute(name) as THREE.BufferAttribute).array.set(
        geometry.getAttribute(name).array as Float32Array,
        name === 'uv' ? vertexOffset * 2 : vertexOffset * 3,
      )
    }
    const colors = (merged.getAttribute('color') as THREE.BufferAttribute)
      .array as Float32Array
    for (let v = 0; v < count; v += 1) {
      const base = (vertexOffset + v) * 3
      colors[base] = part.colorStrength
      colors[base + 1] = part.colorStrength
      colors[base + 2] = part.colorStrength
    }
    const sourceIndices = geometry.getIndex()!
    for (let i = 0; i < sourceIndices.count; i += 1) {
      indices[indexOffset + i] = sourceIndices.getX(i) + vertexOffset
    }
    vertexOffset += count
    indexOffset += sourceIndices.count
    geometry.dispose()
  }
  merged.setIndex(new THREE.BufferAttribute(indices, 1))
  return merged
}
