/*
 * P2 视觉增强资源测试：充电桩闪电贴花几何（P2-1）与节点暗描边几何（P2-3）。
 *
 * 职责：在无 Canvas 的无头环境下锁定两个新增几何工厂的形状合同——
 * 1. buildChargeBoltGeometry：桩身四立面各一块贴花四边形，位于桩面之外、
 *    垂直居中于桩身，UV 全格；
 * 2. createNodeDiscGeometry：中心盘（顶点色 1）+ 外圈暗描边环（顶点色 =
 *    描边乘数）合并为一份索引几何，总半径 = 盘半径 + 描边宽度；
 * 3. createChargeBoltTexture 在无 Canvas 环境返回 null（降级合同）。
 */
import { describe, expect, it } from 'vitest'
import { buildChargeBoltGeometry, createChargeBoltTexture } from '../scene/chargeBolt'
import { createNodeDiscGeometry } from '../scene/nodeDiscGeometry'
import {
  CHARGE_BOLT_FACE_OFFSET_M,
  CHARGE_BOLT_HEIGHT_M,
  CHARGE_PILE_DEPTH_M,
  CHARGE_PILE_HEIGHT_M,
  CHARGE_PILE_WIDTH_M,
  NODE_OUTLINE_STRENGTH,
  NODE_OUTLINE_WIDTH_M,
  NODE_RADIUS_M,
} from '../scene/mapAppearance'

describe('createChargeBoltTexture（P2-1 闪电贴花图集）', () => {
  it('无 Canvas 2D 上下文时返回 null（贴花整体降级，不阻断挂载）', () => {
    expect(createChargeBoltTexture()).toBeNull()
  })
})

describe('buildChargeBoltGeometry（P2-1 桩身四面贴花）', () => {
  const geometry = buildChargeBoltGeometry()

  it('四块立面贴花四边形（16 顶点 / 24 索引），含 uv 与包围球', () => {
    expect(geometry.getAttribute('position').count).toBe(4 * 4)
    expect(geometry.getAttribute('uv').count).toBe(4 * 4)
    expect(geometry.getIndex()).not.toBeNull()
    expect(geometry.getIndex()!.count).toBe(4 * 6)
    expect(geometry.boundingSphere).not.toBeNull()
  })

  it('贴花位于桩面之外且垂直居中于桩身（尺寸 = CHARGE_BOLT_HEIGHT_M）', () => {
    geometry.computeBoundingBox()
    const box = geometry.boundingBox!
    const half = CHARGE_BOLT_HEIGHT_M / 2
    // 高度方向：桩身中点 ± 半贴花
    expect(box.max.y).toBeCloseTo(CHARGE_PILE_HEIGHT_M / 2 + half, 6)
    expect(box.min.y).toBeCloseTo(CHARGE_PILE_HEIGHT_M / 2 - half, 6)
    // 每个立面 4 顶点：±z 面贴在桩深之外、±x 面贴在桩宽之外（外扩间距）
    const positions = geometry.getAttribute('position')
    let faceZ = 0
    let faceX = 0
    for (let i = 0; i < positions.count; i += 1) {
      if (Math.abs(Math.abs(positions.getZ(i)) - (CHARGE_PILE_DEPTH_M / 2 + CHARGE_BOLT_FACE_OFFSET_M)) < 1e-6) {
        faceZ += 1
      }
      if (Math.abs(Math.abs(positions.getX(i)) - (CHARGE_PILE_WIDTH_M / 2 + CHARGE_BOLT_FACE_OFFSET_M)) < 1e-6) {
        faceX += 1
      }
    }
    expect(faceZ).toBe(8)
    expect(faceX).toBe(8)
  })

  it('uv 全格且顶行 v=1（flipY 纹理直立）', () => {
    const uv = geometry.getAttribute('uv')
    const vValues = new Set<number>()
    for (let i = 0; i < uv.count; i += 1) {
      vValues.add(uv.getY(i))
    }
    expect([...vValues].sort()).toEqual([0, 1])
  })
})

describe('createNodeDiscGeometry（P2-3 盘 + 暗描边内环）', () => {
  const geometry = createNodeDiscGeometry()

  it('总半径 = 盘半径 + 描边宽度，索引几何含 position/uv/color', () => {
    geometry.computeBoundingBox()
    const box = geometry.boundingBox!
    const totalRadius = NODE_RADIUS_M + NODE_OUTLINE_WIDTH_M
    expect(box.max.x).toBeCloseTo(totalRadius, 6)
    expect(box.min.x).toBeCloseTo(-totalRadius, 6)
    expect(geometry.getIndex()).not.toBeNull()
    expect(geometry.getAttribute('color')).toBeDefined()
    expect(geometry.getAttribute('uv')).toBeDefined()
  })

  it('顶点色双档：盘区 = 1（实例色原样），描边环 = 描边乘数（最外圈必为描边色）', () => {
    const positions = geometry.getAttribute('position')
    const colors = geometry.getAttribute('color')
    let discVerts = 0
    let outlineVerts = 0
    let maxRadius = 0
    let maxRadiusStrength = 0
    for (let i = 0; i < positions.count; i += 1) {
      const strength = colors.getX(i)
      if (Math.abs(strength - 1) < 1e-6) {
        discVerts += 1
      } else if (Math.abs(strength - NODE_OUTLINE_STRENGTH) < 1e-6) {
        outlineVerts += 1
      }
      // rgb 三分量恒等（灰度乘数）
      expect(colors.getX(i)).toBeCloseTo(colors.getZ(i), 6)
      const r = Math.hypot(positions.getX(i), positions.getZ(i))
      if (r > maxRadius) {
        maxRadius = r
        maxRadiusStrength = strength
      }
    }
    expect(discVerts).toBeGreaterThan(0)
    expect(outlineVerts).toBeGreaterThan(0)
    expect(maxRadius).toBeCloseTo(NODE_RADIUS_M + NODE_OUTLINE_WIDTH_M, 6)
    expect(maxRadiusStrength).toBeCloseTo(NODE_OUTLINE_STRENGTH, 6)
  })
})
