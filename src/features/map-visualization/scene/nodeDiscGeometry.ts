/**
 * 节点站点截面几何（SPEC §5.1；TASK-004；视觉差距分析 P2-3 暗描边）。
 *
 * 职责：构建「中心圆盘 + 外圈暗描边环」的合并几何——盘区顶点色为 1（最终
 *       色 = 实例色原样），描边环顶点色为 NODE_OUTLINE_STRENGTH 乘数（最终
 *       色 = 实例色 × 乘数，保持节点色相的深描边）；顶点色与 instanceColor
 *       在着色器中相乘，无需额外 Draw Call。Reference 的节点有清晰的
 *       「嵌 into 路面」轮廓。
 * 边界：纯几何工厂（无材质、无实例、不进 React）；LOD 淡出注入归
 *       semanticMaterials，实例上载归 NodesLayer。
 * 关键不变量：
 * 1. 两份源几何（Circle/Ring，均为 XY 面索引几何）按索引偏移合并后整体旋转
 *    平贴地面，合并后立即释放源几何；
 * 2. 描边宽度与乘数只来自 mapAppearance 常量，半径链 = NODE_RADIUS_M +
 *    NODE_OUTLINE_WIDTH_M ≤ 半路宽（P0-3 尺度链不被描边破坏）。
 */
import * as THREE from 'three'
import {
  NODE_CIRCLE_SEGMENTS,
  NODE_OUTLINE_STRENGTH,
  NODE_OUTLINE_WIDTH_M,
  NODE_RADIUS_M,
} from './mapAppearance'

export function createNodeDiscGeometry(): THREE.BufferGeometry {
  const disc = new THREE.CircleGeometry(NODE_RADIUS_M, NODE_CIRCLE_SEGMENTS)
  const outline = new THREE.RingGeometry(
    NODE_RADIUS_M,
    NODE_RADIUS_M + NODE_OUTLINE_WIDTH_M,
    NODE_CIRCLE_SEGMENTS,
  )
  const parts = [
    { geometry: disc, colorStrength: 1 },
    { geometry: outline, colorStrength: NODE_OUTLINE_STRENGTH },
  ] as const

  let vertexTotal = 0
  let indexTotal = 0
  for (const part of parts) {
    vertexTotal += part.geometry.getAttribute('position').count
    indexTotal += part.geometry.getIndex()!.count
  }
  const merged = new THREE.BufferGeometry()
  merged.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexTotal * 3), 3))
  merged.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(vertexTotal * 3), 3))
  merged.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(vertexTotal * 2), 2))
  merged.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vertexTotal * 3), 3))
  const indices = new Uint16Array(indexTotal)

  let vertexOffset = 0
  let indexOffset = 0
  for (const part of parts) {
    const source = part.geometry
    const count = source.getAttribute('position').count
    for (const name of ['position', 'normal', 'uv'] as const) {
      ;(merged.getAttribute(name) as THREE.BufferAttribute).array.set(
        source.getAttribute(name).array as Float32Array,
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
    const sourceIndices = source.getIndex()!
    for (let i = 0; i < sourceIndices.count; i += 1) {
      indices[indexOffset + i] = sourceIndices.getX(i) + vertexOffset
    }
    vertexOffset += count
    indexOffset += sourceIndices.count
    source.dispose()
  }
  merged.setIndex(new THREE.BufferAttribute(indices, 1))
  merged.rotateX(-Math.PI / 2)
  return merged
}
