/**
 * 同色交管矩形先做显示并集，再生成完整能量场与外缘光幕，消除转弯处的内部碎线。
 * 原始车辆矩形保持不变；并集保留孔洞和分离区域，绝不把整个包围盒当作路权。
 */
import * as THREE from 'three'
import ClipperLib from 'clipper-lib'
import type { WorldTransform } from '@/shared/spatial'
import type { NormalizedTrafficRectangle } from '../model/trafficRectangle'

const CLIPPER_SCALE = 10000
const UNION_BATCH_SIZE = 96
const EDGE_HALF_WIDTH_M = 0.065
const EDGE_LIFT_M = 0.006

export interface TrafficRegionGeometry {
  readonly field: THREE.BufferGeometry
  readonly edge: THREE.BufferGeometry
}

/**
 * 在共用世界变换之后使用零点一毫米整数网格，兼容旋转、镜像和平移后的地图。
 * 空路径产生空几何；只有路权签名变化时才会调用，动画帧不参与几何裁剪。
 */
export function buildTrafficRegionGeometry(
  rectangles: readonly NormalizedTrafficRectangle[],
  worldTransform: WorldTransform,
  height: number,
  wallHeight: number,
): TrafficRegionGeometry {
  const paths = rectangles.map((rectangle) => {
    const path = rectangle.points.map((point) => {
      const world = worldTransform.toWorldXZ(point.x, point.y)
      return { X: Math.round(world.x * CLIPPER_SCALE), Y: Math.round(world.z * CLIPPER_SCALE) }
    })
    if (!ClipperLib.Clipper.Orientation(path)) path.reverse()
    return path
  })
  const polygons = ClipperLib.JS.PolyTreeToExPolygons(unionPaths(paths))
  const fieldPositions: number[] = []
  const fieldOrigins: number[] = []
  const fieldIndices: number[] = []
  const edge = new EdgeGeometryBuilder(height + EDGE_LIFT_M, wallHeight)
  for (const polygon of polygons) {
    const rings = [polygon.outer, ...polygon.holes].map((ring) =>
      ring.map((point) => new THREE.Vector2(point.X / CLIPPER_SCALE, point.Y / CLIPPER_SCALE)),
    )
    const outer = rings[0]
    const origin = new THREE.Box2().setFromPoints(outer).getCenter(new THREE.Vector2())
    const triangles = THREE.ShapeUtils.triangulateShape(outer, rings.slice(1))
    const base = fieldPositions.length / 3
    for (const ring of rings) {
      for (const point of ring) {
        fieldPositions.push(point.x, height, point.y)
        fieldOrigins.push(origin.x, origin.y)
      }
      edge.addRing(ring)
    }
    for (const triangle of triangles) fieldIndices.push(...triangle.map((index) => base + index))
  }
  const field = makeGeometry(fieldPositions, fieldIndices)
  field.setAttribute('regionOrigin', new THREE.Float32BufferAttribute(fieldOrigins, 2))
  return { field, edge: edge.geometry() }
}

/**
 * 密集矩形按空间相邻顺序分批消除重叠，再求最终并集，缩小实时更新的裁剪输入。
 * 中间结果保留孔洞绕向，非零填充规则在后续合并时继续维持正确的占用范围。
 */
function unionPaths(paths: ClipperLib.Paths): ClipperLib.PolyTree {
  let input = paths
  if (paths.length > UNION_BATCH_SIZE) {
    const ordered = [...paths].sort((a, b) => a[0].X - b[0].X || a[0].Y - b[0].Y)
    input = []
    for (let i = 0; i < ordered.length; i += UNION_BATCH_SIZE) {
      input.push(...ClipperLib.Clipper.PolyTreeToPaths(unionPaths(ordered.slice(i, i + UNION_BATCH_SIZE))))
    }
  }
  const tree = new ClipperLib.PolyTree()
  if (input.length === 0) return tree
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(input, ClipperLib.PolyType.ptSubject, true)
  if (!clipper.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)) {
    throw new Error('交管区域显示轮廓合并失败')
  }
  return tree
}

/**
 * 光带与竖向光幕合并在同一缓冲，类型属性让着色器选择不同的渐隐方式。
 * 每条闭环使用整数个流光周期，首尾衔接不会出现跳变或断开的亮点。
 */
class EdgeGeometryBuilder {
  readonly positions: number[] = []
  readonly indices: number[] = []
  readonly uvs: number[] = []
  readonly kinds: number[] = []
  readonly cycles: number[] = []
  readonly height: number
  readonly wallHeight: number

  constructor(height: number, wallHeight: number) {
    this.height = height
    this.wallHeight = wallHeight
  }

  addRing(ring: readonly THREE.Vector2[]): void {
    const lengths = ring.map((point, index) => point.distanceTo(ring[(index + 1) % ring.length]))
    const perimeter = lengths.reduce((sum, length) => sum + length, 0)
    if (perimeter <= 0) return
    const repeats = Math.max(1, Math.round(perimeter / 2.8))
    const offsets = ring.map((_, index) => ringOffset(ring, index))
    let distance = 0
    for (let i = 0; i < ring.length; i += 1) {
      const next = (i + 1) % ring.length
      const from = ring[i]
      const to = ring[next]
      const start = distance / perimeter
      const end = (distance + lengths[i]) / perimeter
      this.quad([
        [from.x - offsets[i].x, this.height, from.y - offsets[i].y],
        [to.x - offsets[next].x, this.height, to.y - offsets[next].y],
        [to.x + offsets[next].x, this.height, to.y + offsets[next].y],
        [from.x + offsets[i].x, this.height, from.y + offsets[i].y],
      ], start, end, 0, repeats)
      this.quad([
        [from.x, this.height, from.y],
        [to.x, this.height, to.y],
        [to.x, this.height + this.wallHeight, to.y],
        [from.x, this.height + this.wallHeight, from.y],
      ], start, end, 1, repeats)
      distance += lengths[i]
    }
  }

  /**
   * 每块四边形各自持有顶点，光带与光幕之间不插值类型标记。
   * 索引统一为两个三角形，双面材质负责不同轮廓绕向下的可见性。
   */
  quad(points: readonly (readonly number[])[], start: number, end: number, kind: number, cycles: number): void {
    const base = this.positions.length / 3
    for (const point of points) this.positions.push(...point)
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    this.uvs.push(start, 0, end, 0, end, 1, start, 1)
    this.kinds.push(kind, kind, kind, kind)
    this.cycles.push(cycles, cycles, cycles, cycles)
  }

  geometry(): THREE.BufferGeometry {
    const geometry = makeGeometry(this.positions, this.indices)
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2))
    geometry.setAttribute('surfaceKind', new THREE.Float32BufferAttribute(this.kinds, 1))
    geometry.setAttribute('flowCycles', new THREE.Float32BufferAttribute(this.cycles, 1))
    /**
     * 顶部波动由顶点着色器完成，包围球额外留出两厘米，防止视锥边缘提前裁掉光幕。
     * 空几何不需要扩展，也不会提交给渲染器。
     */
    if (geometry.boundingSphere !== null) geometry.boundingSphere.radius += 0.02
    return geometry
  }
}

/**
 * 邻边法线的角平分线形成连续窄光带，转弯处共享接缝，不再堆叠独立线段端帽。
 * 限制尖角延伸长度，避免不规则交管边界在急转处拉出很长的发光尖刺。
 */
function ringOffset(ring: readonly THREE.Vector2[], index: number): THREE.Vector2 {
  const current = ring[index]
  const previous = ring[(index + ring.length - 1) % ring.length]
  const next = ring[(index + 1) % ring.length]
  const incoming = new THREE.Vector2().subVectors(current, previous).normalize()
  const outgoing = new THREE.Vector2().subVectors(next, current).normalize()
  const normal = new THREE.Vector2(-incoming.y, incoming.x)
  const miter = new THREE.Vector2(-outgoing.y, outgoing.x).add(normal).normalize()
  const denominator = miter.dot(normal)
  if (denominator < 0.2) return normal.multiplyScalar(EDGE_HALF_WIDTH_M)
  return miter.multiplyScalar(Math.min(EDGE_HALF_WIDTH_M / denominator, EDGE_HALF_WIDTH_M * 2.5))
}

/**
 * 只有非空几何计算包围球，避免空路径在显隐切换时产生非法包围体。
 * 所有坐标以世界米为单位，缓冲在路径变化或资源卸载时由图层所有者释放。
 */
function makeGeometry(positions: readonly number[], indices: readonly number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex([...indices])
  if (positions.length > 0) geometry.computeBoundingSphere()
  return geometry
}
