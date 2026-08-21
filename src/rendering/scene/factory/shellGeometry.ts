/**
 * 建筑外壳几何（SPEC §5.2）：地坪（含网格刻线）/ 外墙 / 立柱 / 平屋顶 + 天窗带。
 *
 * - 尺寸口径：地图包围盒（NormalizedMap.bounds，含边折线与贝塞尔控制点，与 §4.3
 *   calibration offset 同源）四周外扩 FACTORY_MARGIN；全部顶点经 domain/coordinates.ts
 *   的 mapToWorld 转世界坐标，与地图天然对齐、无二次配准（SPEC §4.3）；
 * - 放置与尺寸算法（footprint / 柱位避让采样 / 天窗带布局 / 网格刻线）为纯函数，
 *   常量（FACTORY_MARGIN、柱距、避让阈值等）全部以参数传入，可单测；
 * - 立柱按柱距规则阵列，采样时避开走廊 ribbon 区域：候选柱位与走廊中心线距离
 *   小于避让阈值（COLUMN_CORRIDOR_CLEARANCE，含 ribbon 半宽余量）则不放置；
 * - 几何按 地坪 / 外墙 / 立柱 / 屋顶天窗 分组产出：地坪、外墙、屋顶、天窗带各为
 *   单个合并 BufferGeometry，立柱为单个 InstancedMesh（实例矩阵 + 本地几何），
 *   整壳合计 6 个 draw call（SPEC §9 预算）。
 *
 * rendering 层可 import three 与 config，禁止 import infrastructure（SPEC §12）。
 */

import {
  BoxGeometry,
  BufferGeometry,
  Euler,
  Float32BufferAttribute,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three'

import { mapToWorld } from '../../../domain/coordinates'
import { distanceToPolyline } from '../../../domain/polyline'
import type { Calibration, MapBounds, MapPoint, Polyline } from '../../../domain/types'

// ---------------------------------------------------------------------------
// 纯函数：建筑占位矩形（footprint）
// ---------------------------------------------------------------------------

/** 建筑占位矩形（地图平面，地图包围盒四周外扩 margin） */
export interface FactoryFootprint {
  minX: number
  minY: number
  maxX: number
  maxY: number
  /** x 向尺寸（米） */
  width: number
  /** y 向尺寸（米） */
  depth: number
  centerX: number
  centerY: number
}

/**
 * 建筑占位矩形 = 地图包围盒 + 四周各 margin（SPEC §5.2）。
 * bounds 为 NormalizedMap.bounds（含边折线与贝塞尔控制点，与 §4.3 offset 同口径）。
 */
export function computeFactoryFootprint(bounds: MapBounds, margin: number): FactoryFootprint {
  const minX = bounds.minX - margin
  const minY = bounds.minY - margin
  const maxX = bounds.maxX + margin
  const maxY = bounds.maxY + margin
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    depth: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  }
}

// ---------------------------------------------------------------------------
// 纯函数：立柱阵列采样（避开走廊 ribbon 区域）
// ---------------------------------------------------------------------------

/**
 * 立柱柱位采样（SPEC §5.2）：footprint 内按 spacing 规则阵列（对齐地图坐标
 * spacing 整数倍，结果确定）；候选柱位与任一走廓中心线距离小于 clearance
 * （自中心线起算，含 ribbon 半宽与柱截面余量）时不放置。
 */
export function computeColumnPlacements(
  footprint: FactoryFootprint,
  spacing: number,
  corridorGeometries: Polyline[],
  clearance: number,
): MapPoint[] {
  const placements: MapPoint[] = []
  for (let ix = Math.ceil(footprint.minX / spacing); ix * spacing <= footprint.maxX; ix++) {
    for (let iy = Math.ceil(footprint.minY / spacing); iy * spacing <= footprint.maxY; iy++) {
      const point: MapPoint = { x: positiveZero(ix * spacing), y: positiveZero(iy * spacing) }
      if (
        corridorGeometries.every(
          (geometry) => distanceToPolyline(point, geometry) >= clearance,
        )
      ) {
        placements.push(point)
      }
    }
  }
  return placements
}

/** Math.ceil 对负小数得 -0；归一为 +0，保证输出确定性（深比较 / 序列化不受 -0 干扰） */
function positiveZero(value: number): number {
  return value === 0 ? 0 : value
}

// ---------------------------------------------------------------------------
// 纯函数：天窗带布局与地坪网格刻线
// ---------------------------------------------------------------------------

/** 地图平面轴对齐矩形条带 */
export interface MapStrip {
  centerX: number
  centerY: number
  /** x 向尺寸（米） */
  lengthX: number
  /** y 向尺寸（米） */
  lengthY: number
}

/**
 * 平屋顶天窗带布局（SPEC §5.2 规则天窗带）：沿 footprint 长轴方向延伸的等距条带，
 * 沿短轴按 stripSpacing 居中排布，四周内缩 edgeInset；短轴放不下一条带宽时返回空。
 */
export function computeSkylightStrips(
  footprint: FactoryFootprint,
  stripWidth: number,
  stripSpacing: number,
  edgeInset: number,
): MapStrip[] {
  const alongX = footprint.width >= footprint.depth
  const longSide = alongX ? footprint.width : footprint.depth
  const shortSide = alongX ? footprint.depth : footprint.width
  const stripLength = longSide - edgeInset * 2
  const span = shortSide - edgeInset * 2
  if (stripLength <= 0 || span < stripWidth) {
    return []
  }
  const count = Math.max(1, Math.floor(span / stripSpacing) + 1)
  const firstOffset = (shortSide - (count - 1) * stripSpacing) / 2
  const crossMin = alongX ? footprint.minY : footprint.minX
  const strips: MapStrip[] = []
  for (let i = 0; i < count; i++) {
    const cross = crossMin + firstOffset + i * stripSpacing
    strips.push(
      alongX
        ? {
            centerX: footprint.centerX,
            centerY: cross,
            lengthX: stripLength,
            lengthY: stripWidth,
          }
        : {
            centerX: cross,
            centerY: footprint.centerY,
            lengthX: stripWidth,
            lengthY: stripLength,
          },
    )
  }
  return strips
}

/** 地图平面线段（两点式），供 LineSegments 几何构建 */
export interface MapSegment {
  a: MapPoint
  b: MapPoint
}

/** 地坪网格刻线（SPEC §5.2 每 10m 浅网格）：footprint 内对齐 step 整数倍的纵横线 */
export function computeFloorGridLines(footprint: FactoryFootprint, step: number): MapSegment[] {
  const segments: MapSegment[] = []
  for (let ix = Math.ceil(footprint.minX / step); ix * step <= footprint.maxX; ix++) {
    const x = positiveZero(ix * step)
    segments.push({ a: { x, y: footprint.minY }, b: { x, y: footprint.maxY } })
  }
  for (let iy = Math.ceil(footprint.minY / step); iy * step <= footprint.maxY; iy++) {
    const y = positiveZero(iy * step)
    segments.push({ a: { x: footprint.minX, y }, b: { x: footprint.maxX, y } })
  }
  return segments
}

// ---------------------------------------------------------------------------
// 几何构建参数与结果（尺寸阈值由场景层自 config/constants.ts 注入）
// ---------------------------------------------------------------------------

export interface ShellGeometryParams {
  /** 建筑包围盒外扩边距（config FACTORY_MARGIN） */
  margin: number
  /** 外墙 / 立柱高度（config WALL_HEIGHT） */
  wallHeight: number
  /** 地坪网格刻线间距 / 抬升（config FLOOR_GRID_*） */
  gridStep: number
  gridLift: number
  /** 立柱柱距 / 截面边长 / 走廊避让阈值（config COLUMN_*） */
  columnSpacing: number
  columnSize: number
  columnClearance: number
  /** 天窗带带宽 / 带距 / 内缩 / 抬升（config SKYLIGHT_*） */
  skylightStripWidth: number
  skylightStripSpacing: number
  skylightEdgeInset: number
  skylightLift: number
}

/** 建筑外壳全部分组几何（地坪 / 网格刻线 / 外墙 / 立柱 / 屋顶 / 天窗带） */
export interface ShellGeometryResult {
  /** 地坪：单块平面（y=0），法线 +Y */
  floor: BufferGeometry
  /** 网格刻线：LineSegments（y=gridLift，低于 ribbon） */
  floorGrid: BufferGeometry
  /** 外墙：沿 footprint 矩形的 4 面合并几何（高 wallHeight） */
  walls: BufferGeometry
  /** 立柱本地几何（方柱，底面贴 y=0），与 columnMatrices 配套供单个 InstancedMesh */
  columnGeometry: BufferGeometry
  /** 立柱实例矩阵（Matrix4.elements 列主序展平，长度 = columnCount × 16） */
  columnMatrices: Float32Array
  /** 立柱实例数（避让走廊后的实际柱位数） */
  columnCount: number
  /** 平屋顶：单块平面（y=wallHeight），法线 +Y */
  roof: BufferGeometry
  /** 天窗带：合并条带平面（y=wallHeight+skylightLift） */
  skylights: BufferGeometry
  /** 释放全部几何（实例矩阵为 CPU 侧 typed array，随 GC 回收） */
  dispose: () => void
}

/**
 * 一次性构建建筑外壳全部几何。外壳体量小（几个合并 quad + 百级柱位实例），
 * 无需分帧（SPEC §4.4 分帧针对走廊 / 节点万级几何）。
 */
export function buildShellGeometry(
  bounds: MapBounds,
  corridorGeometries: Polyline[],
  calibration: Calibration,
  params: ShellGeometryParams,
): ShellGeometryResult {
  const footprint = computeFactoryFootprint(bounds, params.margin)
  const columnPlacements = computeColumnPlacements(
    footprint,
    params.columnSpacing,
    corridorGeometries,
    params.columnClearance,
  )
  const skylightStrips = computeSkylightStrips(
    footprint,
    params.skylightStripWidth,
    params.skylightStripSpacing,
    params.skylightEdgeInset,
  )

  const floor = buildHorizontalQuadGeometry(footprint, 0, calibration)
  const floorGrid = buildFloorGridGeometry(
    computeFloorGridLines(footprint, params.gridStep),
    params.gridLift,
    calibration,
  )
  const walls = buildWallGeometry(footprint, params.wallHeight, calibration)
  const columnGeometry = buildColumnGeometry(params.columnSize, params.wallHeight)
  const columnMatrices = buildColumnInstanceMatrices(columnPlacements, calibration)
  const roof = buildHorizontalQuadGeometry(footprint, params.wallHeight, calibration)
  const skylights = buildSkylightGeometry(
    skylightStrips,
    params.wallHeight + params.skylightLift,
    calibration,
  )

  return {
    floor,
    floorGrid,
    walls,
    columnGeometry,
    columnMatrices,
    columnCount: columnPlacements.length,
    roof,
    skylights,
    dispose() {
      floor.dispose()
      floorGrid.dispose()
      walls.dispose()
      columnGeometry.dispose()
      roof.dispose()
      skylights.dispose()
    },
  }
}

// ---------------------------------------------------------------------------
// 各分组几何构建（顶点一律经 mapToWorld 转世界坐标，z 取反唯一收口）
// ---------------------------------------------------------------------------

/** 地图平面矩形 → y=height 水平面 quad（法线 +Y；mapToWorld 的 y→-z 反射已计入绕序推导） */
function buildHorizontalQuadGeometry(
  rect: { minX: number; minY: number; maxX: number; maxY: number },
  height: number,
  calibration: Calibration,
): BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []
  pushHorizontalQuad(positions, indices, rect, height, calibration)
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/**
 * 向数组追加一个水平面 quad（4 顶点 2 三角形）。
 * 绕序 (w0,w1,w2) / (w0,w2,w3) 经 y→-z 反射后法线 +Y（旋转 / 正缩放不改变旋向）。
 */
function pushHorizontalQuad(
  positions: number[],
  indices: number[],
  rect: { minX: number; minY: number; maxX: number; maxY: number },
  height: number,
  calibration: Calibration,
): void {
  const w0 = mapToWorld({ x: rect.minX, y: rect.minY }, calibration)
  const w1 = mapToWorld({ x: rect.maxX, y: rect.minY }, calibration)
  const w2 = mapToWorld({ x: rect.maxX, y: rect.maxY }, calibration)
  const w3 = mapToWorld({ x: rect.minX, y: rect.maxY }, calibration)
  const offset = positions.length / 3
  positions.push(
    w0.x, height, w0.z,
    w1.x, height, w1.z,
    w2.x, height, w2.z,
    w3.x, height, w3.z,
  )
  indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3)
}

/** 网格刻线：LineSegments 几何（每线段 2 顶点） */
function buildFloorGridGeometry(
  segments: MapSegment[],
  lift: number,
  calibration: Calibration,
): BufferGeometry {
  const positions: number[] = []
  for (const segment of segments) {
    const a = mapToWorld(segment.a, calibration)
    const b = mapToWorld(segment.b, calibration)
    positions.push(a.x, lift, a.z, b.x, lift, b.z)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  return geometry
}

/**
 * 外墙：沿 footprint 矩形的 4 面竖直 quad 合并（每面 4 顶点独立，保证平面法线）；
 * 双面可见（室内 / 室外两侧），材质由场景层置 DoubleSide。
 */
function buildWallGeometry(
  footprint: FactoryFootprint,
  height: number,
  calibration: Calibration,
): BufferGeometry {
  const corners: MapPoint[] = [
    { x: footprint.minX, y: footprint.minY },
    { x: footprint.maxX, y: footprint.minY },
    { x: footprint.maxX, y: footprint.maxY },
    { x: footprint.minX, y: footprint.maxY },
  ]
  const positions: number[] = []
  const indices: number[] = []
  for (let i = 0; i < 4; i++) {
    const base = mapToWorld(corners[i], calibration)
    const next = mapToWorld(corners[(i + 1) % 4], calibration)
    const offset = positions.length / 3
    positions.push(
      base.x, 0, base.z,
      next.x, 0, next.z,
      next.x, height, next.z,
      base.x, height, base.z,
    )
    indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/** 立柱本地几何：方柱（截面 columnSize × columnSize），底面贴 y=0，高 height */
function buildColumnGeometry(columnSize: number, height: number): BufferGeometry {
  const geometry = new BoxGeometry(columnSize, height, columnSize)
  geometry.translate(0, height / 2, 0)
  return geometry
}

/**
 * 立柱实例矩阵：位置经 mapToWorld；方柱截面按地图轴对齐，
 * rotation.y = calibration.rotationRad（与 §4.3 变换推导一致，当前 θ=0 退化为无旋转）。
 */
function buildColumnInstanceMatrices(
  placements: MapPoint[],
  calibration: Calibration,
): Float32Array {
  const matrices = new Float32Array(placements.length * 16)
  const position = new Vector3()
  const scale = new Vector3(1, 1, 1)
  const quaternion = new Quaternion().setFromEuler(new Euler(0, calibration.rotationRad, 0))
  const matrix = new Matrix4()
  for (let i = 0; i < placements.length; i++) {
    const world = mapToWorld(placements[i], calibration)
    position.set(world.x, 0, world.z)
    matrix.compose(position, quaternion, scale)
    matrices.set(matrix.elements, i * 16)
  }
  return matrices
}

/** 天窗带：各条带合并为单个几何（条带矩形 → y=height 水平面 quad，法线 +Y） */
function buildSkylightGeometry(
  strips: MapStrip[],
  height: number,
  calibration: Calibration,
): BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []
  for (const strip of strips) {
    pushHorizontalQuad(
      positions,
      indices,
      {
        minX: strip.centerX - strip.lengthX / 2,
        minY: strip.centerY - strip.lengthY / 2,
        maxX: strip.centerX + strip.lengthX / 2,
        maxY: strip.centerY + strip.lengthY / 2,
      },
      height,
      calibration,
    )
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}
