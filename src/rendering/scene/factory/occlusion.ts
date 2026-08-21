/**
 * 遮挡处理纯函数（SPEC §5.5）：屋顶自动隐藏 / 墙体穿透与视线淡出 / 立柱俯角淡出。
 *
 * - 全部 2D 判定在地图平面坐标系进行（轴对齐矩形最简），相机 / 关注点由场景层经
 *   domain/coordinates.ts 的 worldToMapInto 转换后传入；高度（y）不经校准变换，
 *   直接取世界坐标（z 取反唯一收口于 coordinates.ts，本模块不接触世界 XZ 语义）；
 * - 屋顶判定为 footprint 交集：XZ 落外墙矩形内 **且** 高度低于屋檐，二者缺一不可——
 *   跟随模式相机常在建筑外低高度环绕，单纯高度阈值会让屋顶误淡入遮挡跟随目标；
 * - 墙体淡出取两条判定的并集：① 相机穿透 / 贴近的墙段（3D 距离连续驱动不透明度，
 *   无离散阈值天然不抖）；② 遮挡 相机→关注点 连线的墙段（离散判定，带双重滞后——
 *   穿越高度退出带 + 已遮挡状态墙段外延——防边界摆动闪烁）；
 * - 立柱淡出：正交俯视恒淡出；透视按相机俯角超阈值（默认 60°，config 常量）；
 * - 所有不透明度经 dampOpacity 指数阻尼平滑过渡（帧率无关），滞后只作用于判定，
 *   过渡曲线由阻尼保证。
 *
 * rendering 层可 import three 与 config，禁止 import infrastructure（SPEC §12）。
 * 本模块不 import config：判定参数全部由场景层自 config/constants.ts 装配注入。
 */

import type { MapPoint } from '../../../domain/types'
import type { FactoryFootprint, MapSegment } from './shellGeometry'

// ---------------------------------------------------------------------------
// 屋顶（SPEC §5.5：默认隐藏；footprint 交集淡入；跟随模式强制隐藏；三态手动覆盖）
// ---------------------------------------------------------------------------

/** 屋顶手动覆盖三态（与 state/appStore 的 RoofOverride 结构兼容，rendering 不反向依赖 state） */
export type RoofOverrideMode = 'auto' | 'show' | 'hide'

/** 相机模式（与 state/appStore 的 CameraMode 结构兼容） */
export type OcclusionCameraMode = 'orbit' | 'topdown' | 'follow'

/**
 * footprint 交集判定（SPEC §5.5）：相机 XZ 落在外墙矩形内 **且** 高度低于屋檐。
 * cameraMapX / cameraMapY 为地图平面坐标，cameraHeight 为世界高度（米）。
 */
export function isCameraInsideFootprint(
  footprint: FactoryFootprint,
  cameraMapX: number,
  cameraMapY: number,
  cameraHeight: number,
  eavesHeight: number,
): boolean {
  return (
    cameraMapX >= footprint.minX &&
    cameraMapX <= footprint.maxX &&
    cameraMapY >= footprint.minY &&
    cameraMapY <= footprint.maxY &&
    cameraHeight < eavesHeight
  )
}

/**
 * 屋顶目标可见性（SPEC §5.5）：
 * - 手动覆盖优先：'show' 恒显示、'hide' 恒隐藏；
 * - 'auto'：跟随模式默认强制隐藏（保证跟随视线，可被手动覆盖改写）；
 *   其余模式仅当 footprint 交集成立（isCameraInsideFootprint）时淡入。
 */
export function resolveRoofTargetVisible(
  override: RoofOverrideMode,
  cameraMode: OcclusionCameraMode,
  insideFootprint: boolean,
): boolean {
  if (override === 'show') {
    return true
  }
  if (override === 'hide') {
    return false
  }
  if (cameraMode === 'follow') {
    return false
  }
  return insideFootprint
}

// ---------------------------------------------------------------------------
// 墙体（SPEC §5.5：① 相机穿透/贴近 ∪ ② 遮挡视线连线；距离驱动 + 滞后阈值）
// ---------------------------------------------------------------------------

/** 墙体淡出参数（值自 config/constants.ts 注入，可调） */
export interface WallFadeParams {
  /** 判定①：相机距墙段 ≤ 该值时不透明度降至 minOpacity（米） */
  proximityNearDistance: number
  /** 判定①：相机距墙段 ≥ 该值时完全不透明（米；near~far 之间 smoothstep 连续过渡） */
  proximityFarDistance: number
  /** 淡出最低不透明度（判定①② 并集生效时的下限，保留 ghost 可辨感） */
  minOpacity: number
  /** 判定②滞后：退出遮挡的穿越高度相对屋檐的放宽余量（米，带内保持上一状态） */
  occlusionExitHeightMargin: number
  /** 判定②滞后：已遮挡状态下墙段两端的外延余量（米，防穿越点掠过墙角时相邻两段来回切换） */
  occlusionSegmentMargin: number
}

/** 墙体判定输入（每帧由场景层装配；地图平面坐标 + 世界高度） */
export interface WallOcclusionInput {
  cameraMap: MapPoint
  cameraHeight: number
  /** 视线关注点（OrbitControls target；跟随模式为目标 AGV，场景层已统一解析） */
  targetMap: MapPoint
  targetHeight: number
  /** 屋檐高度（= 外墙高度 WALL_HEIGHT） */
  wallHeight: number
}

/** 单墙段淡出判定结果（targetOpacity 供阻尼趋近，occluding 供下一帧滞后输入） */
export interface WallFadeTarget {
  /** 判定②当前是否成立（带滞后；作为下一帧的 prevOccluding） */
  occluding: boolean
  /** 目标不透明度 ∈ [minOpacity, 1]（①② 并集取更透明者） */
  targetOpacity: number
}

/** 点到地图平面线段的最短距离（米） */
export function distanceToSegment2D(point: MapPoint, segment: MapSegment): number {
  const dx = segment.b.x - segment.a.x
  const dy = segment.b.y - segment.a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) {
    return Math.hypot(point.x - segment.a.x, point.y - segment.a.y)
  }
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - segment.a.x) * dx + (point.y - segment.a.y) * dy) / lengthSq,
    ),
  )
  return Math.hypot(point.x - (segment.a.x + t * dx), point.y - (segment.a.y + t * dy))
}

/**
 * 相机到墙段（竖直墙面）的 3D 距离：地图平面距离与超出墙顶的竖直间隙合成。
 * 相机高于屋檐时贴近墙段不再触发淡出（墙在相机下方，不挡视野）。
 */
export function distanceToWall(
  cameraMap: MapPoint,
  cameraHeight: number,
  wallHeight: number,
  segment: MapSegment,
): number {
  const planar = distanceToSegment2D(cameraMap, segment)
  const verticalGap = Math.max(0, cameraHeight - wallHeight)
  return Math.hypot(planar, verticalGap)
}

/**
 * 判定①贴近淡出的距离驱动不透明度：≤ near → minOpacity，≥ far → 1，
 * 之间 smoothstep 连续过渡（距离连续函数无离散阈值，天然不闪烁）。
 */
export function proximityOpacity(distance: number, params: WallFadeParams): number {
  const { proximityNearDistance: near, proximityFarDistance: far, minOpacity } = params
  if (distance <= near) {
    return minOpacity
  }
  if (distance >= far) {
    return 1
  }
  const t = (distance - near) / (far - near)
  const smooth = t * t * (3 - 2 * t)
  return minOpacity + (1 - minOpacity) * smooth
}

/**
 * 地图平面线段求交：视线 P→Q 与墙段（可两端外延 margin），
 * 返回视线上的交点参数 t（0=相机、1=关注点）；平行或不相交返回 null。
 */
function intersectSightLine(
  cameraMap: MapPoint,
  targetMap: MapPoint,
  segment: MapSegment,
  segmentMargin: number,
): number | null {
  let ax = segment.a.x
  let ay = segment.a.y
  let bx = segment.b.x
  let by = segment.b.y
  if (segmentMargin > 0) {
    const dx = bx - ax
    const dy = by - ay
    const length = Math.hypot(dx, dy)
    if (length > 0) {
      const ux = (dx / length) * segmentMargin
      const uy = (dy / length) * segmentMargin
      ax -= ux
      ay -= uy
      bx += ux
      by += uy
    }
  }
  const sightX = targetMap.x - cameraMap.x
  const sightY = targetMap.y - cameraMap.y
  const wallX = bx - ax
  const wallY = by - ay
  // 解 camera + t·sight = a + u·wall（2D 叉积形式）
  const denominator = sightX * wallY - sightY * wallX
  if (denominator === 0) {
    return null
  }
  const relX = ax - cameraMap.x
  const relY = ay - cameraMap.y
  const t = (relX * wallY - relY * wallX) / denominator
  const u = (relX * sightY - relY * sightX) / denominator
  if (t < 0 || t > 1 || u < 0 || u > 1) {
    return null
  }
  return t
}

/**
 * 判定②（带滞后）：相机→关注点连线是否被墙段遮挡。
 * - XZ 穿越：连线与墙段在地图平面相交；已遮挡状态下墙段两端外延
 *   occlusionSegmentMargin 再判定（退出更宽松，防墙角摆动）；
 * - 高度：穿越点处连线高度低于屋檐才遮挡（高于屋檐的视线越过墙顶）；
 *   退出阈值放宽为 屋檐 + occlusionExitHeightMargin（滞后带内保持上一状态）。
 */
export function updateWallOccluding(
  prevOccluding: boolean,
  segment: MapSegment,
  input: WallOcclusionInput,
  params: WallFadeParams,
): boolean {
  const margin = prevOccluding ? params.occlusionSegmentMargin : 0
  const t = intersectSightLine(input.cameraMap, input.targetMap, segment, margin)
  if (t === null) {
    return false
  }
  const crossingHeight = input.cameraHeight + t * (input.targetHeight - input.cameraHeight)
  return prevOccluding
    ? crossingHeight < input.wallHeight + params.occlusionExitHeightMargin
    : crossingHeight < input.wallHeight
}

/**
 * 单墙段淡出目标（SPEC §5.5 并集）：判定②遮挡 → minOpacity；
 * 否则按判定①距离驱动；两者取更透明者（minOpacity 为公共下限，天然并集）。
 * 结果写入 out 并返回 out（每帧路径零分配，场景层复用同一 out 对象）。
 */
export function resolveWallFadeTarget(
  prevOccluding: boolean,
  segment: MapSegment,
  input: WallOcclusionInput,
  params: WallFadeParams,
  out: WallFadeTarget,
): WallFadeTarget {
  const occluding = updateWallOccluding(prevOccluding, segment, input, params)
  const distance = distanceToWall(input.cameraMap, input.cameraHeight, input.wallHeight, segment)
  const proximity = proximityOpacity(distance, params)
  out.occluding = occluding
  out.targetOpacity = occluding ? params.minOpacity : proximity
  return out
}

// ---------------------------------------------------------------------------
// 立柱（SPEC §5.5：俯角超阈值或正交俯视时自动淡出）
// ---------------------------------------------------------------------------

/**
 * 相机俯角（弧度）：视线相对水平面的下倾角。
 * deltaHeight = 相机与关注点的世界高度差，horizontalDistance 为世界 XZ 水平距离
 * （高度不参与校准缩放，水平距离须取世界坐标口径，二者同构才能保证角度正确）。
 */
export function computeCameraPitchRad(deltaHeight: number, horizontalDistance: number): number {
  return Math.atan2(deltaHeight, horizontalDistance)
}

/**
 * 立柱是否淡出（SPEC §5.5）：正交俯视（topdown）恒淡出；
 * 透视模式（orbit / follow）俯角超过阈值（默认 60°，config 常量）淡出。
 */
export function shouldFadeColumns(
  cameraMode: OcclusionCameraMode,
  pitchRad: number,
  thresholdRad: number,
): boolean {
  if (cameraMode === 'topdown') {
    return true
  }
  return pitchRad > thresholdRad
}

// ---------------------------------------------------------------------------
// 不透明度阻尼（全部淡入淡出共用，帧率无关平滑过渡）
// ---------------------------------------------------------------------------

/**
 * 不透明度指数阻尼：current 以时间常数 tau（秒）趋近 target；
 * |下一步 − target| < epsilon 时吸附为 target（防渐近不收敛导致的微幅抖动与
 * visible 开关无法落定）。deltaSeconds 为帧间隔，任何帧率下过渡曲线一致。
 */
export function dampOpacity(
  current: number,
  target: number,
  deltaSeconds: number,
  tau: number,
  epsilon: number,
): number {
  const next = current + (target - current) * (1 - Math.exp(-deltaSeconds / tau))
  return Math.abs(next - target) < epsilon ? target : next
}
