/**
 * 内部元素与地面标线几何（SPEC §5.3 / §5.4）。
 *
 * - 货架与工作台：按网格采样 footprint 内的"空地"（候选点与最近走廊中心线距离 >
 *   阈值才接受，另避让卷帘门与 charge 节点），同行连续候选成排输出低多边形方盒排
 *   （奇偶行交替 货架 / 工作台），各一个 InstancedMesh；
 * - 充电区（数据关联元素，非纯装饰）：与 charge 节点严格对齐——充电桩位置 =
 *   节点 + angle 左侧向 × 偏移、朝向面向充电位，地面充电位色块以节点为中心、
 *   随节点 angle 旋转；装卸区色块同理对齐 work 节点；
 * - 地面标线：通道两侧边缘线（随走廊 ribbon 数据生成的外侧贴地细条）、卷帘门内侧
 *   斑马线、区域色块（充电区 / 装卸区）；贴地坪的标线与 ribbon 的 2cm 层高错开
 *   （MARKING_LIFT < RIBBON_LIFT < AREA_BLOCK_LIFT），材质侧再配 polygonOffset；
 * - 吊灯阵列：规则网格发光灯盘（仅发光体，不逐个投影、不产生灯光），单个 InstancedMesh；
 * - 卷帘门：外墙长边各 2 扇、固定关闭——门框为 glTF 点缀资产（本模块输出摆放
 *   placements 与程序化占位体构建器），门扇板（含横肋）为程序化合并几何。
 *
 * 放置采样与布局全部为纯函数（常量以参数传入，可单测）；几何顶点一律经
 * domain/coordinates.ts 的 mapToWorld / headingToWorldYaw 转换（z 取反唯一收口）。
 * rendering 层可 import three 与 config，禁止 import infrastructure（SPEC §12）。
 */

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three'
import type { ColorRepresentation, Object3D } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import { headingToWorldYaw, mapToWorld } from '../../../domain/coordinates'
import { distanceToPolyline } from '../../../domain/polyline'
import type {
  Calibration,
  MapPoint,
  NormalizedMap,
  NormalizedNode,
  Polyline,
} from '../../../domain/types'
import { computeFactoryFootprint } from './shellGeometry'
import type { FactoryFootprint } from './shellGeometry'

// ---------------------------------------------------------------------------
// 纯函数：货架 / 工作台放置采样（SPEC §5.3 网格采样 + 距离阈值 + 成排布置）
// ---------------------------------------------------------------------------

/** 货架 / 工作台采样参数（值取自 config/constants.ts，由场景层注入） */
export interface StorageRowParams {
  /** 采样网格单元边长（候选点 = 单元中心，对齐单元边长整数倍） */
  cellSize: number
  /** 相对外墙的内缩 */
  wallInset: number
  /** 与最近走廊中心线的最小距离（放置阈值） */
  corridorClearance: number
  /** 与卷帘门中心的最小间距 */
  doorClearance: number
  /** 与 charge 节点的最小间距 */
  chargeClearance: number
  /** 成排最短连续单元数 */
  minRunCells: number
  /** 货架排深 / 高 */
  shelfDepth: number
  shelfHeight: number
  /** 工作台排深 / 高 */
  workbenchDepth: number
  workbenchHeight: number
}

/** 一排毒架 / 工作台（低多边形方盒：底面贴地、沿 footprint 长轴成排） */
export interface StorageRow {
  kind: 'shelf' | 'workbench'
  /** 排中心（地图平面坐标） */
  center: MapPoint
  /** 排长度（沿 footprint 长轴）/ 深 / 高 */
  length: number
  depth: number
  height: number
  /** 成排的连续采样单元中心（全部通过放置判定：与走廊距离 > 阈值等） */
  cells: MapPoint[]
}

/** 走廊包围盒（外扩阈值后的快速预筛框） */
interface ExpandedBBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function computeExpandedBBox(geometry: Polyline, clearance: number): ExpandedBBox {
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
  return {
    minX: minX - clearance,
    minY: minY - clearance,
    maxX: maxX + clearance,
    maxY: maxY + clearance,
  }
}

/** 候选点放置判定：与 charge 节点 / 卷帘门 / 最近走廊中心线的距离全部大于各自阈值 */
function isOpenCell(
  point: MapPoint,
  corridorGeometries: Polyline[],
  corridorBBoxes: ExpandedBBox[],
  chargePoints: MapPoint[],
  doorCenters: MapPoint[],
  params: StorageRowParams,
): boolean {
  for (const charge of chargePoints) {
    if (Math.hypot(point.x - charge.x, point.y - charge.y) < params.chargeClearance) {
      return false
    }
  }
  for (const door of doorCenters) {
    if (Math.hypot(point.x - door.x, point.y - door.y) < params.doorClearance) {
      return false
    }
  }
  for (let i = 0; i < corridorGeometries.length; i++) {
    const bbox = corridorBBoxes[i]
    // 点在外扩包围盒之外 → 与该走廊的距离必大于阈值，跳过精确距离计算
    if (point.x < bbox.minX || point.x > bbox.maxX || point.y < bbox.minY || point.y > bbox.maxY) {
      continue
    }
    if (distanceToPolyline(point, corridorGeometries[i]) < params.corridorClearance) {
      return false
    }
  }
  return true
}

/**
 * 货架 / 工作台放置采样：footprint 内缩 wallInset 后按 cellSize 网格取候选点
 * （单元中心，对齐 cellSize 整数倍，结果确定）；接受的候选点沿 footprint 长轴
 * 按连续网格索引成排，连续单元数 ≥ minRunCells 才输出一排；排类型按产出序号
 * 奇偶交替（货架 / 工作台）。
 */
export function computeStorageRows(
  footprint: FactoryFootprint,
  corridorGeometries: Polyline[],
  chargePoints: MapPoint[],
  doorCenters: MapPoint[],
  params: StorageRowParams,
): StorageRow[] {
  const corridorBBoxes = corridorGeometries.map((geometry) =>
    computeExpandedBBox(geometry, params.corridorClearance),
  )
  const alongX = footprint.width >= footprint.depth
  const minMain = alongX ? footprint.minX : footprint.minY
  const maxMain = alongX ? footprint.maxX : footprint.maxY
  const minCross = alongX ? footprint.minY : footprint.minX
  const maxCross = alongX ? footprint.maxY : footprint.maxX

  const { cellSize, wallInset } = params
  const rows: StorageRow[] = []
  // 候选点坐标 = (网格索引 + 0.5) × cellSize；主 / 横轴索引范围由 inset 夹取
  const mainStart = Math.ceil((minMain + wallInset) / cellSize - 0.5)
  const mainEnd = Math.floor((maxMain - wallInset) / cellSize - 0.5)
  const crossStart = Math.ceil((minCross + wallInset) / cellSize - 0.5)
  const crossEnd = Math.floor((maxCross - wallInset) / cellSize - 0.5)

  for (let crossIndex = crossStart; crossIndex <= crossEnd; crossIndex++) {
    const cross = (crossIndex + 0.5) * cellSize
    // 沿主轴收集该行接受的候选点（布尔跑道）；网格索引可为负（地图包围盒含负坐标），
    // 跑道起点用 null 作空哨兵，不得用 -1（与合法负索引冲突）
    let runStart: number | null = null
    const flushRun = (runEnd: number) => {
      if (runStart === null) {
        return
      }
      const runLength = runEnd - runStart + 1
      if (runLength >= params.minRunCells) {
        const cells: MapPoint[] = []
        for (let i = runStart; i <= runEnd; i++) {
          const main = (i + 0.5) * cellSize
          cells.push(alongX ? { x: main, y: cross } : { x: cross, y: main })
        }
        const kind = rows.length % 2 === 0 ? 'shelf' : 'workbench'
        const mainMid =
          ((runStart + 0.5) * cellSize + (runEnd + 0.5) * cellSize) / 2
        rows.push({
          kind,
          center: alongX ? { x: mainMid, y: cross } : { x: cross, y: mainMid },
          length: runLength * cellSize,
          depth: kind === 'shelf' ? params.shelfDepth : params.workbenchDepth,
          height: kind === 'shelf' ? params.shelfHeight : params.workbenchHeight,
          cells,
        })
      }
      runStart = null
    }
    for (let mainIndex = mainStart; mainIndex <= mainEnd; mainIndex++) {
      const main = (mainIndex + 0.5) * cellSize
      const point: MapPoint = alongX ? { x: main, y: cross } : { x: cross, y: main }
      if (
        isOpenCell(point, corridorGeometries, corridorBBoxes, chargePoints, doorCenters, params)
      ) {
        if (runStart === null) {
          runStart = mainIndex
        }
      } else if (runStart !== null) {
        flushRun(mainIndex - 1)
      }
    }
    if (runStart !== null) {
      flushRun(mainEnd)
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// 纯函数：充电区与装卸区（数据关联元素，与节点坐标严格对齐）
// ---------------------------------------------------------------------------

/** 地图平面有向矩形（区域色块 / 斑马线条带共用） */
export interface OrientedRect {
  center: MapPoint
  /** 沿 angle 方向的尺寸 × 垂直方向尺寸 */
  length: number
  width: number
  /** 地图平面朝向（弧度，0 = 地图 +x，逆时针为正；与节点 angle 同口径） */
  angle: number
}

/** 充电桩摆放（与 charge 节点对齐；位置 / 朝向均为地图平面口径） */
export interface ChargePlacement {
  /** 关联的 charge 节点 id */
  nodeId: string
  /** 充电桩位置：节点 + angle 左侧向 × pileOffset */
  pile: MapPoint
  /** 充电桩朝向（地图弧度）：面向充电位（+Z 正面资产经 headingToWorldYaw 换算） */
  pileHeading: number
  /** 地面充电位色块：以节点为中心、随节点 angle 旋转 */
  spot: OrientedRect
}

/**
 * 充电区摆放（SPEC §5.3）：每个 charge 节点旁生成充电桩位置 + 地面充电位色块。
 * 充电桩置于节点 angle 朝向的左侧（angle + π/2 方向）pileOffset 处，正面面向节点；
 * 节点 angle 为空时按 0（地图 +x）处理。
 */
export function computeChargePlacements(
  nodes: NormalizedNode[],
  pileOffset: number,
  spotLength: number,
  spotWidth: number,
): ChargePlacement[] {
  const placements: ChargePlacement[] = []
  for (const node of nodes) {
    if (node.kind !== 'charge') {
      continue
    }
    const angle = node.angle ?? 0
    const left = angle + Math.PI / 2
    placements.push({
      nodeId: node.id,
      pile: {
        x: node.x + Math.cos(left) * pileOffset,
        y: node.y + Math.sin(left) * pileOffset,
      },
      pileHeading: angle - Math.PI / 2,
      spot: {
        center: { x: node.x, y: node.y },
        length: spotLength,
        width: spotWidth,
        angle,
      },
    })
  }
  return placements
}

/** 装卸区色块（SPEC §5.3 区域色块）：对齐每个 work 节点，随节点 angle 旋转 */
export function computeLoadingAreas(nodes: NormalizedNode[], size: number): OrientedRect[] {
  const areas: OrientedRect[] = []
  for (const node of nodes) {
    if (node.kind !== 'work') {
      continue
    }
    areas.push({
      center: { x: node.x, y: node.y },
      length: size,
      width: size,
      angle: node.angle ?? 0,
    })
  }
  return areas
}

// ---------------------------------------------------------------------------
// 纯函数：卷帘门（外墙长边各 2 扇、固定关闭）与门内斑马线
// ---------------------------------------------------------------------------

/** 卷帘门摆放（门框 glTF 与门扇板共用） */
export interface RollerDoorPlacement {
  /** 门中心（地图平面，在 footprint 墙线上） */
  center: MapPoint
  /** 朝向室内（地图弧度；+Z 正面资产经 headingToWorldYaw 换算后面向室内） */
  heading: number
  /** 门洞净宽 / 净高 */
  width: number
  height: number
}

/**
 * 卷帘门摆放（SPEC §5.2）：外墙两条长边各 fractions.length 扇，沿侧长按比例布置；
 * 朝向为墙的内法向（固定关闭的装饰性门，门面贴墙线内侧）。
 */
export function computeRollerDoorPlacements(
  footprint: FactoryFootprint,
  fractions: readonly number[],
  width: number,
  height: number,
): RollerDoorPlacement[] {
  const alongX = footprint.width >= footprint.depth
  const doors: RollerDoorPlacement[] = []
  for (const fraction of fractions) {
    if (alongX) {
      const x = footprint.minX + footprint.width * fraction
      doors.push(
        { center: { x, y: footprint.minY }, heading: Math.PI / 2, width, height },
        { center: { x, y: footprint.maxY }, heading: -Math.PI / 2, width, height },
      )
    } else {
      const y = footprint.minY + footprint.depth * fraction
      doors.push(
        { center: { x: footprint.minX, y }, heading: 0, width, height },
        { center: { x: footprint.maxX, y }, heading: Math.PI, width, height },
      )
    }
  }
  return doors
}

/**
 * 卷帘门内侧斑马线（SPEC §5.3）：每扇门内沿进入方向等距排布的横向条带，
 * 条长同门洞净宽，自首条内缩量起按 条宽 + 间隔 推进。
 */
export function computeZebraStripes(
  doors: RollerDoorPlacement[],
  stripeWidth: number,
  stripeGap: number,
  stripeCount: number,
  startInset: number,
): OrientedRect[] {
  const stripes: OrientedRect[] = []
  for (const door of doors) {
    const inward = { x: Math.cos(door.heading), y: Math.sin(door.heading) }
    for (let i = 0; i < stripeCount; i++) {
      const offset = startInset + i * (stripeWidth + stripeGap) + stripeWidth / 2
      stripes.push({
        center: {
          x: door.center.x + inward.x * offset,
          y: door.center.y + inward.y * offset,
        },
        length: door.width,
        width: stripeWidth,
        angle: door.heading + Math.PI / 2,
      })
    }
  }
  return stripes
}

// ---------------------------------------------------------------------------
// 纯函数：吊灯阵列（SPEC §5.3 仅发光体）
// ---------------------------------------------------------------------------

/**
 * 吊灯阵列：footprint 内缩 edgeInset 后按 spacing 规则网格布置
 * （对齐 spacing 整数倍，与柱位同一确定性口径）；吊灯位于屋檐下，无需避让走廊。
 */
export function computeChandelierPlacements(
  footprint: FactoryFootprint,
  spacing: number,
  edgeInset: number,
): MapPoint[] {
  const placements: MapPoint[] = []
  for (
    let ix = Math.ceil((footprint.minX + edgeInset) / spacing);
    ix * spacing <= footprint.maxX - edgeInset;
    ix++
  ) {
    for (
      let iy = Math.ceil((footprint.minY + edgeInset) / spacing);
      iy * spacing <= footprint.maxY - edgeInset;
      iy++
    ) {
      const x = ix * spacing
      const y = iy * spacing
      placements.push({ x: x === 0 ? 0 : x, y: y === 0 ? 0 : y })
    }
  }
  return placements
}

// ---------------------------------------------------------------------------
// 几何构建参数与结果
// ---------------------------------------------------------------------------

export interface InteriorGeometryParams {
  /** 建筑包围盒外扩边距（config FACTORY_MARGIN，与外壳同口径） */
  margin: number
  /** 走廊 ribbon 宽度（config RIBBON_WIDTH；边缘线自 ribbon 边缘外扩） */
  ribbonWidth: number
  /** 外墙高度（config WALL_HEIGHT；吊灯自屋檐下垂） */
  wallHeight: number
  storage: StorageRowParams
  /** 充电桩侧向偏移 / 充电位色块长宽（config CHARGE_*） */
  chargePileOffset: number
  chargeSpotLength: number
  chargeSpotWidth: number
  /** 装卸区色块尺寸（config LOADING_AREA_SIZE） */
  loadingAreaSize: number
  /** 卷帘门：布置比例 / 门洞净宽净高 / 内缩 / 扇板厚度 / 横肋间距与高度（config ROLLER_DOOR_*） */
  doorFractions: readonly number[]
  doorWidth: number
  doorHeight: number
  doorInset: number
  doorPanelThickness: number
  doorRibSpacing: number
  doorRibHeight: number
  /** 斑马线：条宽 / 间隔 / 条数 / 首条内缩（config ZEBRA_*） */
  zebraStripeWidth: number
  zebraStripeGap: number
  zebraStripeCount: number
  zebraStartInset: number
  /** 吊灯：灯距 / 内缩 / 下垂距离 / 灯盘半径 / 厚度（config CHANDELIER_*） */
  chandelierSpacing: number
  chandelierEdgeInset: number
  chandelierDrop: number
  chandelierRadius: number
  chandelierThickness: number
  /** 通道边缘线：外扩间隙 / 线宽（config LANE_LINE_*） */
  laneLineGap: number
  laneLineWidth: number
  /** 贴地坪标线抬升（低于 ribbon，config MARKING_LIFT） */
  markingLift: number
  /** 区域色块抬升（高于 ribbon overlay，config AREA_BLOCK_LIFT） */
  areaBlockLift: number
  colors: {
    laneLine: ColorRepresentation
    zebra: ColorRepresentation
    chargeArea: ColorRepresentation
    loadingArea: ColorRepresentation
    doorPanel: ColorRepresentation
    doorRib: ColorRepresentation
  }
}

/** 内部元素与地面标线的全部分组几何与摆放数据 */
export interface InteriorGeometryResult {
  /** 货架 / 工作台排（采样结果，实例矩阵的行来源） */
  storageRows: StorageRow[]
  /** 货架 / 工作台共用的单位方盒本地几何（底面贴 y=0，实例矩阵含缩放） */
  storageBoxGeometry: BufferGeometry
  shelfMatrices: Float32Array
  shelfCount: number
  workbenchMatrices: Float32Array
  workbenchCount: number
  /** 吊灯本地几何（灯盘，中心为原点）与实例矩阵 */
  chandelierGeometry: BufferGeometry
  chandelierMatrices: Float32Array
  chandelierCount: number
  /** 充电区摆放（glTF 克隆 / 占位体的世界变换来源） */
  chargePlacements: ChargePlacement[]
  /** 卷帘门摆放（门框 glTF 克隆 / 占位体的世界变换来源） */
  doorPlacements: RollerDoorPlacement[]
  /** 固定关闭卷帘门扇板（含横肋，顶点色），单个合并几何 */
  doorPanels: BufferGeometry
  /** 地面标线：通道两侧边缘线 + 斑马线（顶点色），单个合并几何 */
  groundMarkings: BufferGeometry
  /** 区域色块：充电位 + 装卸区（顶点色，半透明），单个合并几何 */
  areaBlocks: BufferGeometry
  /** 释放全部几何（实例矩阵为 CPU 侧 typed array，随 GC 回收） */
  dispose: () => void
}

/**
 * 一次性构建内部元素与地面标线全部几何（内部元素为百级实例 + 若干合并几何，
 * 无需分帧；货架采样经走廊包围盒预筛，真实地图全量采样为百毫秒级一次性开销）。
 */
export function buildInteriorGeometry(
  map: NormalizedMap,
  params: InteriorGeometryParams,
): InteriorGeometryResult {
  const { calibration } = map
  const footprint = computeFactoryFootprint(map.bounds, params.margin)
  const doorPlacements = computeRollerDoorPlacements(
    footprint,
    params.doorFractions,
    params.doorWidth,
    params.doorHeight,
  )
  const corridorGeometries = map.corridors.map((corridor) => corridor.geometry)
  const chargePoints = map.nodes
    .filter((node) => node.kind === 'charge')
    .map((node) => ({ x: node.x, y: node.y }))
  const storageRows = computeStorageRows(
    footprint,
    corridorGeometries,
    chargePoints,
    doorPlacements.map((door) => door.center),
    params.storage,
  )
  const chargePlacements = computeChargePlacements(
    map.nodes,
    params.chargePileOffset,
    params.chargeSpotLength,
    params.chargeSpotWidth,
  )
  const loadingAreas = computeLoadingAreas(map.nodes, params.loadingAreaSize)
  const chandelierPlacements = computeChandelierPlacements(
    footprint,
    params.chandelierSpacing,
    params.chandelierEdgeInset,
  )

  const alongX = footprint.width >= footprint.depth
  const shelfRows = storageRows.filter((row) => row.kind === 'shelf')
  const workbenchRows = storageRows.filter((row) => row.kind === 'workbench')
  const storageBoxGeometry = buildUnitBoxGeometry()
  const shelfMatrices = buildRowInstanceMatrices(shelfRows, alongX, calibration)
  const workbenchMatrices = buildRowInstanceMatrices(workbenchRows, alongX, calibration)

  const chandelierGeometry = buildChandelierGeometry(
    params.chandelierRadius,
    params.chandelierThickness,
  )
  const chandelierMatrices = buildChandelierInstanceMatrices(
    chandelierPlacements,
    params.wallHeight - params.chandelierDrop,
    calibration,
  )

  const doorPanels = buildDoorPanelGeometry(doorPlacements, params, calibration)
  const groundMarkings = buildGroundMarkingGeometry(
    corridorGeometries,
    computeZebraStripes(
      doorPlacements,
      params.zebraStripeWidth,
      params.zebraStripeGap,
      params.zebraStripeCount,
      params.zebraStartInset,
    ),
    params,
    calibration,
  )
  const areaBlocks = buildAreaBlockGeometry(
    chargePlacements.map((placement) => placement.spot),
    loadingAreas,
    params,
    calibration,
  )

  return {
    storageRows,
    storageBoxGeometry,
    shelfMatrices,
    shelfCount: shelfRows.length,
    workbenchMatrices,
    workbenchCount: workbenchRows.length,
    chandelierGeometry,
    chandelierMatrices,
    chandelierCount: chandelierPlacements.length,
    chargePlacements,
    doorPlacements,
    doorPanels,
    groundMarkings,
    areaBlocks,
    dispose() {
      storageBoxGeometry.dispose()
      chandelierGeometry.dispose()
      doorPanels.dispose()
      groundMarkings.dispose()
      areaBlocks.dispose()
    },
  }
}

// ---------------------------------------------------------------------------
// 实例几何与矩阵（排 / 吊灯）
// ---------------------------------------------------------------------------

/** 单位方盒（1×1×1，底面贴 y=0）：货架 / 工作台排经实例矩阵缩放为 长 × 高 × 深 */
function buildUnitBoxGeometry(): BufferGeometry {
  const geometry = new BoxGeometry(1, 1, 1)
  geometry.translate(0, 0.5, 0)
  return geometry
}

/**
 * 排实例矩阵：位置经 mapToWorld；排沿 footprint 长轴成排，本地方盒 x 轴为长度方向——
 * 长轴为地图 x 时 rotation.y = calibration.rotationRad（与柱位同一推导），
 * 长轴为地图 y 时附加 π/2（地图 +y 对应世界 -z）。
 */
function buildRowInstanceMatrices(
  rows: StorageRow[],
  alongX: boolean,
  calibration: Calibration,
): Float32Array {
  const matrices = new Float32Array(rows.length * 16)
  const position = new Vector3()
  const scale = new Vector3()
  const quaternion = new Quaternion().setFromEuler(
    new Euler(0, calibration.rotationRad + (alongX ? 0 : Math.PI / 2), 0),
  )
  const matrix = new Matrix4()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const world = mapToWorld(row.center, calibration)
    position.set(world.x, 0, world.z)
    scale.set(row.length, row.height, row.depth)
    matrix.compose(position, quaternion, scale)
    matrices.set(matrix.elements, i * 16)
  }
  return matrices
}

/** 吊灯盘本地几何：扁圆柱（中心为原点，实例矩阵直接给定盘心世界坐标） */
function buildChandelierGeometry(radius: number, thickness: number): BufferGeometry {
  return new CylinderGeometry(radius, radius, thickness, 16)
}

/** 吊灯实例矩阵：位置经 mapToWorld，盘心高度 = 檐口高度 - 下垂距离 */
function buildChandelierInstanceMatrices(
  placements: MapPoint[],
  height: number,
  calibration: Calibration,
): Float32Array {
  const matrices = new Float32Array(placements.length * 16)
  const position = new Vector3()
  const scale = new Vector3(1, 1, 1)
  const quaternion = new Quaternion()
  const matrix = new Matrix4()
  for (let i = 0; i < placements.length; i++) {
    const world = mapToWorld(placements[i], calibration)
    position.set(world.x, height, world.z)
    matrix.compose(position, quaternion, scale)
    matrices.set(matrix.elements, i * 16)
  }
  return matrices
}

// ---------------------------------------------------------------------------
// 卷帘门扇板（固定关闭，含横肋；顶点色分色，合并为单个几何）
// ---------------------------------------------------------------------------

function buildDoorPanelGeometry(
  doors: RollerDoorPlacement[],
  params: InteriorGeometryParams,
  calibration: Calibration,
): BufferGeometry {
  const parts: BufferGeometry[] = []
  const position = new Vector3()
  const scale = new Vector3(1, 1, 1)
  const quaternion = new Quaternion()
  const euler = new Euler()
  const matrix = new Matrix4()
  for (const door of doors) {
    // 门面中心：墙线向内 inset（门框背面不贴墙，防 z-fighting）
    const inset = params.doorInset
    const centerMap: MapPoint = {
      x: door.center.x + Math.cos(door.heading) * inset,
      y: door.center.y + Math.sin(door.heading) * inset,
    }
    const world = mapToWorld(centerMap, calibration)
    position.set(world.x, 0, world.z)
    euler.set(0, headingToWorldYaw(door.heading, calibration), 0)
    quaternion.setFromEuler(euler)
    matrix.compose(position, quaternion, scale)

    // 扇板：略窄于门洞净宽（留缝），底面贴地；横肋沿高度等距、略凸出面板（卷帘横档示意）
    const doorParts: BufferGeometry[] = []
    const panelWidth = door.width - 0.04
    const panel = new BoxGeometry(panelWidth, door.height, params.doorPanelThickness)
    panel.translate(0, door.height / 2, 0)
    doorParts.push(withVertexColor(panel, params.colors.doorPanel))
    const ribDepth = params.doorPanelThickness + 0.02
    for (
      let y = params.doorRibSpacing;
      y + params.doorRibHeight / 2 <= door.height;
      y += params.doorRibSpacing
    ) {
      const rib = new BoxGeometry(panelWidth, params.doorRibHeight, ribDepth)
      rib.translate(0, y, 0)
      doorParts.push(withVertexColor(rib, params.colors.doorRib))
    }
    for (const part of doorParts) {
      part.applyMatrix4(matrix)
      parts.push(part)
    }
  }
  if (parts.length === 0) {
    return new BufferGeometry()
  }
  const merged = mergeGeometries(parts, false)
  for (const part of parts) {
    part.dispose()
  }
  return merged ?? new BufferGeometry()
}

/** 为几何填充单一顶点色（合并几何走顶点色管线，单材质多色） */
function withVertexColor(geometry: BufferGeometry, color: ColorRepresentation): BufferGeometry {
  const count = geometry.getAttribute('position').count
  const colors = new Float32Array(count * 3)
  const parsed = parseColor(color)
  for (let i = 0; i < count; i++) {
    colors[i * 3] = parsed.r
    colors[i * 3 + 1] = parsed.g
    colors[i * 3 + 2] = parsed.b
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
  return geometry
}

const colorScratch = new Color()

/** 复用 three 的颜色解析（支持 #hex / 颜色名 / 数值），避免重复分配 */
function parseColor(color: ColorRepresentation): { r: number; g: number; b: number } {
  const c = colorScratch.set(color)
  return { r: c.r, g: c.g, b: c.b }
}

// ---------------------------------------------------------------------------
// 地面标线（通道两侧边缘线 + 斑马线）与区域色块（充电位 / 装卸区）
// ---------------------------------------------------------------------------

/** 线段退化判定阈值（米） */
const SEGMENT_EPSILON = 1e-9

function buildGroundMarkingGeometry(
  corridorGeometries: Polyline[],
  zebraStripes: OrientedRect[],
  params: InteriorGeometryParams,
  calibration: Calibration,
): BufferGeometry {
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const lane = parseColor(params.colors.laneLine)
  const halfRibbon = params.ribbonWidth / 2
  const inner = halfRibbon + params.laneLineGap
  const outer = inner + params.laneLineWidth

  // 通道两侧边缘线：沿走廊中心线两侧、ribbon 边缘外侧的贴地细条（随 ribbon 数据生成）
  for (const geometry of corridorGeometries) {
    const points = geometry.points
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]
      const b = points[i + 1]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const length = Math.hypot(dx, dy)
      if (length < SEGMENT_EPSILON) {
        continue
      }
      // 段左侧单位法向（与 ribbonGeometry 同一口径）
      const nx = -dy / length
      const ny = dx / length
      // 左侧条带 [inner, outer]、右侧镜像；角点按地图平面 CCW 排列（反射后法线 +Y）
      pushQuad(
        positions,
        colors,
        indices,
        [
          { x: a.x + nx * inner, y: a.y + ny * inner },
          { x: a.x + nx * outer, y: a.y + ny * outer },
          { x: b.x + nx * outer, y: b.y + ny * outer },
          { x: b.x + nx * inner, y: b.y + ny * inner },
        ],
        params.markingLift,
        lane,
        calibration,
      )
      pushQuad(
        positions,
        colors,
        indices,
        [
          { x: a.x - nx * outer, y: a.y - ny * outer },
          { x: a.x - nx * inner, y: a.y - ny * inner },
          { x: b.x - nx * inner, y: b.y - ny * inner },
          { x: b.x - nx * outer, y: b.y - ny * outer },
        ],
        params.markingLift,
        lane,
        calibration,
      )
    }
  }

  // 卷帘门内侧斑马线
  const zebra = parseColor(params.colors.zebra)
  for (const stripe of zebraStripes) {
    pushOrientedRect(positions, colors, indices, stripe, params.markingLift, zebra, calibration)
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  return geometry
}

function buildAreaBlockGeometry(
  chargeSpots: OrientedRect[],
  loadingAreas: OrientedRect[],
  params: InteriorGeometryParams,
  calibration: Calibration,
): BufferGeometry {
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const charge = parseColor(params.colors.chargeArea)
  const loading = parseColor(params.colors.loadingArea)
  for (const spot of chargeSpots) {
    pushOrientedRect(positions, colors, indices, spot, params.areaBlockLift, charge, calibration)
  }
  for (const area of loadingAreas) {
    pushOrientedRect(positions, colors, indices, area, params.areaBlockLift, loading, calibration)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  return geometry
}

/** 有向矩形 → y=lift 水平面 quad（角点按地图平面 CCW，反射后法线 +Y） */
function pushOrientedRect(
  positions: number[],
  colors: number[],
  indices: number[],
  rect: OrientedRect,
  y: number,
  color: { r: number; g: number; b: number },
  calibration: Calibration,
): void {
  const dirX = Math.cos(rect.angle)
  const dirY = Math.sin(rect.angle)
  const sideX = -dirY
  const sideY = dirX
  const halfLength = rect.length / 2
  const halfWidth = rect.width / 2
  const { center } = rect
  pushQuad(
    positions,
    colors,
    indices,
    [
      {
        x: center.x - dirX * halfLength - sideX * halfWidth,
        y: center.y - dirY * halfLength - sideY * halfWidth,
      },
      {
        x: center.x - dirX * halfLength + sideX * halfWidth,
        y: center.y - dirY * halfLength + sideY * halfWidth,
      },
      {
        x: center.x + dirX * halfLength + sideX * halfWidth,
        y: center.y + dirY * halfLength + sideY * halfWidth,
      },
      {
        x: center.x + dirX * halfLength - sideX * halfWidth,
        y: center.y + dirY * halfLength - sideY * halfWidth,
      },
    ],
    y,
    color,
    calibration,
  )
}

/**
 * 向数组追加一个水平面 quad（4 顶点 2 三角形）。
 * 角点须按地图平面 CCW 排列（与 shellGeometry.pushHorizontalQuad 同一绕序推导，
 * 经 y→-z 反射后法线 +Y）。
 */
function pushQuad(
  positions: number[],
  colors: number[],
  indices: number[],
  corners: [MapPoint, MapPoint, MapPoint, MapPoint],
  y: number,
  color: { r: number; g: number; b: number },
  calibration: Calibration,
): void {
  const offset = positions.length / 3
  for (const corner of corners) {
    const world = mapToWorld(corner, calibration)
    positions.push(world.x, y, world.z)
    colors.push(color.r, color.g, color.b)
  }
  indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3)
}

// ---------------------------------------------------------------------------
// glTF 程序化占位体（SPEC §5.4 / §10 降级路径；由 assetLoader 在加载失败时调用）
// ---------------------------------------------------------------------------

/** 充电桩占位体尺寸（与 public/assets/charging-pile.gltf 一致，值取自 config） */
export interface ChargingPilePlaceholderDims {
  width: number
  height: number
  depth: number
}

/** 卷帘门门框占位体尺寸（与 roller-door-frame.gltf 一致，值取自 config） */
export interface DoorFramePlaceholderDims {
  /** 门洞净宽 / 净高 */
  width: number
  height: number
  /** 立柱宽 / 横梁高 / 前后进深 */
  postSize: number
  beamHeight: number
  frameDepth: number
}

/**
 * 充电桩程序化占位体：底座 + 机身 + 正面屏幕（+Z 正面、原点在底部中心，与 glTF 同约定）。
 * 返回模板对象，场景层按摆放逐个 clone（材质 / 几何在克隆间共享）。
 */
export function buildChargingPilePlaceholder(
  dims: ChargingPilePlaceholderDims,
  colors: { body: ColorRepresentation; screen: ColorRepresentation },
): Object3D {
  const group = new Group()
  group.name = 'charging-pile-placeholder'
  const body = new Mesh(
    translatedBox(dims.width, dims.height, dims.depth, 0, dims.height / 2, 0),
    new MeshStandardMaterial({ color: colors.body, roughness: 0.8, metalness: 0 }),
  )
  const screen = new Mesh(
    translatedBox(dims.width * 0.68, dims.height * 0.27, 0.02, 0, dims.height * 0.8, dims.depth / 2 + 0.01),
    new MeshStandardMaterial({
      color: colors.screen,
      roughness: 0.4,
      metalness: 0,
      emissive: colors.screen,
      emissiveIntensity: 0.6,
    }),
  )
  group.add(body, screen)
  return group
}

/**
 * 卷帘门门框程序化占位体：左右立柱 + 顶部横梁（+Z 正面、原点在底部中心——
 * 门洞净宽 × 净高的下缘中心，与 glTF 同约定）。
 */
export function buildRollerDoorFramePlaceholder(
  dims: DoorFramePlaceholderDims,
  color: ColorRepresentation,
): Object3D {
  const material = new MeshStandardMaterial({ color, roughness: 0.75, metalness: 0 })
  const group = new Group()
  group.name = 'roller-door-frame-placeholder'
  const halfWidth = dims.width / 2
  const fullHeight = dims.height + dims.beamHeight
  const postOffset = halfWidth + dims.postSize / 2
  const leftPost = new Mesh(
    translatedBox(dims.postSize, fullHeight, dims.frameDepth, -postOffset, fullHeight / 2, 0),
    material,
  )
  const rightPost = new Mesh(
    translatedBox(dims.postSize, fullHeight, dims.frameDepth, postOffset, fullHeight / 2, 0),
    material,
  )
  const beam = new Mesh(
    translatedBox(
      dims.width + dims.postSize * 2,
      dims.beamHeight,
      dims.frameDepth,
      0,
      dims.height + dims.beamHeight / 2,
      0,
    ),
    material,
  )
  group.add(leftPost, rightPost, beam)
  return group
}

/** 中心位于 (cx, cy, cz) 的方盒几何 */
function translatedBox(
  width: number,
  height: number,
  depth: number,
  cx: number,
  cy: number,
  cz: number,
): BufferGeometry {
  const geometry = new BoxGeometry(width, height, depth)
  geometry.translate(cx, cy, cz)
  return geometry
}
