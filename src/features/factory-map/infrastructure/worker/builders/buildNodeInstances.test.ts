import { describe, expect, it } from 'vitest'

import type { FactoryMapNode } from '../../../domain/factoryMap'
import {
  NODE_DOT_Y,
  STATION_DIRECTION_Y,
  STATION_RING_Y,
  buildNodeInstances,
  srgbHexToLinearRgb,
} from './buildNodeInstances'
import type { NodeBuildOptions } from './buildNodeInstances'

// §13.4 站点颜色（config/visualTheme.ts），测试内联注入（builders 不依赖 config 层）
const OPTIONS: NodeBuildOptions = {
  stationColors: { work: '#2196F3', charge: '#8BC34A', park: '#F44336' },
}

function makeNode(
  id: string,
  type: FactoryMapNode['type'],
  x: number,
  y: number,
  angle: number | null = null,
): FactoryMapNode {
  return { id, name: id, type, x, y, angle }
}

describe('srgbHexToLinearRgb（§5.1 instanceColor 线性颜色空间）', () => {
  it('黑与白不动点', () => {
    expect(srgbHexToLinearRgb('#000000')).toEqual([0, 0, 0])
    const white = srgbHexToLinearRgb('#FFFFFF')
    expect(white[0]).toBeCloseTo(1, 10)
    expect(white[1]).toBeCloseTo(1, 10)
    expect(white[2]).toBeCloseTo(1, 10)
  })

  it('分段线性段（通道 ≤ 0.04045 走 c/12.92 分支）', () => {
    // 10/255 ≈ 0.03922 ≤ 0.04045 → 线性段；11/255 ≈ 0.04314 → 幂次段
    expect(srgbHexToLinearRgb('#0A0000')[0]).toBeCloseTo(0.0392157 / 12.92, 6)
    expect(srgbHexToLinearRgb('#0B0000')[0]).toBeCloseTo(((0.0431373 + 0.055) / 1.055) ** 2.4, 6)
  })

  it('§13.4 三种站点颜色的线性值', () => {
    expect(srgbHexToLinearRgb('#2196F3')).toEqual([
      expect.closeTo(0.015209, 6),
      expect.closeTo(0.304987, 6),
      expect.closeTo(0.896269, 6),
    ])
    expect(srgbHexToLinearRgb('#8BC34A')).toEqual([
      expect.closeTo(0.258183, 6),
      expect.closeTo(0.545724, 6),
      expect.closeTo(0.068478, 6),
    ])
    expect(srgbHexToLinearRgb('#F44336')).toEqual([
      expect.closeTo(0.904661, 6),
      expect.closeTo(0.056128, 6),
      expect.closeTo(0.036889, 6),
    ])
  })
})

describe('buildNodeInstances（§7.3、§7.4 实例批次）', () => {
  function instances(matrices: Float32Array): number[][] {
    const out: number[][] = []
    for (let i = 0; i < matrices.length; i += 16) {
      out.push(Array.from(matrices.slice(i, i + 16)))
    }
    return out
  }

  it('普通 node：只进圆点批次（纯平移矩阵，y=+0.012），无圆环无朝向', () => {
    const result = buildNodeInstances([makeNode('n1', 'node', 2, 3)], OPTIONS)
    expect(result.rings.matrices).toHaveLength(0)
    expect(result.directions.matrices).toHaveLength(0)
    const [m] = instances(result.dots.matrices)
    // 单位旋转 + 平移 (2, 0.012, -3)（+0 归一化消除 -sin(0) 产生的 -0）
    expect(m.slice(0, 12).map((v) => v + 0)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
    expect(m[12]).toBeCloseTo(2, 6)
    expect(m[13]).toBeCloseTo(NODE_DOT_Y, 6)
    expect(m[14]).toBeCloseTo(-3, 6)
    expect(m[15]).toBe(1)
  })

  it('站点圆环：instanceColor 按类型取线性颜色，y=+0.014', () => {
    const result = buildNodeInstances(
      [makeNode('w', 'work', 1, 1), makeNode('c', 'charge', 2, 2), makeNode('p', 'park', 3, 3)],
      OPTIONS,
    )
    expect(result.dots.matrices).toHaveLength(0)
    expect(result.directions.matrices).toHaveLength(0) // angle 全为 null
    const rings = instances(result.rings.matrices)
    expect(rings).toHaveLength(3)
    expect(result.rings.colors).toHaveLength(9)
    for (const m of rings) expect(m[13]).toBeCloseTo(STATION_RING_Y, 6)
    expect(Array.from(result.rings.colors.slice(0, 3))).toEqual([
      expect.closeTo(0.015209, 5), expect.closeTo(0.304987, 5), expect.closeTo(0.896269, 5),
    ])
    expect(Array.from(result.rings.colors.slice(3, 6))).toEqual([
      expect.closeTo(0.258183, 5), expect.closeTo(0.545724, 5), expect.closeTo(0.068478, 5),
    ])
    expect(Array.from(result.rings.colors.slice(6, 9))).toEqual([
      expect.closeTo(0.904661, 5), expect.closeTo(0.056128, 5), expect.closeTo(0.036889, 5),
    ])
  })

  it('angle === null 的站点不生成朝向符号；angle 有限时生成且颜色同所属环', () => {
    const result = buildNodeInstances(
      [makeNode('w1', 'work', 0, 0, null), makeNode('w2', 'work', 5, 6, Math.PI / 2)],
      OPTIONS,
    )
    expect(instances(result.rings.matrices)).toHaveLength(2)
    expect(instances(result.directions.matrices)).toHaveLength(1)
    expect(result.directions.colors).toHaveLength(3)
    // 朝向符号颜色 = 所属 work 环颜色
    expect(Array.from(result.directions.colors)).toEqual(Array.from(result.rings.colors.slice(0, 3)))
  })

  it('朝向符号矩阵 rotation.y = node.angle：+X 前向旋转后指向 (cosθ, 0, -sinθ)，y=+0.016', () => {
    const theta = Math.PI / 2 // 北向站点
    const result = buildNodeInstances([makeNode('c1', 'charge', 4, -2, theta)], OPTIONS)
    const [m] = instances(result.directions.matrices)
    // 列主序 rotation.y：m[0]=cosθ, m[2]=-sinθ, m[8]=sinθ, m[10]=cosθ
    expect(m[0]).toBeCloseTo(0, 10)
    expect(m[2]).toBeCloseTo(-1, 10)
    expect(m[8]).toBeCloseTo(1, 10)
    expect(m[10]).toBeCloseTo(0, 10)
    expect(m[12]).toBeCloseTo(4, 6)
    expect(m[13]).toBeCloseTo(STATION_DIRECTION_Y, 6)
    expect(m[14]).toBeCloseTo(2, 6)
  })

  it('混合节点一次遍历分入三批次', () => {
    const result = buildNodeInstances(
      [
        makeNode('n1', 'node', 0, 0),
        makeNode('n2', 'node', 1, 0),
        makeNode('w', 'work', 2, 0, 0),
        makeNode('p', 'park', 3, 0, null),
      ],
      OPTIONS,
    )
    expect(instances(result.dots.matrices)).toHaveLength(2)
    expect(instances(result.rings.matrices)).toHaveLength(2)
    expect(instances(result.directions.matrices)).toHaveLength(1)
    expect(result.rings.colors).toHaveLength(6)
    expect(result.directions.colors).toHaveLength(3)
  })

  it('空节点集：三批次皆为空数组', () => {
    const result = buildNodeInstances([], OPTIONS)
    expect(result.dots.matrices).toHaveLength(0)
    expect(result.rings.matrices).toHaveLength(0)
    expect(result.rings.colors).toHaveLength(0)
    expect(result.directions.matrices).toHaveLength(0)
    expect(result.directions.colors).toHaveLength(0)
  })
})
