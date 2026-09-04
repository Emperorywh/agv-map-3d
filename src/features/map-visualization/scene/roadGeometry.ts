/**
 * 每条真实物理路径都生成道路包络，不能按节点类别或合并链筛掉库位接入路径。
 * 并集只清理重叠白边，完整蓝色轨迹独立绘制；所有计算只在地图构建时执行。
 */
import * as THREE from 'three'
import ClipperLib from 'clipper-lib'
import type { WorldTransform } from '@/shared/spatial'
import type { MapModel } from '../model/types'
import type { PhysicalPathIndex } from './buildMapGeometry'
import type { RoadNetwork } from './roadTopology'
import type { RoadRole } from './roadPresentation'
import {
  ROAD_MAIN_WIDTH_M, ROAD_BRANCH_WIDTH_M, ROAD_SURFACE_Y, ROAD_BOUNDARY_Y,
  ROAD_BOUNDARY_WIDTH_M, ROAD_GUIDE_Y, ROAD_GUIDE_WIDTH_M, ROAD_GUIDE_OPACITY,
  ROAD_GUIDE_COLOR, ROAD_JUNCTION_COLOR, ROAD_JUNCTION_Y,
  ROAD_JUNCTION_RADIUS_M, ROAD_JUNCTION_SPACING_M,
} from './mapAppearance'

export interface RoadGeometry {
  readonly roadSurface: THREE.BufferGeometry
  readonly roadBoundaries: THREE.BufferGeometry
  readonly roadGuides: THREE.BufferGeometry
  readonly roadJunctionLights: THREE.BufferGeometry
}

const EPSILON = 1e-6
const CLIPPER_SCALE = 10000

/**
 * 米制平面坐标只在几何模块内部使用，避免把多边形库类型泄露给调度模型。
 * 每个多边形的第一环是外轮廓，其余环是保留的地坪孔洞。
 */
type Pair = [number, number]
type Polygon = Pair[][]
type MultiPolygon = Polygon[]

/**
 * 统一累加三角形与可选透明顶点色，空输入产生合法空几何。
 * 孔洞交给现有三角化器处理，闭环道路中间的地坪不会被填满。
 */
class RoadBatch {
  readonly positions: number[] = []
  readonly indices: number[] = []
  readonly colors: number[] = []

  polygon(polygon: Polygon, height: number, color?: THREE.Color, alpha = 1): void {
    const rings = polygon.map((ring) => {
      const points = ring.map(([x, y]) => new THREE.Vector2(x, y))
      if (points.length > 1 && points[0].equals(points[points.length - 1])) points.pop()
      return points
    }).filter((ring) => ring.length >= 3)
    if (rings.length === 0) return
    const triangles = THREE.ShapeUtils.triangulateShape(rings[0], rings.slice(1))
    const base = this.positions.length / 3
    for (const p of rings.flat()) {
      this.positions.push(p.x, height, p.y)
      if (color !== undefined) this.colors.push(color.r, color.g, color.b, alpha)
    }
    for (const triangle of triangles) this.indices.push(...triangle.map((index) => base + index))
  }

  geometry(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3))
    if (this.colors.length > 0) geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 4))
    geometry.setIndex(this.indices)
    geometry.computeBoundingSphere()
    return geometry
  }
}

/**
 * 整数几何网格精度为 0.1 毫米，只服务展示轮廓，避免近共线相交时浮点拓扑失稳。
 * 树结构保留外环、孔洞和孔内岛，闭环与复杂路网都不会误填通行空间之外的区域。
 */
function fromPolyTree(tree: ClipperLib.PolyTree): MultiPolygon {
  return ClipperLib.JS.PolyTreeToExPolygons(tree).map((polygon) =>
    [polygon.outer, ...polygon.holes].map((ring) =>
      ring.map((point): Pair => [point.X / CLIPPER_SCALE, point.Y / CLIPPER_SCALE]),
    ),
  )
}

function toIntegerPath(points: readonly Pair[]): ClipperLib.Path {
  return points.map(([x, y]) => ({ X: Math.round(x * CLIPPER_SCALE), Y: Math.round(y * CLIPPER_SCALE) }))
}

/**
 * 使用圆角偏移处理贝塞尔、急弯、反折和闭环；开放链以真实端点的横截面收口。
 * 量化发生在新建包络副本中，输入轨迹点与逻辑方向始终保留。
 */
export function bufferRoadPolyline(input: readonly Pair[], radius: number, forceClosed = false): MultiPolygon {
  const points = input.filter((p, i) => i === 0 || Math.hypot(p[0] - input[i - 1][0], p[1] - input[i - 1][1]) > EPSILON)
  if (points.length < 2) return []
  const closed = forceClosed || Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1]) < EPSILON
  const offset = new ClipperLib.ClipperOffset(2, Math.min(radius / 4, 0.005) * CLIPPER_SCALE)
  offset.AddPath(toIntegerPath(points), ClipperLib.JoinType.jtRound, closed ? ClipperLib.EndType.etClosedLine : ClipperLib.EndType.etOpenButt)
  const solution = new ClipperLib.PolyTree()
  offset.Execute(solution, radius * CLIPPER_SCALE)
  return fromPolyTree(solution)
}

/**
 * 对完整路面求并集后只描外边界；路口、宽度变化和短边重叠处不留下内部白线。
 * 所有外环统一绕向、孔洞取相反绕向，非零填充规则不会误挖重叠道路。
 */
export function unionRoadPolygons(polygons: MultiPolygon): MultiPolygon {
  if (polygons.length === 0) return []
  /**
   * 相邻空间包络先分批合并，提前消除内部线段，控制复杂交叉地图的构建耗时。
   * 最后仍执行全局并集，分批边界不会作为可见接缝保留下来。
   */
  if (polygons.length > 64) {
    const ordered = [...polygons].sort((a, b) => a[0][0][0] - b[0][0][0])
    const reduced: MultiPolygon = []
    for (let i = 0; i < ordered.length; i += 64) {
      reduced.push(...clipRoadPolygons(ordered.slice(i, i + 64)))
    }
    return clipRoadPolygons(reduced)
  }
  return clipRoadPolygons(polygons)
}

/**
 * 单批裁剪保留孔洞层级，外环与内环使用相反绕向。
 * 不启用额外的全局简单多边形拆分，避免密集路网触发平方级后处理。
 */
function clipRoadPolygons(polygons: MultiPolygon): MultiPolygon {
  const clipper = new ClipperLib.Clipper()
  for (const polygon of polygons) {
    polygon.forEach((ring, index) => {
      const path = toIntegerPath(ring)
      if (ClipperLib.Clipper.Orientation(path) !== (index === 0)) path.reverse()
      clipper.AddPath(path, ClipperLib.PolyType.ptSubject, true)
    })
  }
  const solution = new ClipperLib.PolyTree()
  if (!clipper.Execute(ClipperLib.ClipType.ctUnion, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)) {
    throw new Error('道路展示包络裁剪失败')
  }
  return fromPolyTree(solution)
}

/**
 * 静态同心网格的透明度向外衰减，不增加点光源与逐帧呼吸动画。
 * 中心位于地面贴花层，近景由原有业务节点自然覆盖。
 */
function appendJunctionLight(batch: RoadBatch, center: Pair): void {
  const color = new THREE.Color(ROAD_JUNCTION_COLOR)
  const base = batch.positions.length / 3
  for (const [radius, alpha] of [[0, 0.95], [0.11, 0.9], [ROAD_JUNCTION_RADIUS_M, 0]]) {
    for (let i = 0; i < 24; i += 1) {
      const angle = i * Math.PI * 2 / 24
      batch.positions.push(center[0] + Math.cos(angle) * radius, ROAD_JUNCTION_Y, center[1] + Math.sin(angle) * radius)
      batch.colors.push(color.r, color.g, color.b, alpha)
    }
  }
  for (let ring = 0; ring < 2; ring += 1) {
    for (let i = 0; i < 24; i += 1) {
      const a = base + ring * 24 + i
      const b = base + ring * 24 + (i + 1) % 24
      batch.indices.push(a, b, b + 24, a, b + 24, a + 24)
    }
  }
}

/**
 * 直接遍历全部物理路径生成路面，不依赖道路链是否合并或被归为接入线。
 * 道路角色只调整宽度和关键路口光点，不再影响路径是否显示或引导线亮度。
 */
export function buildRoadGeometry(
  model: MapModel,
  physical: PhysicalPathIndex,
  network: RoadNetwork,
  roles: ReadonlyMap<number, RoadRole>,
  worldTransform: WorldTransform,
): RoadGeometry {
  const surface = new RoadBatch()
  const boundaries = new RoadBatch()
  const guides = new RoadBatch()
  const lights = new RoadBatch()
  const footprints: MultiPolygon = []
  const toWorld = (points: readonly { x: number; y: number }[]): Pair[] => points.map((point) => {
    const world = worldTransform.toWorldXZ(point.x, point.y)
    return [world.x, world.z]
  })
  for (const path of physical.physicalPaths) {
    const role = roles.get(path.index)
    const radius = (role === 'main' ? ROAD_MAIN_WIDTH_M : ROAD_BRANCH_WIDTH_M) / 2
    footprints.push(...bufferRoadPolyline(toWorld(path.points), radius))
  }
  const roadArea = unionRoadPolygons(footprints)
  for (const polygon of roadArea) {
    surface.polygon(polygon, ROAD_SURFACE_Y)
    for (const ring of polygon) {
      for (const border of bufferRoadPolyline(ring, ROAD_BOUNDARY_WIDTH_M / 2, true)) {
        boundaries.polygon(border, ROAD_BOUNDARY_Y)
      }
    }
  }

  /**
   * 全部路径采用同一可读宽度和透明度，库位、充电、停车接入不再弱化。
   * 引导线逐物理路径保留，在道路外轮廓合并后仍能看清每条实际行驶轨迹。
   */
  const incidentRoles = new Map<string, RoadRole[]>()
  const guideColor = new THREE.Color(ROAD_GUIDE_COLOR)
  for (const path of physical.physicalPaths) {
    const role = roles.get(path.index) ?? 'access'
    const isAccess = role === 'access'
    const guide = bufferRoadPolyline(toWorld(path.points), ROAD_GUIDE_WIDTH_M / 2)
    for (const polygon of guide) {
      guides.polygon(polygon, ROAD_GUIDE_Y, guideColor, ROAD_GUIDE_OPACITY)
    }
    const edge = model.edges.get(path.representativeEdgeId)
    if (edge === undefined || isAccess) continue
    for (const nodeId of [edge.snodeId, edge.enodeId]) {
      const list = incidentRoles.get(nodeId) ?? []
      list.push(role)
      incidentRoles.set(nodeId, list)
    }
  }
  /**
   * 按路口重要度稳定挑选光点，再在世界坐标内限距，避免形成密集发光点阵。
   * 不把无主通道参与的库位支路交点提升成视觉地标。
   */
  const selected: Pair[] = []
  const junctions = [...network.junctions].sort((a, b) => b.degree - a.degree || a.nodeId.localeCompare(b.nodeId))
  for (const junction of junctions) {
    const incident = incidentRoles.get(junction.nodeId) ?? []
    if (incident.length < 3 || !incident.includes('main')) continue
    const center = toWorld([junction])[0]
    if (selected.some((point) => Math.hypot(point[0] - center[0], point[1] - center[1]) < ROAD_JUNCTION_SPACING_M)) continue
    selected.push(center)
    appendJunctionLight(lights, center)
  }
  return {
    roadSurface: surface.geometry(),
    roadBoundaries: boundaries.geometry(),
    roadGuides: guides.geometry(),
    roadJunctionLights: lights.geometry(),
  }
}
