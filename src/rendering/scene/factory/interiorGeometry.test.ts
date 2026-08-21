import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Box3, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import {
  AREA_BLOCK_LIFT,
  CHANDELIER_DROP,
  CHANDELIER_EDGE_INSET,
  CHANDELIER_RADIUS,
  CHANDELIER_SPACING,
  CHANDELIER_THICKNESS,
  CHARGE_PILE_OFFSET,
  CHARGE_SPOT_LENGTH,
  CHARGE_SPOT_WIDTH,
  CHARGING_PILE_DEPTH,
  CHARGING_PILE_HEIGHT,
  CHARGING_PILE_WIDTH,
  FACTORY_MARGIN,
  LANE_LINE_GAP,
  LANE_LINE_WIDTH,
  LOADING_AREA_SIZE,
  MARKING_LIFT,
  RIBBON_WIDTH,
  ROLLER_DOOR_BEAM_HEIGHT,
  ROLLER_DOOR_FRACTIONS,
  ROLLER_DOOR_FRAME_DEPTH,
  ROLLER_DOOR_HEIGHT,
  ROLLER_DOOR_INSET,
  ROLLER_DOOR_PANEL_THICKNESS,
  ROLLER_DOOR_POST_SIZE,
  ROLLER_DOOR_RIB_HEIGHT,
  ROLLER_DOOR_RIB_SPACING,
  ROLLER_DOOR_WIDTH,
  SHELF_CELL_SIZE,
  SHELF_CHARGE_CLEARANCE,
  SHELF_CORRIDOR_CLEARANCE,
  SHELF_DOOR_CLEARANCE,
  SHELF_MIN_RUN_CELLS,
  SHELF_ROW_DEPTH,
  SHELF_ROW_HEIGHT,
  SHELF_WALL_INSET,
  WALL_HEIGHT,
  WORKBENCH_ROW_DEPTH,
  WORKBENCH_ROW_HEIGHT,
  ZEBRA_START_INSET,
  ZEBRA_STRIPE_COUNT,
  ZEBRA_STRIPE_GAP,
  ZEBRA_STRIPE_WIDTH,
} from '../../../config/constants'
import { interiorColors, markingColors } from '../../../config/theme'
import { mapToWorld } from '../../../domain/coordinates'
import { normalizeMapFromJson } from '../../../domain/normalize'
import { buildPolyline, distanceToPolyline } from '../../../domain/polyline'
import type { MapBounds, NormalizedMap, NormalizedNode } from '../../../domain/types'
import {
  buildChargingPilePlaceholder,
  buildInteriorGeometry,
  buildRollerDoorFramePlaceholder,
  computeChargePlacements,
  computeChandelierPlacements,
  computeLoadingAreas,
  computeRollerDoorPlacements,
  computeStorageRows,
  computeZebraStripes,
} from './interiorGeometry'
import type { InteriorGeometryParams, StorageRowParams } from './interiorGeometry'
import { computeFactoryFootprint } from './shellGeometry'

/** 与场景层一致的参数装配（值取自 config/constants.ts 与 config/theme.ts） */
const INTERIOR_PARAMS: InteriorGeometryParams = {
  margin: FACTORY_MARGIN,
  ribbonWidth: RIBBON_WIDTH,
  wallHeight: WALL_HEIGHT,
  storage: {
    cellSize: SHELF_CELL_SIZE,
    wallInset: SHELF_WALL_INSET,
    corridorClearance: SHELF_CORRIDOR_CLEARANCE,
    doorClearance: SHELF_DOOR_CLEARANCE,
    chargeClearance: SHELF_CHARGE_CLEARANCE,
    minRunCells: SHELF_MIN_RUN_CELLS,
    shelfDepth: SHELF_ROW_DEPTH,
    shelfHeight: SHELF_ROW_HEIGHT,
    workbenchDepth: WORKBENCH_ROW_DEPTH,
    workbenchHeight: WORKBENCH_ROW_HEIGHT,
  },
  chargePileOffset: CHARGE_PILE_OFFSET,
  chargeSpotLength: CHARGE_SPOT_LENGTH,
  chargeSpotWidth: CHARGE_SPOT_WIDTH,
  loadingAreaSize: LOADING_AREA_SIZE,
  doorFractions: ROLLER_DOOR_FRACTIONS,
  doorWidth: ROLLER_DOOR_WIDTH,
  doorHeight: ROLLER_DOOR_HEIGHT,
  doorInset: ROLLER_DOOR_INSET,
  doorPanelThickness: ROLLER_DOOR_PANEL_THICKNESS,
  doorRibSpacing: ROLLER_DOOR_RIB_SPACING,
  doorRibHeight: ROLLER_DOOR_RIB_HEIGHT,
  zebraStripeWidth: ZEBRA_STRIPE_WIDTH,
  zebraStripeGap: ZEBRA_STRIPE_GAP,
  zebraStripeCount: ZEBRA_STRIPE_COUNT,
  zebraStartInset: ZEBRA_START_INSET,
  chandelierSpacing: CHANDELIER_SPACING,
  chandelierEdgeInset: CHANDELIER_EDGE_INSET,
  chandelierDrop: CHANDELIER_DROP,
  chandelierRadius: CHANDELIER_RADIUS,
  chandelierThickness: CHANDELIER_THICKNESS,
  laneLineGap: LANE_LINE_GAP,
  laneLineWidth: LANE_LINE_WIDTH,
  markingLift: MARKING_LIFT,
  areaBlockLift: AREA_BLOCK_LIFT,
  colors: {
    laneLine: markingColors.laneLine,
    zebra: markingColors.zebra,
    chargeArea: markingColors.chargeArea,
    loadingArea: markingColors.loadingArea,
    doorPanel: interiorColors.rollerDoorPanel,
    doorRib: interiorColors.rollerDoorRib,
  },
}

const STORAGE_PARAMS: StorageRowParams = INTERIOR_PARAMS.storage

function loadRealMap(): NormalizedMap {
  const mapJsonPath = fileURLToPath(new URL('../../../../public/map.json', import.meta.url))
  return normalizeMapFromJson(readFileSync(mapJsonPath, 'utf8')).map
}

/** 浮点数组逐项近似断言 */
function expectArrayCloseTo(actual: number[], expected: number[], precision = 9): void {
  expect(actual.length).toBe(expected.length)
  for (let i = 0; i < actual.length; i++) {
    expect(actual[i]).toBeCloseTo(expected[i], precision)
  }
}

describe('interiorGeometry：computeStorageRows 货架 / 工作台放置采样（SPEC §5.3）', () => {
  // 网格 2.4m、内缩 0.5：候选中心 (i+0.5)×2.4 ∈ [inset, 边界-inset]
  const footprint = computeFactoryFootprint({ minX: 0, minY: 0, maxX: 24, maxY: 12 }, 0)
  const params: StorageRowParams = { ...STORAGE_PARAMS, wallInset: 0.5 }

  it('无走廊时全网格接受，沿长轴成排、类型按产出序号奇偶交替', () => {
    const rows = computeStorageRows(footprint, [], [], [], params)
    // 主轴 x：中心 1.2..22.8 共 10 格；横轴 y：1.2..10.8 共 5 行
    expect(rows.length).toBe(5)
    expect(rows.map((row) => row.kind)).toEqual([
      'shelf',
      'workbench',
      'shelf',
      'workbench',
      'shelf',
    ])
    const first = rows[0]
    expect(first.cells.length).toBe(10)
    expect(first.length).toBeCloseTo(10 * params.cellSize, 12)
    expect(first.center.x).toBeCloseTo(12, 9)
    expect(first.center.y).toBeCloseTo(1.2, 9)
    expect(first.depth).toBe(SHELF_ROW_DEPTH)
    expect(first.height).toBe(SHELF_ROW_HEIGHT)
    expect(rows[1].depth).toBe(WORKBENCH_ROW_DEPTH)
    expect(rows[1].height).toBe(WORKBENCH_ROW_HEIGHT)
    // 排内单元连续共线
    for (let i = 1; i < first.cells.length; i++) {
      expect(first.cells[i].x - first.cells[i - 1].x).toBeCloseTo(params.cellSize, 9)
      expect(first.cells[i].y).toBe(first.cells[i - 1].y)
    }
  })

  it('与走廊中心线距离小于阈值的候选行被剔除（≥ 阈值的行保留）', () => {
    // 走廊沿 y=6 横贯：行 y=3.6 / 8.4 距离 2.4 < 3 剔除；y=1.2 / 10.8 距离 4.8 保留
    const corridor = buildPolyline([
      { x: -100, y: 6 },
      { x: 100, y: 6 },
    ])
    const rows = computeStorageRows(footprint, [corridor], [], [], params)
    expectArrayCloseTo(
      rows.map((row) => row.center.y),
      [1.2, 10.8],
    )
    // 走廊沿 y=3.6：行 y=1.2 / 3.6 / 6 距离 ≤ 2.4 剔除；y=8.4 / 10.8 保留
    const corridor2 = buildPolyline([
      { x: -100, y: 3.6 },
      { x: 100, y: 3.6 },
    ])
    const rows2 = computeStorageRows(footprint, [corridor2], [], [], params)
    expectArrayCloseTo(
      rows2.map((row) => row.center.y),
      [8.4, 10.8],
    )
  })

  it('连续单元不足 minRunCells 的零散候选不成排；charge 节点与卷帘门周围留空', () => {
    // 走廊占据行 y=1.2 的 x≤12.1 区段：x 中心 13.2 距离 1.1 剔除，15.6 距离 3.5 保留
    const corridor = buildPolyline([
      { x: -100, y: 1.2 },
      { x: 12.1, y: 1.2 },
    ])
    const rows = computeStorageRows(footprint, [corridor], [], [], params)
    const row12 = rows.find((row) => Math.abs(row.center.y - 1.2) < 1e-6)
    expectArrayCloseTo(row12?.cells.map((cell) => cell.x) ?? [], [15.6, 18, 20.4, 22.8])

    // charge 节点留空：节点 (12, 6) 阈值 3.2 → 行 y=6 上 x 中心 10.8 / 13.2（距离 1.2）剔除
    const rowsCharge = computeStorageRows(footprint, [], [{ x: 12, y: 6 }], [], params)
    const rowsAt6 = rowsCharge.filter((row) => Math.abs(row.center.y - 6) < 1e-6)
    expect(rowsAt6.length).toBe(2) // 节点两侧各一段成排
    for (const row of rowsAt6) {
      for (const cell of row.cells) {
        expect(Math.hypot(cell.x - 12, cell.y - 6)).toBeGreaterThanOrEqual(
          params.chargeClearance - 1e-9,
        )
      }
    }

    // 卷帘门留空：门中心 (12, 6) 阈值 4.5 → 行 y=6 上门附近候选全部剔除
    const rowsDoor = computeStorageRows(footprint, [], [], [{ x: 12, y: 6 }], params)
    const doorRowsAt6 = rowsDoor.filter((row) => Math.abs(row.center.y - 6) < 1e-6)
    expect(doorRowsAt6.length).toBe(2)
    for (const row of doorRowsAt6) {
      for (const cell of row.cells) {
        expect(Math.hypot(cell.x - 12, cell.y - 6)).toBeGreaterThanOrEqual(
          params.doorClearance - 1e-9,
        )
      }
    }
  })

  it('负坐标区域同样成排（网格索引为负时跑道不被截断——哨兵冲突回归）', () => {
    // footprint 全在负坐标：网格索引全为负；跑道空哨兵若用 -1 会与合法负索引冲突、
    // 导致整条跑道被吞（真实地图包围盒为负坐标，曾因此只在 x≥0 条带成排）
    const negFootprint = computeFactoryFootprint({ minX: -24, minY: -12, maxX: 0, maxY: 0 }, 0)
    const rows = computeStorageRows(negFootprint, [], [], [], params)
    // 主轴 x 中心 -22.8..-1.2 共 10 格；横轴 y 中心 -10.8..-1.2 共 5 行
    expect(rows.length).toBe(5)
    expect(rows[0].cells.length).toBe(10)
    expect(rows[0].center.x).toBeCloseTo(-12, 9)
    expect(rows[0].center.y).toBeCloseTo(-10.8, 9)
    expectArrayCloseTo(
      rows[0].cells.map((cell) => cell.x),
      [-22.8, -20.4, -18, -15.6, -13.2, -10.8, -8.4, -6, -3.6, -1.2],
    )
  })

  it('跨越网格索引 0 的跑道不被截断（正负索引混合）', () => {
    // footprint 横跨 x=0：跑道自负索引连续延伸到正索引
    const spanFootprint = computeFactoryFootprint({ minX: -12, minY: 0, maxX: 12, maxY: 6 }, 0)
    const rows = computeStorageRows(spanFootprint, [], [], [], params)
    // 主轴 x：-11.5/2.4-0.5 → ceil(-5.29) = -5 → -10.8；11.5/2.4-0.5 → floor(4.29) = 4 → 10.8
    // 共 10 格连续；横轴 y：1.2 / 3.6 共 2 行
    expect(rows.length).toBe(2)
    expect(rows[0].cells.length).toBe(10)
    expect(rows[0].center.x).toBeCloseTo(0, 9)
  })
})

describe('interiorGeometry：充电区与装卸区对齐（SPEC §5.3 数据关联元素）', () => {
  const chargeNode = (id: string, x: number, y: number, angle: number | null): NormalizedNode => ({
    id,
    name: id,
    kind: 'charge',
    x,
    y,
    angle,
  })

  it('充电桩 = 节点 + angle 左侧向 × 偏移，朝向面向节点；色块以节点为中心随 angle 旋转', () => {
    const placements = computeChargePlacements(
      [chargeNode('c1', 10, 20, Math.PI)],
      CHARGE_PILE_OFFSET,
      CHARGE_SPOT_LENGTH,
      CHARGE_SPOT_WIDTH,
    )
    expect(placements.length).toBe(1)
    const placement = placements[0]
    expect(placement.nodeId).toBe('c1')
    // angle=π（朝 -x）左侧 = -y 方向
    expect(placement.pile.x).toBeCloseTo(10, 12)
    expect(placement.pile.y).toBeCloseTo(20 - CHARGE_PILE_OFFSET, 12)
    // 朝向面向节点 = angle - π/2
    expect(placement.pileHeading).toBeCloseTo(Math.PI / 2, 12)
    expect(placement.spot.center).toEqual({ x: 10, y: 20 })
    expect(placement.spot.length).toBe(CHARGE_SPOT_LENGTH)
    expect(placement.spot.width).toBe(CHARGE_SPOT_WIDTH)
    expect(placement.spot.angle).toBe(Math.PI)
  })

  it('节点 angle 为空时按 0（地图 +x）处理；非 charge 节点不产生摆放', () => {
    const placements = computeChargePlacements(
      [
        chargeNode('c1', 0, 0, null),
        { id: 'w1', name: 'w1', kind: 'work', x: 5, y: 5, angle: 0 },
      ],
      CHARGE_PILE_OFFSET,
      CHARGE_SPOT_LENGTH,
      CHARGE_SPOT_WIDTH,
    )
    expect(placements.length).toBe(1)
    // angle=0 左侧 = +y
    expect(placements[0].pile.x).toBeCloseTo(0, 12)
    expect(placements[0].pile.y).toBeCloseTo(CHARGE_PILE_OFFSET, 12)
    expect(placements[0].pileHeading).toBeCloseTo(-Math.PI / 2, 12)
    expect(placements[0].spot.angle).toBe(0)
  })

  it('真实 map.json：充电区与 11 个 charge 节点一一对齐（SPEC §4.1 实测计数）', () => {
    const map = loadRealMap()
    const placements = computeChargePlacements(
      map.nodes,
      CHARGE_PILE_OFFSET,
      CHARGE_SPOT_LENGTH,
      CHARGE_SPOT_WIDTH,
    )
    const chargeNodes = map.nodes.filter((node) => node.kind === 'charge')
    expect(chargeNodes.length).toBe(11)
    expect(placements.length).toBe(11)
    const nodeById = new Map(chargeNodes.map((node) => [node.id, node]))
    for (const placement of placements) {
      const node = nodeById.get(placement.nodeId)
      expect(node).toBeDefined()
      // 色块中心严格等于节点坐标
      expect(placement.spot.center).toEqual({ x: node!.x, y: node!.y })
      // 充电桩与节点距离 = 偏移常量
      expect(
        Math.hypot(placement.pile.x - node!.x, placement.pile.y - node!.y),
      ).toBeCloseTo(CHARGE_PILE_OFFSET, 9)
    }
  })

  it('装卸区色块对齐全部 work 节点（真实数据 389 个）', () => {
    const map = loadRealMap()
    const areas = computeLoadingAreas(map.nodes, LOADING_AREA_SIZE)
    expect(areas.length).toBe(389)
    const workNodes = map.nodes.filter((node) => node.kind === 'work')
    for (let i = 0; i < areas.length; i++) {
      expect(areas[i].center).toEqual({ x: workNodes[i].x, y: workNodes[i].y })
      expect(areas[i].length).toBe(LOADING_AREA_SIZE)
    }
  })
})

describe('interiorGeometry：卷帘门与斑马线（SPEC §5.2 / §5.3）', () => {
  it('外墙长边各 2 扇：x 为长轴时落在 minY / maxY 墙上，朝向室内', () => {
    const footprint = computeFactoryFootprint({ minX: 0, minY: 0, maxX: 100, maxY: 40 }, 0)
    const doors = computeRollerDoorPlacements(
      footprint,
      ROLLER_DOOR_FRACTIONS,
      ROLLER_DOOR_WIDTH,
      ROLLER_DOOR_HEIGHT,
    )
    expect(doors.length).toBe(4)
    // 25% / 75% 处
    expect(doors.map((door) => door.center.x)).toEqual([25, 25, 75, 75])
    expect(doors[0].center.y).toBe(0)
    expect(doors[0].heading).toBeCloseTo(Math.PI / 2, 12) // minY 墙朝向 +y（室内）
    expect(doors[1].center.y).toBe(40)
    expect(doors[1].heading).toBeCloseTo(-Math.PI / 2, 12) // maxY 墙朝向 -y（室内）
    expect(doors[0].width).toBe(ROLLER_DOOR_WIDTH)
    expect(doors[0].height).toBe(ROLLER_DOOR_HEIGHT)
  })

  it('y 为长轴时落在 minX / maxX 墙上，朝向室内', () => {
    const footprint = computeFactoryFootprint({ minX: 0, minY: 0, maxX: 40, maxY: 100 }, 0)
    const doors = computeRollerDoorPlacements(footprint, [0.5], ROLLER_DOOR_WIDTH, ROLLER_DOOR_HEIGHT)
    expect(doors.length).toBe(2)
    expect(doors[0].center).toEqual({ x: 0, y: 50 })
    expect(doors[0].heading).toBeCloseTo(0, 12) // minX 墙朝向 +x（室内）
    expect(doors[1].center).toEqual({ x: 40, y: 50 })
    expect(doors[1].heading).toBeCloseTo(Math.PI, 12)
  })

  it('斑马线：每扇门内侧等距横向条带，首条起自 startInset', () => {
    const footprint = computeFactoryFootprint({ minX: 0, minY: 0, maxX: 100, maxY: 40 }, 0)
    const doors = computeRollerDoorPlacements(
      footprint,
      ROLLER_DOOR_FRACTIONS,
      ROLLER_DOOR_WIDTH,
      ROLLER_DOOR_HEIGHT,
    )
    const stripes = computeZebraStripes(
      doors,
      ZEBRA_STRIPE_WIDTH,
      ZEBRA_STRIPE_GAP,
      ZEBRA_STRIPE_COUNT,
      ZEBRA_START_INSET,
    )
    expect(stripes.length).toBe(4 * ZEBRA_STRIPE_COUNT)
    // 第一扇门（minY 墙，heading=+π/2，室内 +y）的首条：中心在门内 0.3+0.35/2 处
    const first = stripes[0]
    expect(first.center.x).toBeCloseTo(25, 12)
    expect(first.center.y).toBeCloseTo(ZEBRA_START_INSET + ZEBRA_STRIPE_WIDTH / 2, 12)
    expect(first.length).toBe(ROLLER_DOOR_WIDTH)
    expect(first.width).toBe(ZEBRA_STRIPE_WIDTH)
    expect(first.angle).toBeCloseTo(Math.PI, 12) // 横向（垂直于进入方向）
    // 第二条推进 条宽+间隔
    expect(stripes[1].center.y).toBeCloseTo(
      ZEBRA_START_INSET + ZEBRA_STRIPE_WIDTH / 2 + ZEBRA_STRIPE_WIDTH + ZEBRA_STRIPE_GAP,
      12,
    )
    // maxY 墙（heading=-π/2）的条带向 -y 推进
    const otherSide = stripes[ZEBRA_STRIPE_COUNT]
    expect(otherSide.center.y).toBeCloseTo(40 - (ZEBRA_START_INSET + ZEBRA_STRIPE_WIDTH / 2), 12)
  })
})

describe('interiorGeometry：computeChandelierPlacements 吊灯阵列（SPEC §5.3 仅发光体）', () => {
  it('footprint 内缩后按灯距整数倍规则布置（与柱位同一确定性口径）', () => {
    const footprint = computeFactoryFootprint({ minX: 0, minY: 0, maxX: 30, maxY: 20 }, 0)
    const placements = computeChandelierPlacements(footprint, 12, 3)
    // x ∈ {12, 24}（≤ 30-3=27），y ∈ {12}（≤ 20-3=17）
    expect(placements).toEqual([
      { x: 12, y: 12 },
      { x: 24, y: 12 },
    ])
  })

  it('全部灯位与外墙保持距离 ≥ 内缩量', () => {
    const map = loadRealMap()
    const footprint = computeFactoryFootprint(map.bounds, FACTORY_MARGIN)
    const placements = computeChandelierPlacements(
      footprint,
      CHANDELIER_SPACING,
      CHANDELIER_EDGE_INSET,
    )
    expect(placements.length).toBeGreaterThan(0)
    for (const placement of placements) {
      expect(placement.x).toBeGreaterThanOrEqual(footprint.minX + CHANDELIER_EDGE_INSET)
      expect(placement.x).toBeLessThanOrEqual(footprint.maxX - CHANDELIER_EDGE_INSET)
      expect(placement.y).toBeGreaterThanOrEqual(footprint.minY + CHANDELIER_EDGE_INSET)
      expect(placement.y).toBeLessThanOrEqual(footprint.maxY - CHANDELIER_EDGE_INSET)
    }
  })
})

describe('interiorGeometry：真实 map.json 货架采样（SPEC §5.3 走廊覆盖不到的空地）', () => {
  it('成排非空，且全部候选点与最近走廊中心线距离 ≥ 阈值、避让 charge 节点与卷帘门', () => {
    const map = loadRealMap()
    const footprint = computeFactoryFootprint(map.bounds, FACTORY_MARGIN)
    const doors = computeRollerDoorPlacements(
      footprint,
      ROLLER_DOOR_FRACTIONS,
      ROLLER_DOOR_WIDTH,
      ROLLER_DOOR_HEIGHT,
    )
    const corridorGeometries = map.corridors.map((corridor) => corridor.geometry)
    const chargePoints = map.nodes
      .filter((node) => node.kind === 'charge')
      .map((node) => ({ x: node.x, y: node.y }))
    const rows = computeStorageRows(
      footprint,
      corridorGeometries,
      chargePoints,
      doors.map((door) => door.center),
      STORAGE_PARAMS,
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((row) => row.kind === 'shelf')).toBe(true)
    expect(rows.some((row) => row.kind === 'workbench')).toBe(true)

    // 走廊包围盒外扩阈值预筛（与实现同一加速口径的独立复算）
    const bboxes = corridorGeometries.map((geometry) => {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const point of geometry.points) {
        minX = Math.min(minX, point.x)
        minY = Math.min(minY, point.y)
        maxX = Math.max(maxX, point.x)
        maxY = Math.max(maxY, point.y)
      }
      const c = STORAGE_PARAMS.corridorClearance
      return { minX: minX - c, minY: minY - c, maxX: maxX + c, maxY: maxY + c }
    })
    let cellCount = 0
    for (const row of rows) {
      expect(row.cells.length).toBeGreaterThanOrEqual(STORAGE_PARAMS.minRunCells)
      expect(row.length).toBeCloseTo(row.cells.length * STORAGE_PARAMS.cellSize, 9)
      for (const cell of row.cells) {
        cellCount++
        for (let i = 0; i < corridorGeometries.length; i++) {
          const bbox = bboxes[i]
          if (
            cell.x < bbox.minX ||
            cell.x > bbox.maxX ||
            cell.y < bbox.minY ||
            cell.y > bbox.maxY
          ) {
            continue
          }
          expect(distanceToPolyline(cell, corridorGeometries[i])).toBeGreaterThanOrEqual(
            STORAGE_PARAMS.corridorClearance,
          )
        }
        for (const charge of chargePoints) {
          expect(Math.hypot(cell.x - charge.x, cell.y - charge.y)).toBeGreaterThanOrEqual(
            STORAGE_PARAMS.chargeClearance,
          )
        }
        for (const door of doors) {
          expect(
            Math.hypot(cell.x - door.center.x, cell.y - door.center.y),
          ).toBeGreaterThanOrEqual(STORAGE_PARAMS.doorClearance)
        }
        // 候选点在 footprint 内缩范围内
        expect(cell.x).toBeGreaterThanOrEqual(footprint.minX + STORAGE_PARAMS.wallInset - 1e-9)
        expect(cell.x).toBeLessThanOrEqual(footprint.maxX - STORAGE_PARAMS.wallInset + 1e-9)
        expect(cell.y).toBeGreaterThanOrEqual(footprint.minY + STORAGE_PARAMS.wallInset - 1e-9)
        expect(cell.y).toBeLessThanOrEqual(footprint.maxY - STORAGE_PARAMS.wallInset + 1e-9)
      }
    }
    // 真实地图空地充足：成排单元总数应远超最小规模（曾因负索引哨兵冲突只剩 x≥0 条带 80 格）
    expect(cellCount).toBeGreaterThan(400)
  })
})

describe('interiorGeometry：buildInteriorGeometry 几何构建（与 calibration 共用同一转换）', () => {
  const bounds: MapBounds = { minX: 0, minY: 0, maxX: 10, maxY: 20 }
  const calibration = { scale: 1, rotationRad: 0, offsetX: 5, offsetY: 10 }
  const syntheticMap: NormalizedMap = {
    calibration,
    bounds,
    floor: 1,
    nodes: [],
    edges: [],
    corridors: [
      {
        id: 'corridor-1',
        nodeA: 'a',
        nodeB: 'b',
        edgeIds: ['e1'],
        geometry: buildPolyline([
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ]),
        bidirectional: true,
        directions: [
          { edgeId: 'e1', from: 'a', to: 'b', alongGeometry: true, isBack: false },
          { edgeId: 'e2', from: 'b', to: 'a', alongGeometry: false, isBack: false },
        ],
      },
    ],
  }

  it('通道两侧边缘线：ribbon 边缘外侧双线、贴地坪低于 ribbon 层高', () => {
    const result = buildInteriorGeometry(syntheticMap, INTERIOR_PARAMS)
    const position = result.groundMarkings.getAttribute('position')
    // 单条双点走廊 → 左右 2 个 quad = 8 顶点；另有 4 门 × 5 条斑马线 = 20 quad = 80 顶点
    expect(position.count).toBe(8 + 4 * ZEBRA_STRIPE_COUNT * 4)
    const inner = RIBBON_WIDTH / 2 + LANE_LINE_GAP
    const outer = inner + LANE_LINE_WIDTH
    // 走廊沿地图 y=0：左侧（+y）线带世界 z = -(y-oy)，oy=10 → z ∈ [10-outer, 10-inner]
    // （float32 存储精度 → 精度 6）
    expect(position.getZ(0)).toBeCloseTo(10 - inner, 6)
    expect(position.getZ(1)).toBeCloseTo(10 - outer, 6)
    // 全部顶点抬升 = MARKING_LIFT（低于 RIBBON_LIFT 0.02，防 z-fighting）
    for (let i = 0; i < position.count; i++) {
      expect(position.getY(i)).toBeCloseTo(MARKING_LIFT, 4)
    }
    result.dispose()
  })

  it('区域色块顶点抬升 AREA_BLOCK_LIFT（高于 ribbon overlay 0.025）', () => {
    const result = buildInteriorGeometry(syntheticMap, INTERIOR_PARAMS)
    // 合成地图无 charge / work 节点 → 空几何
    expect(result.areaBlocks.getAttribute('position').count).toBe(0)
    result.dispose()

    const withNodes: NormalizedMap = {
      ...syntheticMap,
      nodes: [
        { id: 'c1', name: 'c1', kind: 'charge', x: 5, y: 10, angle: 0 },
        { id: 'w1', name: 'w1', kind: 'work', x: 6, y: 10, angle: 0 },
      ],
    }
    const result2 = buildInteriorGeometry(withNodes, INTERIOR_PARAMS)
    const position = result2.areaBlocks.getAttribute('position')
    expect(position.count).toBe(8) // 2 块 × 4 顶点
    for (let i = 0; i < position.count; i++) {
      expect(position.getY(i)).toBeCloseTo(AREA_BLOCK_LIFT, 4)
    }
    // 充电位色块中心 = 节点世界坐标（offset=包围盒中心 → (5,10) 即世界原点；float32 精度）
    const world = mapToWorld({ x: 5, y: 10 }, calibration)
    const cx = (position.getX(0) + position.getX(1) + position.getX(2) + position.getX(3)) / 4
    const cz = (position.getZ(0) + position.getZ(1) + position.getZ(2) + position.getZ(3)) / 4
    expect(cx).toBeCloseTo(world.x, 5)
    expect(cz).toBeCloseTo(world.z, 5)
    result2.dispose()
  })

  it('卷帘门扇板：4 门合并几何（面板 + 横肋，顶点色），实例排矩阵含缩放', () => {
    const result = buildInteriorGeometry(syntheticMap, INTERIOR_PARAMS)
    // 每门：1 面板 + floor((3-0.03)/0.3)=9 横肋 = 10 盒 × 24 顶点
    expect(result.doorPanels.getAttribute('position').count).toBe(4 * 10 * 24)
    expect(result.doorPlacements.length).toBe(4)
    // 无节点 / 有一条走廊 → 货架排存在与否不强制，但实例矩阵与计数一致
    expect(result.shelfMatrices.length).toBe(result.shelfCount * 16)
    expect(result.workbenchMatrices.length).toBe(result.workbenchCount * 16)
    expect(result.chandelierMatrices.length).toBe(result.chandelierCount * 16)
    result.dispose()
  })

  it('真实 map.json 冒烟：分组几何 / 实例计数 / 色块 quad 数 = 11 + 389', () => {
    const map = loadRealMap()
    const result = buildInteriorGeometry(map, INTERIOR_PARAMS)
    expect(result.shelfCount).toBeGreaterThan(0)
    expect(result.workbenchCount).toBeGreaterThan(0)
    expect(result.chargePlacements.length).toBe(11)
    expect(result.doorPlacements.length).toBe(4)
    // 区域色块：充电位 11 + 装卸区 389 = 400 quad
    expect(result.areaBlocks.getAttribute('position').count).toBe(400 * 4)
    expect(result.groundMarkings.getAttribute('position').count).toBeGreaterThan(0)
    // 吊灯实例矩阵世界坐标位于 footprint（包围盒 + margin - 吊灯内缩）内（float32 存储精度）
    expect(result.chandelierCount).toBeGreaterThan(0)
    const footprint = computeFactoryFootprint(map.bounds, FACTORY_MARGIN)
    const world = mapToWorld(
      { x: footprint.minX + CHANDELIER_EDGE_INSET, y: footprint.minY + CHANDELIER_EDGE_INSET },
      map.calibration,
    )
    const world2 = mapToWorld(
      { x: footprint.maxX - CHANDELIER_EDGE_INSET, y: footprint.maxY - CHANDELIER_EDGE_INSET },
      map.calibration,
    )
    const tx = result.chandelierMatrices[12]
    const ty = result.chandelierMatrices[13]
    const tz = result.chandelierMatrices[14]
    expect(tx).toBeGreaterThanOrEqual(Math.min(world.x, world2.x) - 1e-4)
    expect(tx).toBeLessThanOrEqual(Math.max(world.x, world2.x) + 1e-4)
    expect(ty).toBeCloseTo(WALL_HEIGHT - CHANDELIER_DROP, 4)
    expect(tz).toBeGreaterThanOrEqual(Math.min(world.z, world2.z) - 1e-4)
    expect(tz).toBeLessThanOrEqual(Math.max(world.z, world2.z) + 1e-4)
    result.dispose()
  })
})

describe('interiorGeometry：glTF 程序化占位体（SPEC §5.4 / §10 降级路径）', () => {
  it('充电桩占位体：+Z 正面、原点在底部中心、尺寸与 glTF 一致', () => {
    const group = buildChargingPilePlaceholder(
      { width: CHARGING_PILE_WIDTH, height: CHARGING_PILE_HEIGHT, depth: CHARGING_PILE_DEPTH },
      { body: interiorColors.chargingPile, screen: interiorColors.chargingPileScreen },
    )
    expect(group.children.length).toBe(2) // 机身 + 屏幕
    const bbox = new Box3().setFromObject(group)
    const center = bbox.getCenter(new Vector3())
    // float32 几何存储精度 → 1e-5 容差
    expect(Math.abs(bbox.min.y)).toBeLessThan(1e-5) // 原点底部
    expect(Math.abs(center.x)).toBeLessThan(1e-5)
    // 屏幕凸出正面（+Z），水平中心仍居中
    expect(Math.abs(center.z)).toBeLessThan(0.02)
    expect(bbox.max.y).toBeCloseTo(CHARGING_PILE_HEIGHT, 5)
  })

  it('卷帘门门框占位体：门洞净宽 × 净高与常量一致，原点在底部中心', () => {
    const group = buildRollerDoorFramePlaceholder(
      {
        width: ROLLER_DOOR_WIDTH,
        height: ROLLER_DOOR_HEIGHT,
        postSize: ROLLER_DOOR_POST_SIZE,
        beamHeight: ROLLER_DOOR_BEAM_HEIGHT,
        frameDepth: ROLLER_DOOR_FRAME_DEPTH,
      },
      interiorColors.doorFrame,
    )
    expect(group.children.length).toBe(3) // 左右立柱 + 横梁
    const bbox = new Box3().setFromObject(group)
    const center = bbox.getCenter(new Vector3())
    const size = bbox.getSize(new Vector3())
    // float32 几何存储精度 → 1e-5 容差
    expect(Math.abs(bbox.min.y)).toBeLessThan(1e-5)
    expect(Math.abs(center.x)).toBeLessThan(1e-5)
    expect(Math.abs(center.z)).toBeLessThan(1e-5)
    expect(size.x).toBeCloseTo(ROLLER_DOOR_WIDTH + ROLLER_DOOR_POST_SIZE * 2, 5)
    expect(size.y).toBeCloseTo(ROLLER_DOOR_HEIGHT + ROLLER_DOOR_BEAM_HEIGHT, 5)
  })
})
