/**
 * 程序化地坪工厂（视觉对齐改造：地面平面 + 程序纹理 + 受光材质）。
 *
 * 职责：按统一厂房边界生成一块接收阴影的地面平面；纹理由 Canvas
 *       2D 程序绘制——蓝灰底色、多尺度低对比斑驳、细颗粒与磨损划痕、按实际
 *       米制间距的稀疏分缝，以及独立绘制的粗糙度贴图（缎面反射变化）与凹凸
 *       贴图（缝下陷 + 颗粒微起伏）；地坪延伸至墙根，边缘保持正常受光。
 *       三张贴图共用固定随机种子，同版本视觉
 *       稳定；纹理按世界尺寸平铺（repeat = 边长/每贴图米数），不做整图拉伸。
 * 边界：本模块只产出「网格 + 材质 + 纹理」的句柄；挂载、资源代换代与释放
 *       编排归 GroundLayer。Canvas 2D 不可得（无头测试环境）时纹理降级为
 *       null，材质退为纯色 MeshStandardMaterial——缺纹理细节不缺地面实体，
 *       阴影接收与落地感保持完整（与名称图集/背景渐变同一降级口径）。
 * 关键不变量：
 * 1. 创建者释放：dispose() 幂等释放几何、材质与全部纹理；StrictMode 双卸载
 *    与视图原子替换都经同一清理路径；
 * 2. 地坪表面高度（GROUND_SURFACE_Y）低于一切既有贴花（y=0 起的充电光环、
 *    停车 slab、y≥0.012 的假阴影），亚厘米偏移换取消共面 z-fighting；
 * 3. 斑驳/划痕等「非接缝」笔触按 3×3 环绕补画，纹理四边无缝可平铺；接缝
 *    画在缝格边界（含 x=0），RepeatWrapping 下周期间距恒定；
 * 4. 粗糙度以贴图灰度为唯一事实源（材质 roughness=1 只作乘子），albedo 为
 *    SRGB 色彩空间，粗糙度/凹凸保持线性灰度——与取色管线一致。
 */
import * as THREE from 'three'
import type { SceneBounds } from '../model/types'
import {
  GROUND_BASE_COLOR,
  GROUND_BUMP_SCALE,
  GROUND_ENV_INTENSITY,
  GROUND_FALLBACK_COLOR,
  GROUND_GRAIN_ALPHA,
  GROUND_GRAIN_COUNT,
  GROUND_METALNESS,
  GROUND_MOTTLE_ALPHA,
  GROUND_MOTTLE_DARK_COLOR,
  GROUND_MOTTLE_LARGE_COUNT,
  GROUND_MOTTLE_LIGHT_COLOR,
  GROUND_MOTTLE_MID_COUNT,
  GROUND_MOTTLE_RADIUS_MAX_RATIO,
  GROUND_MOTTLE_RADIUS_MIN_RATIO,
  GROUND_ROUGHNESS_BASE,
  GROUND_ROUGHNESS_VARIATION,
  GROUND_SCUFF_ALPHA,
  GROUND_SCUFF_COUNT,
  GROUND_SCUFF_LENGTH_MAX_RATIO,
  GROUND_SCUFF_LENGTH_MIN_RATIO,
  GROUND_SEAM_DARK_ALPHA,
  GROUND_SEAM_DARK_COLOR,
  GROUND_SEAM_LIGHT_ALPHA,
  GROUND_SEAM_SPACING_M,
  GROUND_SEAM_WIDTH_PX,
  GROUND_SPECK_ALPHA,
  GROUND_SPECK_COUNT,
  GROUND_SURFACE_Y,
  GROUND_TEXTURE_MAX_ANISOTROPY,
  GROUND_TEXTURE_PX,
  GROUND_TEXTURE_SEED,
  GROUND_TEXTURE_TILE_M,
} from './mapAppearance'

/** 地坪句柄：mesh 挂入场景，dispose 释放全部 GPU 资源 */
export interface GroundSurfaceHandle {
  /** 资源代序号：每次创建递增，作为 primitive 的 key 强制走卸载/挂载路径 */
  readonly id: number
  readonly mesh: THREE.Mesh
  dispose(): void
}

/** 资源代计数器：地坪每次重建递增（与 LandmarksLayer 的 id 口径一致） */
let groundSurfaceSeq = 0

/** 地坪三张贴图：albedo（SRGB）、粗糙度（线性灰度）、凹凸（线性灰度） */
interface GroundTextures {
  readonly map: THREE.CanvasTexture
  readonly roughnessMap: THREE.CanvasTexture
  readonly bumpMap: THREE.CanvasTexture
}

/** sRGB 十六进制色的 0-255 分量（Canvas 绘制全程使用原始 sRGB 值） */
interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** 固定种子的 mulberry32 PRNG：纹理绘制全程唯一的随机源 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

/** 灰度色的 rgba() 字符串（灰度图三通道相等） */
function gray(value: number, alpha: number): string {
  const v = Math.round(value)
  return `rgba(${v}, ${v}, ${v}, ${alpha})`
}

/** 3×3 平铺偏移：跨画布边缘的笔触在对侧补画，保证纹理可无缝平铺 */
const WRAP_OFFSETS: readonly (readonly [number, number])[] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [0, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
]

/**
 * 创建贴墙地坪：传入的包围盒已经是厂房范围，不再单独外扩或压暗边缘。
 * 表面略低于零平面以避免贴花闪烁，纹理不可用时仍保留受光和阴影接收。
 */
export function createGroundSurface(
  bounds: SceneBounds,
  maxAnisotropy = 1,
): GroundSurfaceHandle {
  const width = bounds.maxWorldX - bounds.minWorldX
  const depth = bounds.maxWorldZ - bounds.minWorldZ

  /**
   * 墙体负责地坪收边，取消边缘渐黑所需的细分网格与顶点色。
   * 保留原有米制纹理，近景细节不因厂房尺寸扩大而拉伸。
   */
  const geometry = new THREE.PlaneGeometry(width, depth)
  geometry.rotateX(-Math.PI / 2)

  const textures = createGroundTextures(width, depth, maxAnisotropy)
  const material =
    textures !== null
      ? new THREE.MeshStandardMaterial({
          // albedo 全部来自贴图；roughnessMap 灰度即最终粗糙度（乘子 = 1）；
          map: textures.map,
          roughnessMap: textures.roughnessMap,
          bumpMap: textures.bumpMap,
          bumpScale: GROUND_BUMP_SCALE,
          roughness: 1,
          metalness: GROUND_METALNESS,
          envMapIntensity: GROUND_ENV_INTENSITY,
        })
      : new THREE.MeshStandardMaterial({
          color: GROUND_FALLBACK_COLOR,
          roughness: GROUND_ROUGHNESS_BASE,
          metalness: GROUND_METALNESS,
          envMapIntensity: GROUND_ENV_INTENSITY,
        })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'map-ground-surface'
  mesh.position.set(bounds.centerWorldX, GROUND_SURFACE_Y, bounds.centerWorldZ)
  mesh.matrixAutoUpdate = false
  mesh.updateMatrix()
  // 落地感（对象落地）：地面只接收车辆/充电桩的实时阴影，自身不投
  mesh.castShadow = false
  mesh.receiveShadow = true

  let disposed = false
  groundSurfaceSeq += 1
  return {
    id: groundSurfaceSeq,
    mesh,
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      geometry.dispose()
      material.dispose()
      if (textures !== null) {
        textures.map.dispose()
        textures.roughnessMap.dispose()
        textures.bumpMap.dispose()
      }
    },
  }
}

/** 建一张 GROUND_TEXTURE_PX 见方的画布；Canvas 2D 不可得时返回 null */
function createGroundCanvas(): CanvasRenderingContext2D | null {
  const canvas = document.createElement('canvas')
  canvas.width = GROUND_TEXTURE_PX
  canvas.height = GROUND_TEXTURE_PX
  return canvas.getContext('2d')
}

/** 生成三张程序纹理并按世界尺寸设置平铺；Canvas 不可用时返回 null（纯色降级） */
function createGroundTextures(
  widthM: number,
  depthM: number,
  maxAnisotropy: number,
): GroundTextures | null {
  const albedoCtx = createGroundCanvas()
  const roughnessCtx = createGroundCanvas()
  const bumpCtx = createGroundCanvas()
  if (albedoCtx === null || roughnessCtx === null || bumpCtx === null) {
    return null
  }

  const rnd = mulberry32(GROUND_TEXTURE_SEED)
  paintAlbedo(albedoCtx, rnd)
  paintRoughnessMap(roughnessCtx, rnd)
  paintBumpMap(bumpCtx, mulberry32(GROUND_TEXTURE_SEED + 1))

  const repeatX = widthM / GROUND_TEXTURE_TILE_M
  const repeatY = depthM / GROUND_TEXTURE_TILE_M
  const anisotropy = Math.min(GROUND_TEXTURE_MAX_ANISOTROPY, maxAnisotropy)
  return {
    map: toTiledTexture(albedoCtx.canvas, true, repeatX, repeatY, anisotropy),
    roughnessMap: toTiledTexture(roughnessCtx.canvas, false, repeatX, repeatY, anisotropy),
    bumpMap: toTiledTexture(bumpCtx.canvas, false, repeatX, repeatY, anisotropy),
  }
}

/** Canvas → 可平铺纹理；albedo 为 SRGB，粗糙度/凹凸保持线性灰度 */
function toTiledTexture(
  canvas: HTMLCanvasElement,
  srgb: boolean,
  repeatX: number,
  repeatY: number,
  anisotropy: number,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas)
  if (srgb) {
    texture.colorSpace = THREE.SRGBColorSpace
  }
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(repeatX, repeatY)
  texture.anisotropy = anisotropy
  return texture
}

/** 缝格边界位置（px）：均匀分缝，x=0 一条自然承担平铺接边 */
function seamPositions(): number[] {
  const cells = GROUND_TEXTURE_TILE_M / GROUND_SEAM_SPACING_M
  const step = GROUND_TEXTURE_PX / cells
  return Array.from({ length: cells }, (_, i) => Math.round(i * step))
}

/* ==================== albedo：底色 + 斑驳 + 划痕 + 接缝 + 颗粒 ==================== */

function paintAlbedo(ctx: CanvasRenderingContext2D, rnd: () => number): void {
  const size = GROUND_TEXTURE_PX
  ctx.fillStyle = GROUND_BASE_COLOR
  ctx.fillRect(0, 0, size, size)

  // 多尺度低对比斑驳：大尺度云斑定「深浅变化」，中尺度色块打破均匀感
  const light = hexToRgb(GROUND_MOTTLE_LIGHT_COLOR)
  const dark = hexToRgb(GROUND_MOTTLE_DARK_COLOR)
  paintMottle(ctx, rnd, light, GROUND_MOTTLE_LARGE_COUNT, 0.16, GROUND_MOTTLE_ALPHA * 1.2)
  paintMottle(ctx, rnd, dark, GROUND_MOTTLE_LARGE_COUNT, 0.16, GROUND_MOTTLE_ALPHA * 1.2)
  paintMottle(ctx, rnd, light, GROUND_MOTTLE_MID_COUNT, 0.03, GROUND_MOTTLE_ALPHA)
  paintMottle(ctx, rnd, dark, GROUND_MOTTLE_MID_COUNT, 0.03, GROUND_MOTTLE_ALPHA)

  // 磨损划痕（接缝之前）：叉车/托盘拖拽留下的低对比条痕，明暗随机
  paintScuffs(ctx, rnd, light, dark)

  // 稀疏分缝：按实际米制间距（缝格边界，含 x=0，平铺周期间距恒定）
  const seamDark = hexToRgb(GROUND_SEAM_DARK_COLOR)
  paintSeams(
    ctx,
    `rgba(${seamDark.r}, ${seamDark.g}, ${seamDark.b}, ${GROUND_SEAM_DARK_ALPHA})`,
    `rgba(${light.r}, ${light.g}, ${light.b}, ${GROUND_SEAM_LIGHT_ALPHA})`,
  )

  // 细颗粒最后统一压一遍：远看融为灰面，近看是混凝土骨料
  paintGrain(ctx, rnd, light, dark)
}

/** 单尺度斑驳：径向渐变从色斑衰变到透明，按 3×3 环绕绘制保证可平铺 */
function paintMottle(
  ctx: CanvasRenderingContext2D,
  rnd: () => number,
  color: Rgb,
  count: number,
  minRadiusRatio: number,
  maxAlpha: number,
): void {
  const size = GROUND_TEXTURE_PX
  for (let i = 0; i < count; i += 1) {
    const radius =
      size * (minRadiusRatio + rnd() * (GROUND_MOTTLE_RADIUS_MAX_RATIO - minRadiusRatio))
    const x = rnd() * size
    const y = rnd() * size
    const alpha = maxAlpha * (0.5 + rnd() * 0.5)
    for (const [ox, oy] of WRAP_OFFSETS) {
      const cx = x + ox * size
      const cy = y + oy * size
      if (cx + radius < 0 || cx - radius > size || cy + radius < 0 || cy - radius > size) {
        continue
      }
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
      gradient.addColorStop(0, `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha.toFixed(3)})`)
      gradient.addColorStop(1, `rgba(${color.r}, ${color.g}, ${color.b}, 0)`)
      ctx.fillStyle = gradient
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2)
    }
  }
}

/** 磨损划痕：细长椭圆，随机角度与明暗（抛亮/积灰），3×3 环绕保证可平铺 */
function paintScuffs(
  ctx: CanvasRenderingContext2D,
  rnd: () => number,
  light: Rgb,
  dark: Rgb,
): void {
  const size = GROUND_TEXTURE_PX
  for (let i = 0; i < GROUND_SCUFF_COUNT; i += 1) {
    const length =
      size *
      (GROUND_SCUFF_LENGTH_MIN_RATIO +
        rnd() * (GROUND_SCUFF_LENGTH_MAX_RATIO - GROUND_SCUFF_LENGTH_MIN_RATIO))
    const width = 2 + rnd() * 5
    const x = rnd() * size
    const y = rnd() * size
    const rotation = rnd() * Math.PI
    const color = rnd() < 0.45 ? light : dark
    const alpha = GROUND_SCUFF_ALPHA * (0.5 + rnd() * 0.5)
    paintWrappedEllipse(ctx, x, y, length / 2, width / 2, rotation, color, alpha)
  }
}

/** 画一枚 3×3 环绕补画的细长椭圆（划痕及其它软笔触共用） */
function paintWrappedEllipse(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radiusX: number,
  radiusY: number,
  rotation: number,
  color: Rgb,
  alpha: number,
): void {
  const size = GROUND_TEXTURE_PX
  const reach = radiusX + radiusY
  for (const [ox, oy] of WRAP_OFFSETS) {
    const cx = x + ox * size
    const cy = y + oy * size
    if (cx + reach < 0 || cx - reach > size || cy + reach < 0 || cy - reach > size) {
      continue
    }
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(rotation)
    ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha.toFixed(3)})`
    ctx.beginPath()
    ctx.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}

/** 接缝通版：暗缝主体 + 外侧 1px 受光亮边（albedo 与凹凸共用布局） */
function paintSeams(ctx: CanvasRenderingContext2D, darkStyle: string, lightStyle: string): void {
  const size = GROUND_TEXTURE_PX
  for (const p of seamPositions()) {
    ctx.fillStyle = darkStyle
    ctx.fillRect(p, 0, GROUND_SEAM_WIDTH_PX, size)
    ctx.fillRect(0, p, size, GROUND_SEAM_WIDTH_PX)
    ctx.fillStyle = lightStyle
    ctx.fillRect(p + GROUND_SEAM_WIDTH_PX, 0, 1, size)
    ctx.fillRect(0, p + GROUND_SEAM_WIDTH_PX, size, 1)
  }
}

/** 细颗粒 + 稀疏较大磨损点：1px 点画，最后统一覆盖全部笔触 */
function paintGrain(
  ctx: CanvasRenderingContext2D,
  rnd: () => number,
  light: Rgb,
  dark: Rgb,
): void {
  const size = GROUND_TEXTURE_PX
  for (let i = 0; i < GROUND_GRAIN_COUNT; i += 1) {
    const color = rnd() < 0.5 ? light : dark
    const alpha = GROUND_GRAIN_ALPHA * (0.4 + rnd() * 0.6)
    ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha.toFixed(3)})`
    ctx.fillRect(rnd() * size, rnd() * size, 1, 1)
  }
  for (let i = 0; i < GROUND_SPECK_COUNT; i += 1) {
    const alpha = GROUND_SPECK_ALPHA * (0.5 + rnd() * 0.5)
    ctx.fillStyle = `rgba(${dark.r}, ${dark.g}, ${dark.b}, ${alpha.toFixed(3)})`
    const speck = rnd() < 0.8 ? 1 : 2
    ctx.fillRect(rnd() * size, rnd() * size, speck, speck)
  }
}

/* ==================== 粗糙度贴图：缎面反射的强弱变化 ==================== */

/**
 * 粗糙度（灰度，材质 roughness=1 只作乘子）：基准 GROUND_ROUGHNESS_BASE，
 * 中尺度软斑在 ±GROUND_ROUGHNESS_VARIATION 内摆动——亮斑 = 更糙的灰蒙区，
 * 暗斑 = 被磨得略亮的通道；接缝积灰更糙，划痕带一点抛光。
 */
function paintRoughnessMap(ctx: CanvasRenderingContext2D, rnd: () => number): void {
  const size = GROUND_TEXTURE_PX
  ctx.fillStyle = gray(GROUND_ROUGHNESS_BASE * 255, 1)
  ctx.fillRect(0, 0, size, size)

  // 中尺度粗糙度软斑：一半更糙（亮）、一半更滑（暗），幅度受限保持缎面
  for (let i = 0; i < GROUND_MOTTLE_MID_COUNT; i += 1) {
    const value = rnd() < 0.5 ? 255 : 0
    const alpha = (GROUND_ROUGHNESS_VARIATION / 2) * (0.4 + rnd() * 0.6)
    const radius = size * (GROUND_MOTTLE_RADIUS_MIN_RATIO + rnd() * 0.22)
    const x = rnd() * size
    const y = rnd() * size
    for (const [ox, oy] of WRAP_OFFSETS) {
      const cx = x + ox * size
      const cy = y + oy * size
      if (cx + radius < 0 || cx - radius > size || cy + radius < 0 || cy - radius > size) {
        continue
      }
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
      gradient.addColorStop(0, gray(value, alpha))
      gradient.addColorStop(1, gray(value, 0))
      ctx.fillStyle = gradient
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2)
    }
  }

  // 划痕带轻微抛光（更滑 = 更暗）：与 albedo 划痕无关的独立随机分布
  for (let i = 0; i < GROUND_SCUFF_COUNT / 2; i += 1) {
    const length =
      size *
      (GROUND_SCUFF_LENGTH_MIN_RATIO +
        rnd() * (GROUND_SCUFF_LENGTH_MAX_RATIO - GROUND_SCUFF_LENGTH_MIN_RATIO))
    const width = 2 + rnd() * 5
    paintWrappedEllipseGray(
      ctx,
      rnd() * size,
      rnd() * size,
      length / 2,
      width / 2,
      rnd() * Math.PI,
      0,
      0.06 * (0.5 + rnd() * 0.5),
    )
  }

  // 接缝积灰更糙（亮）
  paintSeams(ctx, gray(255, 0.12), gray(0, 0))

  // 轻微颗粒噪声，避免粗糙度在大面积上完全均匀
  for (let i = 0; i < GROUND_GRAIN_COUNT / 3; i += 1) {
    ctx.fillStyle = gray(rnd() < 0.5 ? 255 : 0, 0.03)
    ctx.fillRect(rnd() * size, rnd() * size, 1, 1)
  }
}

/** paintWrappedEllipse 的灰度版（粗糙度/凹凸贴图使用） */
function paintWrappedEllipseGray(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radiusX: number,
  radiusY: number,
  rotation: number,
  value: number,
  alpha: number,
): void {
  const size = GROUND_TEXTURE_PX
  const reach = radiusX + radiusY
  for (const [ox, oy] of WRAP_OFFSETS) {
    const cx = x + ox * size
    const cy = y + oy * size
    if (cx + reach < 0 || cx - reach > size || cy + reach < 0 || cy - reach > size) {
      continue
    }
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(rotation)
    ctx.fillStyle = gray(value, alpha)
    ctx.beginPath()
    ctx.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}

/* ==================== 凹凸贴图：接缝下陷 + 颗粒微起伏 ==================== */

/**
 * 凹凸（灰度即相对高度，中灰为基准面）：接缝为下陷的暗缝 + 一侧亮沿
 * （凸起的缝沿受光），细颗粒给出微弱的表面起伏；bumpScale 控制实际强度。
 */
function paintBumpMap(ctx: CanvasRenderingContext2D, rnd: () => number): void {
  const size = GROUND_TEXTURE_PX
  ctx.fillStyle = gray(128, 1)
  ctx.fillRect(0, 0, size, size)

  // 大尺度极低对比起伏：地坪不完全平整的「波浪」感
  for (let i = 0; i < GROUND_MOTTLE_LARGE_COUNT; i += 1) {
    const value = rnd() < 0.5 ? 255 : 0
    const radius = size * (0.16 + rnd() * 0.16)
    const x = rnd() * size
    const y = rnd() * size
    for (const [ox, oy] of WRAP_OFFSETS) {
      const cx = x + ox * size
      const cy = y + oy * size
      if (cx + radius < 0 || cx - radius > size || cy + radius < 0 || cy - radius > size) {
        continue
      }
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
      gradient.addColorStop(0, gray(value, 0.05))
      gradient.addColorStop(1, gray(value, 0))
      ctx.fillStyle = gradient
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2)
    }
  }

  // 接缝：2px 下陷暗缝 + 外侧 1px 亮沿
  paintSeams(ctx, gray(0, 0.32), gray(255, 0.12))

  // 细颗粒微起伏：比 albedo 更稀更淡，只提供掠射角下的细碎明暗
  for (let i = 0; i < GROUND_GRAIN_COUNT / 2; i += 1) {
    ctx.fillStyle = gray(rnd() < 0.5 ? 255 : 0, 0.06)
    ctx.fillRect(rnd() * size, rnd() * size, 1, 1)
  }
}
