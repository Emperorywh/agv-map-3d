/**
 * 节点标识由暗色底座、类型色倒角、低亮度顶面与白色语义图标组成。
 * 普通点为圆形，工位为圆角方形，停靠为方形，充电为六边形，库区为菱形。
 * 每种类型的底座和符号合并成一份几何，实例批次不随节点数量增长。
 * 外轮廓始终限制在既有节点半径内，密集避让与 GPU 淡出沿用同一尺度。
 */
import * as THREE from 'three'
import type { NodeCategory } from '../model/types'
import { createNodeSymbolGeometry } from './nodeSymbolGeometry'
import {
  NODE_BASE_CHAMFER_M,
  NODE_BASE_HEIGHT_M,
  NODE_BASE_MARGIN_M,
  NODE_BASE_STRENGTH,
  NODE_CIRCLE_SEGMENTS,
  NODE_RADIUS_M,
  NODE_SIDE_STRENGTH,
  NODE_SYMBOL_LIFT_M,
  NODE_SYMBOL_SCALE_M,
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

/**
 * 所有轮廓归一化到单位外接圆，避免方形角点超出最近邻避让半径。
 * 圆角方形使用实际弧线，不依赖贴图透明度或片元裁切来伪造轮廓。
 */
function createOutline(category: NodeCategory): THREE.Vector2[] {
  if (category === 'work') {
    const shape = new THREE.Shape()
    const half = Math.SQRT1_2
    const radius = 0.2
    shape.absarc(half - radius, half - radius, radius, 0, Math.PI / 2, false)
    shape.absarc(-half + radius, half - radius, radius, Math.PI / 2, Math.PI, false)
    shape.absarc(-half + radius, -half + radius, radius, Math.PI, Math.PI * 1.5, false)
    shape.absarc(half - radius, -half + radius, radius, Math.PI * 1.5, Math.PI * 2, false)
    return shape.getPoints(4)
  }
  const segments = category === 'charge' ? 6 : category === 'park' || category === 'warehouse' ? 4 : NODE_CIRCLE_SEGMENTS
  const rotation = category === 'park' ? Math.PI / 4 : 0
  return Array.from({ length: segments }, (_, i) => {
    const angle = i / segments * Math.PI * 2 + rotation
    return new THREE.Vector2(Math.cos(angle), Math.sin(angle))
  })
}

function createPartGeometry(part: NodeStackPart, outline: readonly THREE.Vector2[]): THREE.BufferGeometry {
  switch (part.kind) {
    case 'side': {
      /**
       * 按同一轮廓连接上下两圈，生成直壁或倒角；XY 图标平面映射到 XZ 地面。
       * 每段独立顶点保留清晰折角，绕序保证正面朝外且不生成不可见底面。
       */
      const positions: number[] = []
      const indices: number[] = []
      const uvs: number[] = []
      for (let i = 0; i < outline.length; i += 1) {
        const a = outline[i]
        const b = outline[(i + 1) % outline.length]
        const offset = positions.length / 3
        positions.push(
          a.x * part.radiusBottomM, part.yBottomM, -a.y * part.radiusBottomM,
          b.x * part.radiusBottomM, part.yBottomM, -b.y * part.radiusBottomM,
          b.x * part.radiusTopM, part.yTopM, -b.y * part.radiusTopM,
          a.x * part.radiusTopM, part.yTopM, -a.y * part.radiusTopM,
        )
        uvs.push(0, 0, 1, 0, 1, 1, 0, 1)
        indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3)
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
      geometry.setIndex(indices)
      geometry.computeVertexNormals()
      return geometry
    }
    case 'disc': {
      const geometry = new THREE.ShapeGeometry(new THREE.Shape(outline.map((point) => point.clone().multiplyScalar(part.radiusM))))
      geometry.rotateX(-Math.PI / 2)
      geometry.translate(0, part.yM, 0)
      return geometry
    }
  }
}

export function createNodeStackGeometry(category: NodeCategory): THREE.BufferGeometry {
  const outline = createOutline(category)
  const geometries = buildNodeStackParts().map((part) => ({
    colorStrength: part.colorStrength,
    symbolMask: 0,
    geometry: createPartGeometry(part, outline),
  }))
  /**
   * 图标和顶面同批绘制，符号掩码让白色笔画不被实例颜色再次染色。
   * 极小高度差确保笔画不会与顶面闪烁，旋转后正面统一朝向地面上方。
   */
  const symbol = createNodeSymbolGeometry(category)
  symbol.scale(NODE_SYMBOL_SCALE_M, NODE_SYMBOL_SCALE_M, 1)
  symbol.rotateX(-Math.PI / 2)
  symbol.translate(0, NODE_TOP_M + NODE_SYMBOL_LIFT_M, 0)
  geometries.push({ colorStrength: 1, symbolMask: 1, geometry: symbol })

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
  merged.setAttribute('aNodeSymbol', new THREE.BufferAttribute(new Float32Array(vertexTotal), 1))
  const indices = new Uint16Array(indexTotal)

  let vertexOffset = 0
  let indexOffset = 0
  for (const { colorStrength, symbolMask, geometry } of geometries) {
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
      colors[base] = colorStrength
      colors[base + 1] = colorStrength
      colors[base + 2] = colorStrength
    }
    ;(merged.getAttribute('aNodeSymbol').array as Float32Array).fill(symbolMask, vertexOffset, vertexOffset + count)
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
