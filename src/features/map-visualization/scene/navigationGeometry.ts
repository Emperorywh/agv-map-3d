/**
 * 导航带由真实逻辑边生成，沿解析曲线按弧长取样；物理去重只减少重复绘制。
 * 路线与箭头各合为一个网格，状态仅上传颜色缓冲，不重建几何或增加灯光。
 */
import * as THREE from 'three'
import type { MapModel, MapEdge } from '../model/types'
import type { WorldTransform } from '@/shared/spatial'
import type { MapGeometry } from './buildMapGeometry'
import type { PathStates, NavigationStatus } from '../model/navigationState'
import { NAVIGATION_STYLE as S } from './navigationAppearance'
import { ROAD_MAIN_WIDTH_M, ROAD_BRANCH_WIDTH_M } from './mapAppearance'

type Batch = { positions: number[]; uv: number[]; indices: number[]; ranges: Range[] }
type Range = { start: number; end: number; ids: readonly string[] }

/**
 * 控制点只经过项目现有世界变换，保留源端点与源切线。
 * 使用曲线长度缓存等距取样，不把贝塞尔参数当成实际距离。
 */
export function navigationCurve(edge: MapEdge, transform: WorldTransform): THREE.Curve<THREE.Vector3> {
  const point = (x: number, y: number) => {
    const p = transform.toWorldXZ(x, y)
    return new THREE.Vector3(p.x, 0, p.z)
  }
  const start = point(edge.sx, edge.sy)
  const end = point(edge.ex, edge.ey)
  const curve = edge.edgeType === 'LINE' ? new THREE.LineCurve3(start, end)
    : new THREE.CubicBezierCurve3(start, point(edge.cx!, edge.cy!), point(edge.dx!, edge.dy!), end)
  curve.arcLengthDivisions = 256
  return curve
}

/**
 * 导航箭头与静态路面读取同一份道路分级和米制宽度，避免出现箭头排在路外。
 * 路口轮廓由共享路面处理，中心导航仍逐物理路径保留真实方向与状态。
 */
export function createNavigationGeometry(model: MapModel, geometry: MapGeometry, transform: WorldTransform) {
  const ribbon: Batch = { positions: [], uv: [], indices: [], ranges: [] }
  const arrows: Batch = { positions: [], uv: [], indices: [], ranges: [] }
  const vertex = (batch: Batch, x: number, z: number, u: number, v: number) => {
    const index = batch.positions.length / 3
    batch.positions.push(x, 0, z)
    batch.uv.push(u, v)
    return index
  }
  for (const path of geometry.physical.physicalPaths) {
    const edge = model.edges.get(path.representativeEdgeId)!
    const curve = navigationCurve(edge, transform)
    const length = curve.getLength()
    if (length < 0.00001) continue
    const roadWidth = geometry.roadRoles.get(path.index) === 'main' ? ROAD_MAIN_WIDTH_M : ROAD_BRANCH_WIDTH_M
    const segments = Math.max(2, Math.ceil(length / 0.16))
    const start = ribbon.positions.length / 3
    for (let i = 0; i <= segments; i += 1) {
      const u = i / segments
      const p = curve.getPointAt(u)
      const tangent = curve.getTangentAt(u)
      const nx = -tangent.z * S.washWidth / 2
      const nz = tangent.x * S.washWidth / 2
      const a = vertex(ribbon, p.x + nx, p.z + nz, u, 0)
      vertex(ribbon, p.x - nx, p.z - nz, u, 1)
      if (i < segments) ribbon.indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
    ribbon.ranges.push({ start, end: ribbon.positions.length / 3, ids: path.logicalEdgeIds })
    /**
     * 双向依据真实起止节点识别，不能把 isBackEdge 当成绘制方向。
     * 单向箭头居中，双向分列两侧；尺寸同时受边长和路宽约束。
     */
    const forward = path.logicalEdgeIds.filter((id) => model.edges.get(id)!.snodeId === edge.snodeId)
    const reverse = path.logicalEdgeIds.filter((id) => model.edges.get(id)!.snodeId !== edge.snodeId)
    const directions = reverse.length ? [{ sign: 1, ids: forward }, { sign: -1, ids: reverse }] : [{ sign: 1, ids: forward }]
    const count = Math.max(1, Math.floor(length / S.arrowSpacing))
    const size = Math.min(S.arrowLength, length * 0.32, roadWidth * 0.32)
    for (const { sign, ids } of directions) {
      const arrowStart = arrows.positions.length / 3
      for (let i = 0; i < count; i += 1) {
        const u = (i + 0.5) / count
        const p = curve.getPointAt(u)
        const tangent = curve.getTangentAt(u).multiplyScalar(sign)
        const nx = -tangent.z
        const nz = tangent.x
        const offset = directions.length === 2 ? roadWidth * S.arrowOffsetRatio : 0
        const x = p.x + nx * offset
        const z = p.z + nz * offset
        const local = [[-0.5, -0.48], [0.5, 0], [-0.5, 0.48], [-0.5, 0.25], [0.06, 0], [-0.5, -0.25]]
        const base = arrows.positions.length / 3
        for (const [tx, tz] of local) vertex(arrows, x + (tangent.x * tx + nx * tz) * size, z + (tangent.z * tx + nz * tz) * size, u, 0.5)
        arrows.indices.push(base, base + 1, base + 4, base, base + 4, base + 5, base + 1, base + 2, base + 3, base + 1, base + 3, base + 4)
      }
      arrows.ranges.push({ start: arrowStart, end: arrows.positions.length / 3, ids })
    }
  }
  const build = (batch: Batch) => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(batch.positions, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(batch.uv, 2))
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(batch.positions.length), 3).setUsage(THREE.DynamicDrawUsage))
    geometry.setIndex(batch.indices)
    geometry.computeBoundingSphere()
    return geometry
  }
  const ribbonGeometry = build(ribbon)
  const arrowGeometry = build(arrows)
  const clear = new THREE.Color(S.clear)
  const palette = { clear, reserved: new THREE.Color(S.reserved), waiting: new THREE.Color(S.waiting), blocked: new THREE.Color(S.blocked) }
  const tint = new THREE.Color()
  const priority: Record<NavigationStatus, number> = { clear: 0, reserved: 1, waiting: 1, blocked: 2 }
  const paint = (batch: Batch, geometry: THREE.BufferGeometry, states: PathStates) => {
    const colors = geometry.getAttribute('color') as THREE.BufferAttribute
    for (const range of batch.ranges) {
      let status: NavigationStatus = 'clear'
      for (const id of range.ids) {
        const candidate = states[id] ?? 'clear'
        if (priority[candidate] > priority[status]) status = candidate
      }
      for (let i = range.start; i < range.end; i += 1) {
        /**
         * 受阻在中段形成局部红色渐变，端部保留通行色。
         * 正反向箭头各自读取逻辑边状态，主体按最高优先级显示。
         */
        const u = batch.uv[i * 2]
        const blend = status === 'blocked' ? Math.exp(-Math.pow((u - 0.55) / 0.24, 4)) : 1
        tint.copy(clear).lerp(palette[status], blend).multiplyScalar(S.emission)
        colors.setXYZ(i, tint.r, tint.g, tint.b)
      }
    }
    colors.needsUpdate = true
  }
  const update = (states: PathStates) => { paint(ribbon, ribbonGeometry, states); paint(arrows, arrowGeometry, states) }
  update({})
  return { ribbon: ribbonGeometry, arrows: arrowGeometry, update, dispose() { ribbonGeometry.dispose(); arrowGeometry.dispose() } }
}

/**
 * 宽带内部计算细核心、窄光晕和低亮度地面光斑。
 * 中心线保持低透明度，突出路面两侧轮廓，交汇处使用普通合成避免过曝。
 * 屏幕光晕仍归唯一 SceneBloom，地面光斑是近似受光，不冒充真实照明。
 */
export function createNavigationMaterial(ribbon: boolean) {
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, opacity: ribbon ? S.guideOpacity : 1, transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, blending: ribbon ? THREE.NormalBlending : THREE.AdditiveBlending })
  if (ribbon) {
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = `varying vec2 navigationUv;\n${shader.vertexShader}`.replace('#include <uv_vertex>', '#include <uv_vertex>\nnavigationUv = uv;')
      shader.fragmentShader = `varying vec2 navigationUv;\n${shader.fragmentShader}`.replace('#include <opaque_fragment>', `
// 横向世界距离控制光核宽度，导数只承担抗锯齿，缩放不改变实际尺寸。
// 宽光斑远低于核心亮度，避免整个地面被青色透明带覆盖。
float d = abs(navigationUv.y - 0.5) * ${S.washWidth.toFixed(3)};
float aa = max(fwidth(d), 0.001);
float core = 1.0 - smoothstep(${(S.routeWidth / 2).toFixed(4)} - aa, ${(S.routeWidth / 2).toFixed(4)} + aa, d);
float glow = exp(-d * d / ${(S.haloWidth * S.haloWidth / 22).toFixed(5)}) * 0.06;
float wash = exp(-d * d / 0.085) * 0.006;
diffuseColor.a *= min(1.0, core + glow + wash);
#include <opaque_fragment>`)
    }
    material.customProgramCacheKey = () => 'navigation-ribbon-v2'
  }
  return material
}
