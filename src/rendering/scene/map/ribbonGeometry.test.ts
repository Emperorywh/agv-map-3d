import { Color } from 'three'
import type { BufferGeometry } from 'three'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { normalizeMapFromJson } from '../../../domain/normalize'
import { buildPolyline } from '../../../domain/polyline'
import type { Calibration, Corridor, CorridorDirection, MapPoint } from '../../../domain/types'
import {
  CORRIDOR_INDEX_ATTRIBUTE,
  buildArrowGeometry,
  buildRibbonGeometry,
  createRibbonGeometryBuilder,
  getCorridorIdAtFace,
} from './ribbonGeometry'
import type { RibbonGeometryParams } from './ribbonGeometry'

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

const TEST_PARAMS: RibbonGeometryParams = {
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

/** 恒等校准：地图 (x, y) → 世界 (x, 0, -y) */
const IDENTITY_CALIBRATION: Calibration = { scale: 1, rotationRad: 0, offsetX: 0, offsetY: 0 }

function direction(
  edgeId: string,
  from: string,
  to: string,
  alongGeometry: boolean,
  isBack: boolean,
): CorridorDirection {
  return { edgeId, from, to, alongGeometry, isBack }
}

function makeCorridor(id: string, points: MapPoint[], directions: CorridorDirection[]): Corridor {
  return {
    id,
    nodeA: 'A',
    nodeB: 'B',
    edgeIds: directions.map((d) => d.edgeId),
    geometry: buildPolyline(points),
    bidirectional: directions.length === 2,
    directions,
  }
}

/** 双向走廊：几何方向 = A→B；backOn 指定 back 归属方向（forward=A→B 顺几何） */
function twoWay(points: MapPoint[], backOn: 'forward' | 'backward' | null, id = 'c1'): Corridor {
  return makeCorridor(id, points, [
    direction(`${id}-f`, 'A', 'B', true, backOn === 'forward'),
    direction(`${id}-b`, 'B', 'A', false, backOn === 'backward'),
  ])
}

/** 单向走廊；alongGeometry=false 表示行驶方向与几何相反 */
function oneWay(points: MapPoint[], isBack: boolean, id = 'c1', alongGeometry = true): Corridor {
  return makeCorridor(id, points, [
    direction(`${id}-1`, alongGeometry ? 'A' : 'B', alongGeometry ? 'B' : 'A', alongGeometry, isBack),
  ])
}

const STRAIGHT: MapPoint[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
]

function readPosition(geometry: BufferGeometry, vertexIndex: number): [number, number, number] {
  const attribute = geometry.getAttribute('position')
  return [attribute.getX(vertexIndex), attribute.getY(vertexIndex), attribute.getZ(vertexIndex)]
}

function expectPosition(
  geometry: BufferGeometry,
  vertexIndex: number,
  expected: [number, number, number],
): void {
  const [x, y, z] = readPosition(geometry, vertexIndex)
  expect(x).toBeCloseTo(expected[0], 5)
  expect(y).toBeCloseTo(expected[1], 5)
  expect(z).toBeCloseTo(expected[2], 5)
}

function expectVertexColor(geometry: BufferGeometry, vertexIndex: number, hex: string): void {
  const expected = new Color(hex)
  const attribute = geometry.getAttribute('color')
  expect(attribute.getX(vertexIndex)).toBeCloseTo(expected.r, 6)
  expect(attribute.getY(vertexIndex)).toBeCloseTo(expected.g, 6)
  expect(attribute.getZ(vertexIndex)).toBeCloseTo(expected.b, 6)
}

// ---------------------------------------------------------------------------
// 三角带顶点数 / 索引 / miter
// ---------------------------------------------------------------------------

describe('ribbon：三角带顶点与索引（SPEC §6.2）', () => {
  it('直线走廊：每点 2 顶点、每段 2 三角形，顶点色 + corridorIndex 属性', () => {
    const result = buildRibbonGeometry([twoWay(STRAIGHT, null)], IDENTITY_CALIBRATION, TEST_PARAMS)
    const { geometry } = result

    // 2 点 → 4 顶点（左/右交替），1 段 → 2 三角形（6 索引）
    expect(geometry.getAttribute('position').count).toBe(4)
    expect(geometry.index?.count).toBe(6)
    expect(Array.from(geometry.index?.array ?? [])).toEqual([0, 1, 2, 1, 3, 2])

    // 半宽 0.75：左侧 = 地图 +y → 世界 -z；y = RIBBON_LIFT
    expectPosition(geometry, 0, [0, 0.02, -0.75])
    expectPosition(geometry, 1, [0, 0.02, 0.75])
    expectPosition(geometry, 2, [10, 0.02, -0.75])
    expectPosition(geometry, 3, [10, 0.02, 0.75])

    // 双向走廊：普通底色；corridorIndex 全为 0，反查表给出走廊 id
    for (let i = 0; i < 4; i++) {
      expectVertexColor(geometry, i, TEST_PARAMS.colors.normal as string)
      expect(geometry.getAttribute(CORRIDOR_INDEX_ATTRIBUTE).getX(i)).toBe(0)
    }
    expect(result.corridorIds).toEqual(['c1'])
    expect(result.arrowPlacements).toEqual([])
  })

  it('90° 拐角 miter join：内角点偏移 = 半宽 / cos(45°)', () => {
    const corner: MapPoint[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]
    const { geometry } = buildRibbonGeometry(
      [twoWay(corner, null)],
      IDENTITY_CALIBRATION,
      TEST_PARAMS,
    )
    expect(geometry.getAttribute('position').count).toBe(6)
    expect(geometry.index?.count).toBe(12)
    // 拐角点 (10,0)：miter 方向 (-1,1)/√2，长度 0.75·√2 → 偏移 (±0.75, ∓0.75)
    expectPosition(geometry, 2, [9.25, 0.02, -0.75])
    expectPosition(geometry, 3, [10.75, 0.02, 0.75])
    // 终点 (10,10)：末段左法向 (-1,0)
    expectPosition(geometry, 4, [9.25, 0.02, -10])
    expectPosition(geometry, 5, [10.75, 0.02, -10])
  })
})

describe('ribbon：miter 限长与拐角退化', () => {
  it('急拐角 miter 截断到 miterLimit × 半宽', () => {
    // 150° 偏转角：未截断 miter 长度 = 0.75 / cos(75°) ≈ 2.90 > 2 × 0.75
    const sharp: MapPoint[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10 + 10 * Math.cos((150 * Math.PI) / 180), y: 10 * Math.sin((150 * Math.PI) / 180) },
    ]
    const { geometry } = buildRibbonGeometry(
      [twoWay(sharp, null)],
      IDENTITY_CALIBRATION,
      TEST_PARAMS,
    )
    const [x, , z] = readPosition(geometry, 2)
    // 地图平面内偏移长度恰为 2 × 0.75 = 1.5（截断生效）
    expect(Math.hypot(x - 10, -z - 0)).toBeCloseTo(1.5, 4)
  })

  it.each([
    ['精确 180° 折返', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }]],
    ['近 180° 折返', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0.001 }]],
  ])('%s：顶点有限且无 NaN', (_label, points) => {
    const { geometry } = buildRibbonGeometry(
      [twoWay(points as MapPoint[], null)],
      IDENTITY_CALIBRATION,
      TEST_PARAMS,
    )
    expect(geometry.getAttribute('position').count).toBe(6)
    for (const component of geometry.getAttribute('position').array) {
      expect(Number.isFinite(component)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 虚线标识（back 方向边缘 / 单向 back 整条）
// ---------------------------------------------------------------------------

describe('ribbon：倒车虚线标识（SPEC §6.1 规则 4）', () => {
  it('双向 back 方向：行驶左侧画虚线边缘（虚线段数 / 位置 / 颜色）', () => {
    const { geometry } = buildRibbonGeometry(
      [twoWay(STRAIGHT, 'forward')],
      IDENTITY_CALIBRATION,
      TEST_PARAMS,
    )
    // 长 10m，实段 0.6 + 间隔 0.4 → 10 段 × 4 顶点；实心 4 顶点
    expect(geometry.getAttribute('position').count).toBe(4 + 40)
    expect(geometry.index?.count).toBe(6 + 60)

    // back 方向顺几何（forward）：左侧 = 地图 +y → 世界 -z；边缘带 [0.63, 0.75]
    expectPosition(geometry, 4, [0, 0.025, -0.63])
    expectPosition(geometry, 5, [0, 0.025, -0.75])
    expectPosition(geometry, 6, [0.6, 0.025, -0.75])
    expectPosition(geometry, 7, [0.6, 0.025, -0.63])
    for (let i = 4; i < 44; i++) {
      const [, y, z] = readPosition(geometry, i)
      expect(y).toBeCloseTo(0.025, 5)
      expect(z).toBeGreaterThanOrEqual(-0.75 - 1e-6)
      expect(z).toBeLessThanOrEqual(-0.63 + 1e-6)
      expectVertexColor(geometry, i, TEST_PARAMS.colors.back as string)
    }
  })

  it('back 方向逆几何行驶：虚线边缘翻到另一侧（行驶方向左侧）', () => {
    const { geometry } = buildRibbonGeometry(
      [twoWay(STRAIGHT, 'backward')],
      IDENTITY_CALIBRATION,
      TEST_PARAMS,
    )
    // 行驶方向 B→A 与几何相反：其左侧 = 地图 -y → 世界 +z
    expectPosition(geometry, 4, [0, 0.025, 0.75])
    expectPosition(geometry, 5, [0, 0.025, 0.63])
    for (let i = 4; i < 44; i++) {
      const [, , z] = readPosition(geometry, i)
      expect(z).toBeGreaterThanOrEqual(0.63 - 1e-6)
      expect(z).toBeLessThanOrEqual(0.75 + 1e-6)
    }
  })

  it('单向 back 走廊：无实心 ribbon，整条虚线 + 异色', () => {
    const result = buildRibbonGeometry(
      [oneWay(STRAIGHT, true)],
      IDENTITY_CALIBRATION,
      TEST_PARAMS,
    )
    const { geometry } = result
    // 仅 10 段虚线（全宽 ±0.75），无实心顶点
    expect(geometry.getAttribute('position').count).toBe(40)
    expect(geometry.index?.count).toBe(60)
    expectPosition(geometry, 0, [0, 0.025, 0.75])
    expectPosition(geometry, 1, [0, 0.025, -0.75])
    for (let i = 0; i < 40; i++) {
      expectVertexColor(geometry, i, TEST_PARAMS.colors.back as string)
    }
    // 单向 back 仍画 snode→enode 方向箭头
    expect(result.arrowPlacements).toHaveLength(1)
    expect(result.arrowPlacements[0].isBack).toBe(true)
  })

  it('短于一个虚线实段的走廊：整条画一段，标识不缺失', () => {
    const short: MapPoint[] = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0 },
    ]
    const { geometry } = buildRibbonGeometry(
      [twoWay(short, 'forward')],
      IDENTITY_CALIBRATION,
      TEST_PARAMS,
    )
    expect(geometry.getAttribute('position').count).toBe(4 + 4)
    expectPosition(geometry, 4, [0, 0.025, -0.63])
    expectPosition(geometry, 6, [0.5, 0.025, -0.75])
  })
})

// ---------------------------------------------------------------------------
// 单向箭头 placements
// ---------------------------------------------------------------------------

describe('ribbon：单向方向箭头（SPEC §6.1 规则 3）', () => {
  it('单向走廊：单向底色 + snode→enode 方向箭头（居中，+Z 前向经 headingToWorldYaw）', () => {
    const result = buildRibbonGeometry(
      [oneWay(STRAIGHT, false)],
      IDENTITY_CALIBRATION,
      TEST_PARAMS,
    )
    expectVertexColor(result.geometry, 0, TEST_PARAMS.colors.oneWay as string)
    // 长 10m < 间距 8m×2 → 1 个箭头，s=5 居中；行驶方向 = 地图 +x → yaw = π/2
    expect(result.arrowPlacements).toHaveLength(1)
    const arrow = result.arrowPlacements[0]
    expect(arrow.x).toBeCloseTo(5, 5)
    expect(arrow.y).toBeCloseTo(0.025, 5)
    expect(arrow.z).toBeCloseTo(0, 5)
    expect(arrow.yaw).toBeCloseTo(Math.PI / 2, 10)
    expect(arrow.corridorIndex).toBe(0)
    expect(arrow.isBack).toBe(false)
  })

  it('单向走廊行驶方向与几何相反：箭头朝向随行驶方向反转', () => {
    const result = buildRibbonGeometry(
      [oneWay(STRAIGHT, false, 'c1', false)],
      IDENTITY_CALIBRATION,
      TEST_PARAMS,
    )
    expect(result.arrowPlacements).toHaveLength(1)
    expect(result.arrowPlacements[0].x).toBeCloseTo(5, 5)
    // 与正向箭头相差 π（角度按 mod 2π 等价比较）
    const delta =
      Math.atan2(
        Math.sin(result.arrowPlacements[0].yaw - Math.PI / 2),
        Math.cos(result.arrowPlacements[0].yaw - Math.PI / 2),
      )
    expect(Math.abs(delta)).toBeCloseTo(Math.PI, 10)
  })

  it('长走廊按间距布置多个箭头', () => {
    const long: MapPoint[] = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]
    const result = buildRibbonGeometry([oneWay(long, false)], IDENTITY_CALIBRATION, TEST_PARAMS)
    // floor(20 / 8) = 2，均匀居中于 s=5 / s=15
    expect(result.arrowPlacements).toHaveLength(2)
    expect(result.arrowPlacements[0].x).toBeCloseTo(5, 5)
    expect(result.arrowPlacements[1].x).toBeCloseTo(15, 5)
  })

  it('双向走廊不画方向箭头', () => {
    const result = buildRibbonGeometry(
      [twoWay(STRAIGHT, null), twoWay(STRAIGHT, 'forward', 'c2')],
      IDENTITY_CALIBRATION,
      TEST_PARAMS,
    )
    expect(result.arrowPlacements).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 合并几何 / 反查 / 分帧构建
// ---------------------------------------------------------------------------

describe('ribbon：合并几何与 faceIndex 反查（SPEC §6.2 / §8.2）', () => {
  it('多条走廊合并为单个 BufferGeometry，每个三角形可反查走廊', () => {
    const result = buildRibbonGeometry(
      [twoWay(STRAIGHT, null, 'c1'), oneWay(STRAIGHT, false, 'c2')],
      IDENTITY_CALIBRATION,
      TEST_PARAMS,
    )
    expect(result.corridorIds).toEqual(['c1', 'c2'])
    // c1 两个三角形（face 0/1），c2 两个三角形（face 2/3）
    expect(getCorridorIdAtFace(result, 0)).toBe('c1')
    expect(getCorridorIdAtFace(result, 1)).toBe('c1')
    expect(getCorridorIdAtFace(result, 2)).toBe('c2')
    expect(getCorridorIdAtFace(result, 3)).toBe('c2')
    expect(getCorridorIdAtFace(result, 4)).toBeNull()
    expect(getCorridorIdAtFace(result, -1)).toBeNull()

    // 同一三角形三个顶点的 corridorIndex 一致
    const index = result.geometry.index
    const attribute = result.geometry.getAttribute(CORRIDOR_INDEX_ATTRIBUTE)
    expect(index).not.toBeNull()
    for (let face = 0; face < (index?.count ?? 0) / 3; face++) {
      const a = attribute.getX(index!.getX(face * 3))
      const b = attribute.getX(index!.getX(face * 3 + 1))
      const c = attribute.getX(index!.getX(face * 3 + 2))
      expect(a).toBe(b)
      expect(b).toBe(c)
    }
  })

  it('分帧构建与一次性构建结果一致，done / processed 语义正确', () => {
    const corridors = [
      twoWay(STRAIGHT, null, 'c1'),
      oneWay(STRAIGHT, false, 'c2'),
      twoWay(STRAIGHT, 'forward', 'c3'),
    ]
    const oneShot = buildRibbonGeometry(corridors, IDENTITY_CALIBRATION, TEST_PARAMS)

    const builder = createRibbonGeometryBuilder(corridors, IDENTITY_CALIBRATION, TEST_PARAMS)
    expect(builder.total).toBe(3)
    expect(builder.done).toBe(false)
    builder.buildNext(1)
    expect(builder.processed).toBe(1)
    builder.buildNext(1)
    expect(builder.processed).toBe(2)
    expect(builder.done).toBe(false)
    builder.buildNext(1)
    expect(builder.done).toBe(true)
    const chunked = builder.finalize()

    expect(chunked.corridorIds).toEqual(oneShot.corridorIds)
    expect(chunked.geometry.getAttribute('position').count).toBe(
      oneShot.geometry.getAttribute('position').count,
    )
    expect(chunked.geometry.index?.count).toBe(oneShot.geometry.index?.count)
    expect(chunked.arrowPlacements).toEqual(oneShot.arrowPlacements)
    // finalize 幂等；done 后 buildNext 不再改变结果
    builder.buildNext(1)
    expect(builder.finalize()).toBe(chunked)
  })

  it('空走廊集合：空几何、空反查表、空箭头', () => {
    const result = buildRibbonGeometry([], IDENTITY_CALIBRATION, TEST_PARAMS)
    expect(result.geometry.getAttribute('position').count).toBe(0)
    expect(result.geometry.index?.count).toBe(0)
    expect(result.corridorIds).toEqual([])
    expect(result.arrowPlacements).toEqual([])
  })
})

describe('ribbon：箭头单位几何（+Z 前向，SPEC §5.4）', () => {
  it('燕尾形 4 顶点 2 三角形，尖端指向 +Z，平贴 y=0', () => {
    const geometry = buildArrowGeometry(0.9, 0.6)
    expect(geometry.getAttribute('position').count).toBe(4)
    expect(geometry.index?.count).toBe(6)
    expectPosition(geometry, 0, [0, 0, 0.45])
    expectPosition(geometry, 1, [0.3, 0, -0.45])
    expectPosition(geometry, 3, [-0.3, 0, -0.45])
    const position = geometry.getAttribute('position')
    for (let i = 0; i < position.count; i++) {
      expect(position.getY(i)).toBe(0)
    }
  })
})

describe('ribbon：真实 map.json 集成（SPEC §4.1 / §6.2）', () => {
  it('2046 条走廊合并构建：顶点 / 索引 / 反查 / 箭头全部有限且一致', () => {
    const mapJsonPath = fileURLToPath(new URL('../../../../public/map.json', import.meta.url))
    const { map } = normalizeMapFromJson(readFileSync(mapJsonPath, 'utf8'))
    expect(map.corridors).toHaveLength(2046)

    const result = buildRibbonGeometry(map.corridors, map.calibration, TEST_PARAMS)
    const { geometry } = result
    const position = geometry.getAttribute('position')
    const corridorIndex = geometry.getAttribute(CORRIDOR_INDEX_ATTRIBUTE)
    const index = geometry.index
    expect(position.count).toBeGreaterThan(0)
    expect(index).not.toBeNull()
    expect(result.corridorIds).toHaveLength(2046)

    // 顶点 / 颜色 / corridorIndex 属性等长且全部有限；索引不越界
    expect(geometry.getAttribute('color').count).toBe(position.count)
    expect(corridorIndex.count).toBe(position.count)
    for (const component of position.array) {
      expect(Number.isFinite(component)).toBe(true)
    }
    const triangleCount = (index?.count ?? 0) / 3
    expect(triangleCount).toBeGreaterThan(2046) // 每走廊至少 2 三角形（含虚线更多）
    for (let i = 0; i < (index?.count ?? 0); i++) {
      const vertexIndex = index?.getX(i) ?? -1
      expect(vertexIndex).toBeGreaterThanOrEqual(0)
      expect(vertexIndex).toBeLessThan(position.count)
    }
    for (let i = 0; i < position.count; i++) {
      expect(corridorIndex.getX(i)).toBeGreaterThanOrEqual(0)
      expect(corridorIndex.getX(i)).toBeLessThan(2046)
    }
    // 抽样 faceIndex 反查：返回走廊 id 表内成员
    for (const face of [0, Math.floor(triangleCount / 2), triangleCount - 1]) {
      expect(result.corridorIds).toContain(getCorridorIdAtFace(result, face))
    }

    // 1049 条单向走廊每条至少 1 个箭头；placements 全部有限
    expect(result.arrowPlacements.length).toBeGreaterThanOrEqual(1049)
    for (const arrow of result.arrowPlacements) {
      expect(Number.isFinite(arrow.x)).toBe(true)
      expect(Number.isFinite(arrow.y)).toBe(true)
      expect(Number.isFinite(arrow.z)).toBe(true)
      expect(Number.isFinite(arrow.yaw)).toBe(true)
      expect(arrow.corridorIndex).toBeGreaterThanOrEqual(0)
      expect(arrow.corridorIndex).toBeLessThan(2046)
    }
  })
})
