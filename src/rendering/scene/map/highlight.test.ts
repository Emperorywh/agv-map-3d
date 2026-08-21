import { describe, expect, it } from 'vitest'

import { BufferGeometry } from 'three'
import type { WebGLProgramParametersWithUniforms } from 'three'

import type { AgvSnapshot } from '../../../domain/simulator'
import {
  HIGHLIGHT_ATTRIBUTE,
  agvSelectionRingRadius,
  attachInstanceHighlight,
  buildCorridorHighlightParams,
  buildSelectionRingGeometry,
  getAgvIdAtInstance,
  getAgvInstanceIndex,
  injectInstanceHighlightShader,
  nodeSelectionRingRadius,
  writeGroupHighlight,
} from './highlight'
import type { AgvShapeSizes, NodeShapeSizes } from './instanceGeometry'
import type { RibbonGeometryParams } from './ribbonGeometry'

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

const NODE_SIZES: NodeShapeSizes = {
  workPlatformSize: 1.4,
  workPlatformHeight: 0.26,
  workIconSize: 0.8,
  workIconHeight: 0.22,
  chargeRadius: 0.62,
  chargeHeight: 0.2,
  parkRadius: 0.3,
  parkHeight: 0.12,
  navRadius: 0.15,
  navHeight: 0.07,
}

const AGV_SIZES: AgvShapeSizes = {
  bodyLength: 1.6,
  bodyWidth: 1.0,
  chassisHeight: 0.18,
  coverLength: 1.0,
  coverWidth: 0.7,
  coverHeight: 0.24,
  coverRearOffset: 0.1,
  wedgeLength: 0.5,
  wedgeWidth: 0.7,
  wedgeHeight: 0.22,
  headlightWidth: 0.14,
  headlightHeight: 0.08,
  headlightDepth: 0.05,
  headlightInset: 0.32,
  headlightLift: 0.1,
  ringRadius: 0.3,
  ringTube: 0.045,
  ringLift: 0.04,
}

const RIBBON_BASE: RibbonGeometryParams = {
  width: 1.5,
  lift: 0.02,
  miterLimit: 2,
  dashLength: 0.6,
  dashGap: 0.4,
  dashWidth: 0.12,
  overlayLift: 0.005,
  arrowSpacing: 8,
  colors: { normal: '#102030', oneWay: '#405060', back: '#708090' },
}

function fakeSnapshot(id: number): AgvSnapshot {
  return {
    id,
    status: 'idle',
    battery: 100,
    edgeId: null,
    nodeId: null,
    task: null,
    position: { x: 0, y: 0, z: 0 },
    yaw: 0,
  }
}

// ---------------------------------------------------------------------------
// aHighlight 属性挂载与整组写入
// ---------------------------------------------------------------------------

describe('attachInstanceHighlight / writeGroupHighlight', () => {
  it('挂载 aHighlight 实例属性：长度 = 实例数、初始全 0；重复挂载返回同一属性', () => {
    const geometry = new BufferGeometry()
    const attribute = attachInstanceHighlight(geometry, 3)
    expect(attribute.count).toBe(3)
    expect(Array.from(attribute.array)).toEqual([0, 0, 0])
    expect(geometry.getAttribute(HIGHLIGHT_ATTRIBUTE)).toBe(attribute)
    expect(attachInstanceHighlight(geometry, 3)).toBe(attribute)
    geometry.dispose()
  })

  it('writeGroupHighlight：选中写 1、悬停写电平、其余清 0，选中优先于悬停', () => {
    const geometry = new BufferGeometry()
    const attribute = attachInstanceHighlight(geometry, 4)
    const levels = () => Array.from(attribute.array as Float32Array)
    writeGroupHighlight(attribute, 2, 1, 0.4)
    expect(levels()[0]).toBe(0)
    expect(levels()[1]).toBeCloseTo(0.4, 6)
    expect(levels()[2]).toBe(1)
    expect(levels()[3]).toBe(0)
    // 同一实例同时悬停与选中：选中（1）优先
    writeGroupHighlight(attribute, 1, 1, 0.4)
    expect(levels()[1]).toBe(1)
    // 全部清除
    writeGroupHighlight(attribute, -1, -1, 0.4)
    expect(levels()).toEqual([0, 0, 0, 0])
    // 越界下标安全忽略
    writeGroupHighlight(attribute, 9, -3, 0.4)
    expect(levels()).toEqual([0, 0, 0, 0])
    geometry.dispose()
  })
})

describe('injectInstanceHighlightShader', () => {
  it('注入 aHighlight 顶点契约与 emissive 叠加片元，uniform 按参数固化', () => {
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: 'void main() {\n#include <begin_vertex>\n}',
      fragmentShader: 'void main() {\n#include <emissivemap_fragment>\n}',
    } as unknown as WebGLProgramParametersWithUniforms
    injectInstanceHighlightShader(shader, '#ffd94d', 1.2)
    expect(shader.vertexShader).toContain('attribute float aHighlight')
    expect(shader.vertexShader).toContain('vHighlight = aHighlight;')
    expect(shader.fragmentShader).toContain('uniform vec3 uHighlightColor')
    expect(shader.fragmentShader).toContain('uniform float uHighlightStrength')
    expect(shader.fragmentShader).toContain(
      'totalEmissiveRadiance += vHighlight * uHighlightStrength * uHighlightColor;',
    )
    const colorUniform = shader.uniforms.uHighlightColor as { value: { r: number; g: number; b: number } }
    const strengthUniform = shader.uniforms.uHighlightStrength as { value: number }
    expect(strengthUniform.value).toBe(1.2)
    expect(Number.isFinite(colorUniform.value.r)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AGV instanceId 反查（SPEC §8.2）
// ---------------------------------------------------------------------------

describe('AGV instanceId 反查', () => {
  const snapshots = [fakeSnapshot(0), fakeSnapshot(1), fakeSnapshot(2)]

  it('getAgvIdAtInstance：实例下标 → 快照编号（实例顺序 = 快照顺序）', () => {
    expect(getAgvIdAtInstance(snapshots, 0)).toBe(0)
    expect(getAgvIdAtInstance(snapshots, 2)).toBe(2)
  })

  it('getAgvIdAtInstance：非法 instanceId 返回 null', () => {
    expect(getAgvIdAtInstance(snapshots, -1)).toBeNull()
    expect(getAgvIdAtInstance(snapshots, 3)).toBeNull()
    expect(getAgvIdAtInstance(snapshots, 0.5)).toBeNull()
    expect(getAgvIdAtInstance([], 0)).toBeNull()
  })

  it('getAgvInstanceIndex：编号 → 实例下标，不存在返回 -1', () => {
    expect(getAgvInstanceIndex(snapshots, 1)).toBe(1)
    expect(getAgvInstanceIndex(snapshots, 9)).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// 描边色环几何与半径
// ---------------------------------------------------------------------------

describe('描边色环', () => {
  it('buildSelectionRingGeometry：平放 XZ 平面（全部顶点 y = 0），顶点半径落在 [内, 外]', () => {
    const geometry = buildSelectionRingGeometry(1.0, 1.2, 32)
    const positions = geometry.getAttribute('position')
    expect(positions.count).toBeGreaterThan(0)
    for (let i = 0; i < positions.count; i++) {
      expect(positions.getY(i)).toBeCloseTo(0, 6)
      const radius = Math.hypot(positions.getX(i), positions.getZ(i))
      expect(radius).toBeGreaterThanOrEqual(1.0 - 1e-6)
      expect(radius).toBeLessThanOrEqual(1.2 + 1e-6)
    }
    geometry.dispose()
  })

  it('nodeSelectionRingRadius：覆盖造型 footprint 外接圆 + 间隙，尺寸层级 work > charge > park > node', () => {
    const margin = 0.25
    const work = nodeSelectionRingRadius('work', NODE_SIZES, margin)
    const charge = nodeSelectionRingRadius('charge', NODE_SIZES, margin)
    const park = nodeSelectionRingRadius('park', NODE_SIZES, margin)
    const nav = nodeSelectionRingRadius('node', NODE_SIZES, margin)
    expect(work).toBeCloseTo((1.4 * Math.SQRT2) / 2 + margin, 6)
    expect(charge).toBeCloseTo(0.62 + margin, 6)
    expect(park).toBeCloseTo(0.3 + margin, 6)
    expect(nav).toBeCloseTo(0.15 + margin, 6)
    expect(work).toBeGreaterThan(charge)
    expect(charge).toBeGreaterThan(park)
    expect(park).toBeGreaterThan(nav)
  })

  it('agvSelectionRingRadius：覆盖车体 footprint 外接圆 + 间隙', () => {
    expect(agvSelectionRingRadius(AGV_SIZES, 0.25)).toBeCloseTo(
      Math.hypot(1.6, 1.0) / 2 + 0.25,
      6,
    )
  })
})

// ---------------------------------------------------------------------------
// 走廊高亮覆盖参数
// ---------------------------------------------------------------------------

describe('buildCorridorHighlightParams', () => {
  it('三色统一替换为高亮色，宽度加宽、抬升覆盖，其余参数继承基础 ribbon 参数', () => {
    const params = buildCorridorHighlightParams(RIBBON_BASE, '#ffd94d', 0.3, 0.035)
    expect(params.colors).toEqual({ normal: '#ffd94d', oneWay: '#ffd94d', back: '#ffd94d' })
    expect(params.width).toBeCloseTo(1.8, 6)
    expect(params.lift).toBe(0.035)
    expect(params.miterLimit).toBe(RIBBON_BASE.miterLimit)
    expect(params.dashLength).toBe(RIBBON_BASE.dashLength)
    expect(params.overlayLift).toBe(RIBBON_BASE.overlayLift)
    // 基础参数不被修改
    expect(RIBBON_BASE.width).toBe(1.5)
    expect(RIBBON_BASE.colors.normal).toBe('#102030')
  })
})
