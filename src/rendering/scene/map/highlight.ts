/**
 * 拾取高亮机制（SPEC §8.2）：选中 emissive 提升 + 描边色环，hover 弱高亮。
 *
 * - **实例 emissive 提亮**：InstancedMesh 的材质 emissive 为材质级、无法逐实例调整，
 *   故以 InstancedBufferAttribute `aHighlight`（0 = 无 / HOVER 电平 / 1 = 选中）
 *   携带逐实例高亮电平，onBeforeCompile 注入 shader 把
 *   `aHighlight × uHighlightStrength × uHighlightColor` 叠加到 totalEmissiveRadiance——
 *   节点材质与 AGV 车体材质共用同一注入（与标签 billboard 注入同模式）；
 * - **描边色环**：平放地面的圆环几何（RingGeometry → XZ 平面），内半径 = 对象
 *   footprint 外接圆 + 间隙，场景层按选中 / 悬停变体赋不同不透明度；
 * - **走廊高亮覆盖**：走廊 ribbon 为单合并几何、无逐段材质，高亮由场景层用
 *   buildCorridorHighlightParams 重建单条走廊 ribbon 覆盖实现（选中加宽形成描边、
 *   悬停半透明弱化），覆盖色即顶点色替换。
 *
 * rendering 层可 import three 与 config，禁止 import infrastructure（SPEC §12）。
 */

import { BufferGeometry, Color, InstancedBufferAttribute, RingGeometry } from 'three'
import type { ColorRepresentation, WebGLProgramParametersWithUniforms } from 'three'

import type { AgvSnapshot } from '../../../domain/simulator'
import type { AgvShapeSizes, NodeShapeSizes, RenderableNodeKind } from './instanceGeometry'
import type { RibbonGeometryParams } from './ribbonGeometry'

/** 逐实例高亮电平属性名（InstancedBufferAttribute，float；0 = 无高亮） */
export const HIGHLIGHT_ATTRIBUTE = 'aHighlight'

// ---------------------------------------------------------------------------
// 逐实例 emissive 提亮（aHighlight 属性 + shader 注入）
// ---------------------------------------------------------------------------

/**
 * 为实例几何挂载 aHighlight 属性（全 0，count = 实例数）；
 * 重复挂载同一几何为空操作（返回既有属性）。
 */
export function attachInstanceHighlight(
  geometry: BufferGeometry,
  instanceCount: number,
): InstancedBufferAttribute {
  const existing = geometry.getAttribute(HIGHLIGHT_ATTRIBUTE)
  if (existing instanceof InstancedBufferAttribute) {
    return existing
  }
  const attribute = new InstancedBufferAttribute(new Float32Array(instanceCount), 1)
  geometry.setAttribute(HIGHLIGHT_ATTRIBUTE, attribute)
  return attribute
}

/**
 * 重算整组实例的高亮电平（in-place，零分配）：选中实例写 1、悬停实例写 hoverLevel、
 * 其余写 0；同一实例同时选中与悬停时选中优先（1 ≥ hoverLevel）。
 * 仅在选中 / 悬停变化时由场景层调用（非每帧路径）。
 */
export function writeGroupHighlight(
  attribute: InstancedBufferAttribute,
  selectedIndex: number,
  hoverIndex: number,
  hoverLevel: number,
): void {
  const array = attribute.array as Float32Array
  array.fill(0)
  if (hoverIndex >= 0 && hoverIndex < array.length) {
    array[hoverIndex] = hoverLevel
  }
  if (selectedIndex >= 0 && selectedIndex < array.length) {
    array[selectedIndex] = 1
  }
  attribute.needsUpdate = true
}

/**
 * 把逐实例 emissive 提亮注入 meshStandardMaterial（onBeforeCompile）。
 * 顶点契约：几何携带 aHighlight（InstancedBufferAttribute，attachInstanceHighlight 挂载）；
 * 片元在 emissivemap 之后叠加 `vHighlight × uHighlightStrength × uHighlightColor`
 * 到 totalEmissiveRadiance——节点（既有自发光）与 AGV 车体（无自发光）同样生效。
 * uniform 在注入时按 color / strength 固化，无每帧更新。
 */
export function injectInstanceHighlightShader(
  shader: WebGLProgramParametersWithUniforms,
  color: ColorRepresentation,
  strength: number,
): void {
  shader.uniforms.uHighlightColor = { value: new Color(color) }
  shader.uniforms.uHighlightStrength = { value: strength }
  shader.vertexShader = `
    attribute float aHighlight;
    varying float vHighlight;
  ${shader.vertexShader}`.replace(
    '#include <begin_vertex>',
    `#include <begin_vertex>
    vHighlight = aHighlight;`,
  )
  shader.fragmentShader = `
    uniform vec3 uHighlightColor;
    uniform float uHighlightStrength;
    varying float vHighlight;
  ${shader.fragmentShader}`.replace(
    '#include <emissivemap_fragment>',
    `#include <emissivemap_fragment>
    totalEmissiveRadiance += vHighlight * uHighlightStrength * uHighlightColor;`,
  )
}

// ---------------------------------------------------------------------------
// AGV instanceId 反查（SPEC §8.2）
// ---------------------------------------------------------------------------

/**
 * 由 raycast instanceId 反查 AGV 编号：实例顺序 = 快照数组顺序
 * （writeAgvInstanceMatrices 按快照顺序写实例矩阵）；非法 instanceId 返回 null。
 */
export function getAgvIdAtInstance(
  snapshots: readonly AgvSnapshot[],
  instanceId: number,
): number | null {
  if (!Number.isInteger(instanceId) || instanceId < 0 || instanceId >= snapshots.length) {
    return null
  }
  return snapshots[instanceId].id
}

/** 由 AGV 编号反查实例下标（高亮电平写入定位）；编号不存在返回 -1 */
export function getAgvInstanceIndex(
  snapshots: readonly AgvSnapshot[],
  agvId: number,
): number {
  for (let i = 0; i < snapshots.length; i++) {
    if (snapshots[i].id === agvId) {
      return i
    }
  }
  return -1
}

// ---------------------------------------------------------------------------
// 描边色环（平放地面的圆环）
// ---------------------------------------------------------------------------

/** 描边色环本地几何：平放 XZ 平面（环面贴 y=0），内 / 外半径参数化，底面中心为原点 */
export function buildSelectionRingGeometry(
  innerRadius: number,
  outerRadius: number,
  segments = 64,
): BufferGeometry {
  const geometry = new RingGeometry(innerRadius, outerRadius, segments)
  geometry.rotateX(-Math.PI / 2)
  return geometry
}

/** 节点描边色环内半径：造型 footprint 外接圆半径 + 外扩间隙（elevator 不渲染不拾取，不在此列） */
export function nodeSelectionRingRadius(
  kind: RenderableNodeKind,
  sizes: NodeShapeSizes,
  margin: number,
): number {
  switch (kind) {
    case 'work':
      // 方台水平外接圆 = 边长 × √2 / 2
      return (sizes.workPlatformSize * Math.SQRT2) / 2 + margin
    case 'charge':
      return sizes.chargeRadius + margin
    case 'park':
      return sizes.parkRadius + margin
    case 'node':
      return sizes.navRadius + margin
  }
}

/** AGV 描边色环内半径：车体 footprint（长 × 宽）外接圆半径 + 外扩间隙 */
export function agvSelectionRingRadius(sizes: AgvShapeSizes, margin: number): number {
  return Math.hypot(sizes.bodyLength, sizes.bodyWidth) / 2 + margin
}

// ---------------------------------------------------------------------------
// 走廊高亮覆盖参数
// ---------------------------------------------------------------------------

/**
 * 由基础 ribbon 参数派生单条走廊的高亮覆盖参数：
 * 三色（普通 / 单向 / 倒车标识）统一替换为高亮色，宽度按 extraWidth 加宽
 * （选中加宽 → 边缘超出原 ribbon 形成描边；悬停传 0 保持原宽），抬升覆盖层高度。
 */
export function buildCorridorHighlightParams(
  base: RibbonGeometryParams,
  color: ColorRepresentation,
  extraWidth: number,
  lift: number,
): RibbonGeometryParams {
  return {
    ...base,
    width: base.width + extraWidth,
    lift,
    colors: { normal: color, oneWay: color, back: color },
  }
}
