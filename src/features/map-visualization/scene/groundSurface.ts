/**
 * 石墨灰金属地板：米制板缝、方向性抛磨和近景浅划痕。
 * 颜色、粗糙度、法线分别描述反射率和微表面，不烘焙高光或倒影。
 * 标准金属受光保持真实视向，保留地面高度和创建者释放约定。
 */
import * as THREE from 'three'
import type { SceneBounds } from '../model/types'
import {
  GROUND_BASE_COLOR,
  GROUND_NORMAL_SCALE,
  GROUND_ENV_INTENSITY,
  GROUND_FALLBACK_COLOR,
  GROUND_METALNESS,
  GROUND_ROUGHNESS_BASE,
  GROUND_ROUGHNESS_VARIATION,
  GROUND_SCUFF_COUNT,
  GROUND_SEAM_SPACING_M,
  GROUND_SEAM_WIDTH_M,
  GROUND_SEAM_DARK_ALPHA,
  GROUND_SURFACE_Y,
  GROUND_TEXTURE_MAX_ANISOTROPY,
  GROUND_TEXTURE_PX,
  GROUND_TEXTURE_SEED,
  GROUND_TEXTURE_TILE_M,
  GROUND_DETAIL_TILE_M,
} from './mapAppearance'

/**
 * 句柄拥有几何、材质及三张程序纹理；调用方只负责挂载与移除。
 * 幂等释放适配严格模式以及视图资源换代。
 */
export interface GroundSurfaceHandle {
  readonly id: number
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>
  dispose(): void
}
let groundSurfaceSeq = 0

/**
 * 反射率与抛磨纹理使用二十四米周期，微法线使用独立的两米周期。
 * 几何扩大不会拉伸纹理，远景由各向异性过滤与降采样自然淡化细节。
 */
interface GroundTextures {
  readonly map: THREE.CanvasTexture
  readonly roughnessMap: THREE.CanvasTexture
  readonly normalMap: THREE.CanvasTexture
}

/**
 * 固定随机种子保证刷新和资源重建后的磨损一致。
 * 抛磨分布与浅划痕共用种子约定，资源重建不会随机改变外观。
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 地面包围盒和高度沿用现有布局，继续接收实体阴影。
 * 二维画布不可用时回退为相同参数的纯色金属。
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
  /**
   * 各张纹理锚定世界原点，扩大厂房边界时纹理和板缝不会滑动。
   * 旋转后的平面纵向纹理坐标朝向负世界轴，因此从上边界取反偏移。
   */
  if (textures !== null) {
    for (const texture of Object.values(textures)) {
      texture.offset.set(bounds.minWorldX * texture.repeat.x / width, -bounds.maxWorldZ * texture.repeat.y / depth)
    }
  }
  const material =
    textures !== null
      ? new THREE.MeshStandardMaterial({
          /**
           * 材质提供钢板底色，颜色图只描述低对比的反射率变化。
           * 粗糙度图保存最终线性数值，乘子保持一；不绑定金属度贴图。
           */
          color: GROUND_BASE_COLOR,
          map: textures.map,
          roughnessMap: textures.roughnessMap,
          normalMap: textures.normalMap,
          normalScale: new THREE.Vector2(GROUND_NORMAL_SCALE, GROUND_NORMAL_SCALE),
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

  /**
   * 墙根接触明暗按实际厂房边界求值，不依赖覆盖全厂的实时阴影分辨率。
   * 窄暗边表现接触，外侧宽柔光对应墙边灯槽；质量降级后仍保留围合层次。
   */
  const boundary = new THREE.Vector4(bounds.minWorldX, bounds.maxWorldX, bounds.minWorldZ, bounds.maxWorldZ)
  material.onBeforeCompile = (shader) => {
    /**
     * 板缝以世界米制坐标解析求值，覆盖率过滤避免总览闪烁或贴图缩小后消失。
     * 只改变缝内反射率与粗糙度，保留标准观察方向、法线和金属光照方程。
     */
    shader.uniforms.groundBoundary = { value: boundary }
    shader.uniforms.groundPanelSize = { value: GROUND_SEAM_SPACING_M }
    shader.uniforms.groundSeamWidth = { value: GROUND_SEAM_WIDTH_M }
    shader.uniforms.groundSeamDarkness = { value: GROUND_SEAM_DARK_ALPHA }
    shader.vertexShader = `varying vec3 vGroundPosition;\n${shader.vertexShader}`.replace('#include <project_vertex>', `#include <project_vertex>\nvGroundPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`)
    shader.fragmentShader = `uniform vec4 groundBoundary;
uniform float groundPanelSize;
uniform float groundSeamWidth;
uniform float groundSeamDarkness;
varying vec3 vGroundPosition;
${shader.fragmentShader}`.replace('#include <map_fragment>', `#include <map_fragment>
// 对窄缝在像素足迹内积分，低角度不把亚像素线条放大成粗黑网格。
// 多块面板落入同一像素时，缝隙趋向真实的平均覆盖率。
vec2 panelUv = fract(vGroundPosition.xz / groundPanelSize);
vec2 seamDistance = min(panelUv, 1.0 - panelUv) * groundPanelSize;
vec2 footprint = max(fwidth(vGroundPosition.xz), vec2(0.0001));
vec2 seamCoverage = clamp((groundSeamWidth * 0.5 - seamDistance) / footprint + 0.5, 0.0, 1.0)
  - clamp((-groundSeamWidth * 0.5 - seamDistance) / footprint + 0.5, 0.0, 1.0);
seamCoverage = mix(seamCoverage, vec2(groundSeamWidth / groundPanelSize), smoothstep(vec2(groundPanelSize * 0.5), vec2(groundPanelSize), footprint));
float groundSeam = 1.0 - (1.0 - seamCoverage.x) * (1.0 - seamCoverage.y);
diffuseColor.rgb *= 1.0 - groundSeam * groundSeamDarkness;
`).replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
// 接缝里的氧化面更粗糙，反光随同一缝隙遮罩衰减。
// 其余钢板保持纹理驱动的标准微表面参数。
roughnessFactor = mix(roughnessFactor, 0.86, groundSeam);
`).replace('#include <opaque_fragment>', `
// 金属高光来自标准环境受光，反射钩子补充局部实体倒影。
// 接触阴影沿墙根连续衰减，灯槽的柔光与地坪反射分开计算。
vec2 wallDistances = min(vGroundPosition.xz - groundBoundary.xz, groundBoundary.yw - vGroundPosition.xz);
float wallDistance = max(0.0, min(wallDistances.x, wallDistances.y));
float wallContact = exp(-wallDistance * 3.8) * 0.24 + exp(-wallDistance * 0.75) * 0.07;
// 距墙不足零点八五米时偏移为负，GLSL 的 pow 对负底数未定义，即使指数是二。
// 显式相乘保留原高斯曲线，避免无效颜色进入半浮点画面并被光晕扩大。
float wallWashOffset = (wallDistance - 0.85) / 1.4;
float wallWash = exp(-(wallWashOffset * wallWashOffset)) * 0.055;
outgoingLight = outgoingLight * (1.0 - wallContact) + vec3(1.0, 0.72, 0.40) * wallWash * 0.24;
#include <opaque_fragment>`)
  }
  /**
   * 米制板缝补丁使用独立程序键，地坪叠加反射后也不能命中旧的受光程序。
   * 材质和纹理的所有权保持不变，资源换代仍由地坪句柄统一回收。
   */
  material.customProgramCacheKey = () => 'industrial-floor-steel-v8'

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
        textures.normalMap.dispose()
      }
    },
  }
}

/**
 * 创建固定尺寸的二维画布；无画布环境保持原来的纯色回退能力。
 * 纹理只在资源建立时生成，不占用逐帧渲染预算。
 */
function createGroundCanvas(): CanvasRenderingContext2D | null {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = GROUND_TEXTURE_PX
  return canvas.getContext('2d')
}

/**
 * 三张纹理按各自世界尺寸平铺，粗糙度与法线保持线性色彩空间。
 * 抛磨改变高光形态，颜色仅有很小的反射率差异，避免地板变成斑驳水泥。
 */
function createGroundTextures(widthM: number, depthM: number, maxAnisotropy: number): GroundTextures | null {
  const albedo = createGroundCanvas()
  const roughness = createGroundCanvas()
  const height = createGroundCanvas()
  if (!albedo || !roughness || !height) return null
  paintSurfaceMaps(albedo, roughness)
  paintBrushedHeight(height)
  const anisotropy = Math.min(GROUND_TEXTURE_MAX_ANISOTROPY, maxAnisotropy)
  return {
    map: toTiledTexture(albedo.canvas, true, widthM / GROUND_TEXTURE_TILE_M, depthM / GROUND_TEXTURE_TILE_M, anisotropy),
    roughnessMap: toTiledTexture(roughness.canvas, false, widthM / GROUND_TEXTURE_TILE_M, depthM / GROUND_TEXTURE_TILE_M, anisotropy),
    normalMap: toTiledTexture(createNormalCanvas(height), false, widthM / GROUND_DETAIL_TILE_M, depthM / GROUND_DETAIL_TILE_M, anisotropy),
  }
}

/**
 * 颜色图为标准颜色空间，其余数据图不经过颜色转换。
 * 环绕采样和降采样过滤避免远景拉丝产生摩尔纹。
 */
function toTiledTexture(canvas: HTMLCanvasElement, srgb: boolean, repeatX: number, repeatY: number, anisotropy: number): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(repeatX, repeatY)
  texture.anisotropy = anisotropy
  return texture
}

/**
 * 周期性值噪声使用环绕格点，所有尺度在纹理四边连续。
 * 不等宽的格点形成短段抛磨纹，避免平行整线或规则正弦纹被误认作木纹。
 */
function surfaceNoise(u: number, v: number, columns: number, rows: number): number {
  const x = u * columns
  const y = v * rows
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const hash = (px: number, py: number) => {
    let value = Math.imul((px + columns) % columns, 374761393) ^ Math.imul((py + rows) % rows, 668265263) ^ GROUND_TEXTURE_SEED
    value = Math.imul(value ^ (value >>> 13), 1274126177)
    return ((value ^ (value >>> 16)) >>> 0) / 4294967295
  }
  const a = hash(ix, iy) * (1 - sx) + hash(ix + 1, iy) * sx
  const b = hash(ix, iy + 1) * (1 - sx) + hash(ix + 1, iy + 1) * sx
  return a * (1 - sy) + b * sy - 0.5
}

/**
 * 同步生成钢板反射率与粗糙度，面板间的轻微加工差异共用确定性随机种子。
 * 厘米级磨痕主要放在粗糙度图中，只有光线照到时才显出明暗层次。
 */
function paintSurfaceMaps(albedo: CanvasRenderingContext2D, roughness: CanvasRenderingContext2D): void {
  const size = GROUND_TEXTURE_PX
  const colorPixels = albedo.createImageData(size, size)
  const roughPixels = roughness.createImageData(size, size)
  const panelCount = GROUND_TEXTURE_TILE_M / GROUND_SEAM_SPACING_M
  const rnd = mulberry32(GROUND_TEXTURE_SEED)
  const panels = Array.from({ length: panelCount * panelCount }, () => rnd() - 0.5)
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const u = x / size
    const v = y / size
    const panel = panels[Math.floor(v * panelCount) * panelCount + Math.floor(u * panelCount)]
    const broad = surfaceNoise(u, v, 32, 32)
    const brushed = surfaceNoise(u, v, 128, 512)
    const fine = surfaceNoise(u, v, 256, 256)
    const color = Math.round((0.955 + panel * 0.026 + broad * 0.024 + brushed * 0.012) * 255)
    const rough = Math.round((GROUND_ROUGHNESS_BASE + panel * 0.025 + (broad * 0.55 + brushed * 0.4 + fine * 0.3) * GROUND_ROUGHNESS_VARIATION) * 255)
    const index = (y * size + x) * 4
    colorPixels.data[index] = colorPixels.data[index + 1] = colorPixels.data[index + 2] = color
    roughPixels.data[index] = roughPixels.data[index + 1] = roughPixels.data[index + 2] = rough
    colorPixels.data[index + 3] = roughPixels.data[index + 3] = 255
  }
  albedo.putImageData(colorPixels, 0, 0)
  roughness.putImageData(roughPixels, 0, 0)
}

/**
 * 每像素约两毫米；低对比平行微纹只改变高度，不改变底色。
 * 浅划痕跨边缘时在对侧补画，保持环绕采样下的法线连续。
 */
function paintBrushedHeight(ctx: CanvasRenderingContext2D): void {
  const size = GROUND_TEXTURE_PX
  const rnd = mulberry32(GROUND_TEXTURE_SEED)
  const pixels = ctx.createImageData(size, size)
  const base = 0.5
  const variation = 0.035
  for (let y = 0; y < size; y += 1) {
    const strand = (rnd() - 0.5) * variation
    for (let x = 0; x < size; x += 1) {
      const value = Math.round((base + strand + (rnd() - 0.5) * variation * 0.35) * 255)
      const index = (y * size + x) * 4
      pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = value
      pixels.data[index + 3] = 255
    }
  }
  ctx.putImageData(pixels, 0, 0)
  for (let i = 0; i < GROUND_SCUFF_COUNT; i += 1) {
    const x = rnd() * size
    const y = rnd() * size
    const length = (0.06 + rnd() * 0.22) / GROUND_DETAIL_TILE_M * size
    const slope = (rnd() - 0.5) * 0.12
    const value = Math.round(0.47 * 255)
    ctx.strokeStyle = 'rgb(' + value + ',' + value + ',' + value + ')'
    ctx.lineWidth = 0.45 + rnd() * 0.35
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
      ctx.beginPath()
      ctx.moveTo(x + ox, y + oy)
      ctx.lineTo(x + ox + length, y + oy + length * slope)
      ctx.stroke()
    }
  }
}

/**
 * 从周期高度场求中心差分，四边使用环绕邻点，得到可无缝平铺的切线法线。
 * 法线数据保持线性色彩空间，细颗粒只提供微表面起伏。
 */
function createNormalCanvas(source: CanvasRenderingContext2D): HTMLCanvasElement {
  const size = source.canvas.width
  const data = source.getImageData(0, 0, size, size).data
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const pixels = ctx.createImageData(size, size)
  const height = (x: number, y: number) => data[(((y + size) % size) * size + (x + size) % size) * 4] / 255
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const nx = (height(x - 1, y) - height(x + 1, y)) * 3
    const ny = (height(x, y - 1) - height(x, y + 1)) * 3
    const length = Math.hypot(nx, ny, 1)
    const index = (y * size + x) * 4
    pixels.data[index] = (nx / length * 0.5 + 0.5) * 255
    pixels.data[index + 1] = (ny / length * 0.5 + 0.5) * 255
    pixels.data[index + 2] = (1 / length * 0.5 + 0.5) * 255
    pixels.data[index + 3] = 255
  }
  ctx.putImageData(pixels, 0, 0)
  return canvas
}
