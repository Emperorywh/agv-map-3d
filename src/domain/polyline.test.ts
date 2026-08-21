import { describe, expect, it } from 'vitest'

import { buildPolyline, samplePolylineAt } from './polyline'

describe('polyline：buildPolyline 弧长表', () => {
  it('累积弧长表单调不减、首项 0、末项为总长', () => {
    const polyline = buildPolyline([
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 4 },
    ])
    expect(polyline.cumulativeLengths).toEqual([0, 3, 7])
    expect(polyline.length).toBe(7)
  })
})

describe('polyline：samplePolylineAt 弧长采样（SPEC §7.2 弧长参数化）', () => {
  it('单段中点：线性插值 + 单位切向', () => {
    const polyline = buildPolyline([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ])
    const sample = samplePolylineAt(polyline, 5)
    expect(sample.point).toEqual({ x: 5, y: 0 })
    expect(sample.tangent).toEqual({ x: 1, y: 0 })
  })

  it('弧长夹取到 [0, length]', () => {
    const polyline = buildPolyline([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ])
    expect(samplePolylineAt(polyline, -1).point).toEqual({ x: 0, y: 0 })
    const end = samplePolylineAt(polyline, 999)
    expect(end.point).toEqual({ x: 10, y: 0 })
    expect(end.tangent).toEqual({ x: 1, y: 0 })
  })

  it('多段折线：按累积弧长定位段并插值', () => {
    const polyline = buildPolyline([
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 4 },
    ])
    const sample = samplePolylineAt(polyline, 4.5)
    expect(sample.point).toEqual({ x: 3, y: 1.5 })
    expect(sample.tangent).toEqual({ x: 0, y: 1 })
  })

  it('段边界弧长落入下一段（切向取行进方向）', () => {
    const polyline = buildPolyline([
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 4 },
    ])
    const sample = samplePolylineAt(polyline, 3)
    expect(sample.point).toEqual({ x: 3, y: 0 })
    expect(sample.tangent).toEqual({ x: 0, y: 1 })
  })

  it('零长度段跳过：切向取最近非零段', () => {
    const polyline = buildPolyline([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 5, y: 0 },
    ])
    const sample = samplePolylineAt(polyline, 0)
    expect(sample.point).toEqual({ x: 0, y: 0 })
    expect(sample.tangent).toEqual({ x: 1, y: 0 })
  })
})
