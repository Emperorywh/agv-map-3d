import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  COLUMN_CORRIDOR_CLEARANCE,
  COLUMN_SIZE,
  COLUMN_SPACING,
  FACTORY_MARGIN,
  FLOOR_GRID_LIFT,
  FLOOR_GRID_STEP,
  SKYLIGHT_EDGE_INSET,
  SKYLIGHT_LIFT,
  SKYLIGHT_STRIP_SPACING,
  SKYLIGHT_STRIP_WIDTH,
  WALL_HEIGHT,
} from '../../../config/constants'
import { mapToWorld } from '../../../domain/coordinates'
import { normalizeMapFromJson } from '../../../domain/normalize'
import { buildPolyline, distanceToPolyline } from '../../../domain/polyline'
import type { Calibration, MapBounds } from '../../../domain/types'
import {
  buildShellGeometry,
  computeColumnPlacements,
  computeFactoryFootprint,
  computeFloorGridLines,
  computeSkylightStrips,
} from './shellGeometry'
import type { ShellGeometryParams } from './shellGeometry'

/** 与场景层一致的参数装配（值取自 config/constants.ts） */
const SHELL_PARAMS: ShellGeometryParams = {
  margin: FACTORY_MARGIN,
  wallHeight: WALL_HEIGHT,
  gridStep: FLOOR_GRID_STEP,
  gridLift: FLOOR_GRID_LIFT,
  columnSpacing: COLUMN_SPACING,
  columnSize: COLUMN_SIZE,
  columnClearance: COLUMN_CORRIDOR_CLEARANCE,
  skylightStripWidth: SKYLIGHT_STRIP_WIDTH,
  skylightStripSpacing: SKYLIGHT_STRIP_SPACING,
  skylightEdgeInset: SKYLIGHT_EDGE_INSET,
  skylightLift: SKYLIGHT_LIFT,
}

describe('shellGeometry：computeFactoryFootprint（SPEC §5.2 尺寸口径）', () => {
  it('footprint = 地图包围盒四周各外扩 margin，尺寸 / 中心正确', () => {
    const bounds: MapBounds = { minX: 0, minY: 0, maxX: 10, maxY: 20 }
    const footprint = computeFactoryFootprint(bounds, 2)
    expect(footprint).toEqual({
      minX: -2,
      minY: -2,
      maxX: 12,
      maxY: 22,
      width: 14,
      depth: 24,
      centerX: 5,
      centerY: 10,
    })
  })

  it('footprint 中心与地图包围盒中心一致（与 §4.3 calibration offset 同源）', () => {
    const bounds: MapBounds = { minX: -165.74, minY: -25.12, maxX: 2.1, maxY: 50.2 }
    const footprint = computeFactoryFootprint(bounds, FACTORY_MARGIN)
    expect(footprint.centerX).toBeCloseTo((bounds.minX + bounds.maxX) / 2, 12)
    expect(footprint.centerY).toBeCloseTo((bounds.minY + bounds.maxY) / 2, 12)
    expect(footprint.width).toBeCloseTo(bounds.maxX - bounds.minX + 2 * FACTORY_MARGIN, 12)
    expect(footprint.depth).toBeCloseTo(bounds.maxY - bounds.minY + 2 * FACTORY_MARGIN, 12)
  })
})

describe('shellGeometry：computeColumnPlacements 柱位避让采样（SPEC §5.2）', () => {
  const footprint = computeFactoryFootprint({ minX: 0, minY: 0, maxX: 10, maxY: 20 }, 2)

  it('无走廊时按柱距整数倍规则阵列（x ∈ {0,12}，y ∈ {0,12}）', () => {
    const placements = computeColumnPlacements(footprint, 12, [], 2)
    expect(placements).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 12 },
      { x: 12, y: 0 },
      { x: 12, y: 12 },
    ])
  })

  it('与走廊中心线距离小于阈值的候选位被剔除，其余保留', () => {
    // 走廊沿 y=0 横贯：候选 (0,0) / (12,0) 距离 0 剔除；(0,12) / (12,12) 距离 12 保留
    const corridor = buildPolyline([
      { x: -100, y: 0 },
      { x: 100, y: 0 },
    ])
    const placements = computeColumnPlacements(footprint, 12, [corridor], 2)
    expect(placements).toEqual([
      { x: 0, y: 12 },
      { x: 12, y: 12 },
    ])
  })

  it('距离恰等于阈值时保留（小于阈值才剔除）', () => {
    const corridor = buildPolyline([
      { x: -100, y: 2 },
      { x: 100, y: 2 },
    ])
    const placements = computeColumnPlacements(footprint, 12, [corridor], 2)
    // (0,0) / (12,0) 距离恰为 2 = 阈值 → 保留
    expect(placements).toContainEqual({ x: 0, y: 0 })
    expect(placements).toContainEqual({ x: 12, y: 0 })
  })

  it('折线走廊按点-折线最短距离判定（斜向走廊）', () => {
    // 斜穿 (12,12) 的折线：候选 (12,12) 在折线上距离 0 剔除
    const corridor = buildPolyline([
      { x: 12, y: -50 },
      { x: 12, y: 12 },
      { x: 12, y: 50 },
    ])
    const placements = computeColumnPlacements(footprint, 12, [corridor], 2)
    expect(placements).not.toContainEqual({ x: 12, y: 12 })
    expect(placements).toContainEqual({ x: 0, y: 12 })
  })
})

describe('shellGeometry：computeSkylightStrips 天窗带布局（SPEC §5.2）', () => {
  it('沿 footprint 长轴延伸、短轴等距居中排布、四周内缩', () => {
    // width=14（x 短轴）、depth=24（y 长轴）→ 条带沿 y 延伸
    const footprint = computeFactoryFootprint({ minX: 0, minY: 0, maxX: 10, maxY: 20 }, 2)
    const strips = computeSkylightStrips(footprint, 3, 6, 2)
    // span = 14-4 = 10 → count = floor(10/6)+1 = 2；首带中心 = minX + (14-6)/2 = 2
    expect(strips).toEqual([
      { centerX: 2, centerY: 10, lengthX: 3, lengthY: 20 },
      { centerX: 8, centerY: 10, lengthX: 3, lengthY: 20 },
    ])
  })

  it('x 为长轴时条带沿 x 延伸；短轴放不下带宽时返回空', () => {
    const wide = computeFactoryFootprint({ minX: 0, minY: 0, maxX: 100, maxY: 20 }, 0)
    const strips = computeSkylightStrips(wide, 4, 12, 6)
    expect(strips.length).toBeGreaterThan(0)
    for (const strip of strips) {
      expect(strip.lengthX).toBeCloseTo(100 - 12, 12)
      expect(strip.lengthY).toBe(4)
      expect(strip.centerY).toBe(10)
    }
    const narrow = computeFactoryFootprint({ minX: 0, minY: 0, maxX: 100, maxY: 8 }, 0)
    expect(computeSkylightStrips(narrow, 4, 12, 6)).toEqual([])
  })
})

describe('shellGeometry：computeFloorGridLines 网格刻线（SPEC §5.2 每 10m）', () => {
  it('footprint 内对齐 step 整数倍的纵横线段', () => {
    const footprint = computeFactoryFootprint({ minX: 0, minY: 0, maxX: 10, maxY: 20 }, 2)
    const segments = computeFloorGridLines(footprint, 10)
    expect(segments).toEqual([
      { a: { x: 0, y: -2 }, b: { x: 0, y: 22 } },
      { a: { x: 10, y: -2 }, b: { x: 10, y: 22 } },
      { a: { x: -2, y: 0 }, b: { x: 12, y: 0 } },
      { a: { x: -2, y: 10 }, b: { x: 12, y: 10 } },
      { a: { x: -2, y: 20 }, b: { x: 12, y: 20 } },
    ])
  })
})

describe('shellGeometry：buildShellGeometry 几何构建（与 calibration 共用同一转换）', () => {
  const bounds: MapBounds = { minX: 0, minY: 0, maxX: 10, maxY: 20 }
  const calibration: Calibration = { scale: 1, rotationRad: 0, offsetX: 5, offsetY: 10 }

  it('地坪 / 外墙 / 屋顶 / 天窗带顶点经 mapToWorld 转换，尺寸为 包围盒+margin', () => {
    const result = buildShellGeometry(bounds, [], calibration, SHELL_PARAMS)
    const footprint = computeFactoryFootprint(bounds, SHELL_PARAMS.margin)

    // 地坪：单块平面 4 顶点 2 三角形，y=0，角点 = mapToWorld(footprint 角)
    const floorPosition = result.floor.getAttribute('position')
    expect(floorPosition.count).toBe(4)
    expect(result.floor.getIndex()?.count).toBe(6)
    const expectedCorner = mapToWorld({ x: footprint.minX, y: footprint.minY }, calibration)
    expect(floorPosition.getX(0)).toBeCloseTo(expectedCorner.x, 12)
    expect(floorPosition.getY(0)).toBe(0)
    expect(floorPosition.getZ(0)).toBeCloseTo(expectedCorner.z, 12)
    // 法线 +Y（经 y→-z 反射后的正确绕序）
    const floorNormal = result.floor.getAttribute('normal')
    expect(floorNormal.getY(0)).toBeCloseTo(1, 6)

    // 外墙：4 面合并 16 顶点 8 三角形，底边 y=0、顶边 y=WALL_HEIGHT
    const wallPosition = result.walls.getAttribute('position')
    expect(wallPosition.count).toBe(16)
    expect(result.walls.getIndex()?.count).toBe(24)
    expect(wallPosition.getY(0)).toBe(0)
    expect(wallPosition.getY(2)).toBe(WALL_HEIGHT)

    // 屋顶：y=WALL_HEIGHT 水平面；天窗带：y=WALL_HEIGHT+SKYLIGHT_LIFT（float32 存储精度）
    expect(result.roof.getAttribute('position').getY(0)).toBe(WALL_HEIGHT)
    expect(result.skylights.getAttribute('position').getY(0)).toBeCloseTo(
      WALL_HEIGHT + SKYLIGHT_LIFT,
      4,
    )

    // 网格刻线抬升低于 ribbon（RIBBON_LIFT=0.02），位于地坪之上（float32 存储精度）
    expect(result.floorGrid.getAttribute('position').getY(0)).toBeCloseTo(FLOOR_GRID_LIFT, 4)
    result.dispose()
  })

  it('立柱实例矩阵：数量 = 柱位数，位置经 mapToWorld（与地图天然对齐）', () => {
    const result = buildShellGeometry(bounds, [], calibration, SHELL_PARAMS)
    const placements = computeColumnPlacements(
      computeFactoryFootprint(bounds, SHELL_PARAMS.margin),
      SHELL_PARAMS.columnSpacing,
      [],
      SHELL_PARAMS.columnClearance,
    )
    expect(result.columnCount).toBe(placements.length)
    expect(result.columnMatrices.length).toBe(placements.length * 16)
    const world = mapToWorld(placements[0], calibration)
    expect(result.columnMatrices[12]).toBeCloseTo(world.x, 12)
    expect(result.columnMatrices[13]).toBe(0)
    expect(result.columnMatrices[14]).toBeCloseTo(world.z, 12)
    result.dispose()
  })

  it('外壳中心即世界原点（offset = 包围盒中心，天然对齐无二次配准）', () => {
    const result = buildShellGeometry(bounds, [], calibration, SHELL_PARAMS)
    const position = result.floor.getAttribute('position')
    // 地坪 4 角世界坐标均值 = 包围盒中心经 mapToWorld = 原点（offset 即包围盒中心）
    let sumX = 0
    let sumZ = 0
    for (let i = 0; i < position.count; i++) {
      sumX += position.getX(i)
      sumZ += position.getZ(i)
    }
    expect(sumX / position.count).toBeCloseTo(0, 12)
    expect(sumZ / position.count).toBeCloseTo(0, 12)
    result.dispose()
  })
})

describe('shellGeometry：真实 map.json 集成（SPEC §4.1 / §5.2）', () => {
  it('外壳尺寸 = 真实包围盒+margin；柱位全部避开走廊且非空', () => {
    const mapJsonPath = fileURLToPath(new URL('../../../../public/map.json', import.meta.url))
    const { map } = normalizeMapFromJson(readFileSync(mapJsonPath, 'utf8'))

    const footprint = computeFactoryFootprint(map.bounds, SHELL_PARAMS.margin)
    expect(footprint.width).toBeCloseTo(map.bounds.maxX - map.bounds.minX + 2 * FACTORY_MARGIN, 9)
    expect(footprint.depth).toBeCloseTo(map.bounds.maxY - map.bounds.minY + 2 * FACTORY_MARGIN, 9)

    const corridorGeometries = map.corridors.map((corridor) => corridor.geometry)
    const placements = computeColumnPlacements(
      footprint,
      SHELL_PARAMS.columnSpacing,
      corridorGeometries,
      SHELL_PARAMS.columnClearance,
    )
    // 真实数据下存在可用柱位，且每个柱位与所有走廊中心线距离 ≥ 避让阈值
    expect(placements.length).toBeGreaterThan(0)
    for (const placement of placements) {
      for (const geometry of corridorGeometries) {
        expect(distanceToPolyline(placement, geometry)).toBeGreaterThanOrEqual(
          SHELL_PARAMS.columnClearance,
        )
      }
    }

    // 整体构建冒烟：分组几何与实例计数一致
    const result = buildShellGeometry(map.bounds, corridorGeometries, map.calibration, SHELL_PARAMS)
    expect(result.columnCount).toBe(placements.length)
    expect(result.floor.getAttribute('position').count).toBe(4)
    expect(result.walls.getAttribute('position').count).toBe(16)
    result.dispose()
  })
})
