/**
 * 厂房地坪 Box 与 6m 分缝几何构建（SPEC §6.2、§4.3）。
 *
 * 纯函数、无 DOM；顶点直接烘焙世界坐标（mesh 位于原点，无二次变换）。
 * - 地坪 Box：顶面 y=0、厚 FLOOR_THICKNESS=0.3m；仅顶面使用世界坐标 UV
 *  （u=x/12、v=z/12，每 12m 重复一次，配合 RepeatWrapping）；侧面/底面 UV 全部
 *   采样程序纹理的纯净基色 texel（floorTexture.ts 的保留 texel），侧面无纹理同色，
 *   整个地坪保持单 mesh 单 draw call（§6.2、§6.7）。
 * - 分缝：6m×6m 世界对齐切缝（宽 0.02m 细条，y=+0.002），写入单一 BufferGeometry；
 *   与边界重合的缝被墙体覆盖，不生成；polygonOffset 第二道保险由渲染层材质
 *   负责（§4.3）。
 */

import { BufferAttribute, BufferGeometry } from 'three'

import type { FactoryBoundsDto } from '../../../application/factorySceneModel'
import { FLOOR_JOINT } from '../../../config/sceneMetrics'
import { FLOOR_TEXTURE_SIZE, floorTextureCleanTexelUv } from './floorTexture'

/** 地坪板厚度（§6.2：0.3m，未列入 §13 配置表，唯一定义于此） */
export const FLOOR_THICKNESS = 0.3

/** 顶面世界坐标 UV 重复周期（§6.2：每 12m 重复一次） */
export const FLOOR_TEXTURE_REPEAT_METERS = 12

/** 分缝细条宽度（§6.2：0.02m） */
export const FLOOR_JOINT_WIDTH = 0.02

/** 分缝层 y 偏移（§4.3：+0.002；polygonOffset 由渲染层材质负责） */
export const FLOOR_JOINT_Y = 0.002

type Vec3 = readonly [number, number, number]
type Vec2 = readonly [number, number]

/** 生长中的几何数据（uv 为 null 时不写 uv attribute——无贴图材质不需要） */
interface GeometryBuild {
  readonly positions: number[]
  readonly normals: number[]
  readonly uvs: number[] | null
  readonly indices: number[]
}

/**
 * 追加一个四边形（两个三角形）。corners 必须按从法线侧看逆时针（CCW）排序，
 * 与 three 的正面绕序约定一致；测试按 (v1-v0)×(v2-v0) 与法线点积 > 0 校验全部面。
 */
function appendQuad(
  build: GeometryBuild,
  corners: readonly [Vec3, Vec3, Vec3, Vec3],
  normal: Vec3,
  uvs: readonly [Vec2, Vec2, Vec2, Vec2] | null,
): void {
  const base = build.positions.length / 3
  for (let i = 0; i < 4; i += 1) {
    build.positions.push(corners[i][0], corners[i][1], corners[i][2])
    build.normals.push(normal[0], normal[1], normal[2])
    if (build.uvs !== null && uvs !== null) {
      build.uvs.push(uvs[i][0], uvs[i][1])
    }
  }
  build.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
}

function toBufferGeometry(build: GeometryBuild): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(build.positions), 3))
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(build.normals), 3))
  if (build.uvs !== null) {
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(build.uvs), 2))
  }
  geometry.setIndex(new BufferAttribute(new Uint32Array(build.indices), 1))
  return geometry
}

/** 严格位于 (min, max) 内的 step 整数倍坐标（世界对齐；边界重合值除外） */
function strictInteriorMultiples(min: number, max: number, step: number): number[] {
  const values: number[] = []
  for (let k = Math.ceil(min / step); k <= Math.floor(max / step); k += 1) {
    const value = k * step
    if (value > min && value < max) values.push(value)
  }
  return values
}

/**
 * 厂房地坪 Box：顶面 y=0、底面 y=-FLOOR_THICKNESS，水平范围 = 厂房内空边界。
 * 顶面世界坐标 UV 每 12m 重复；侧面/底面 UV 采样纯净基色 texel。
 */
export function buildFloorGeometry(bounds: FactoryBoundsDto): BufferGeometry {
  const { innerMinX: minX, innerMaxX: maxX, innerMinZ: minZ, innerMaxZ: maxZ } = bounds
  const bottom = -FLOOR_THICKNESS
  const [cleanU, cleanV] = floorTextureCleanTexelUv(FLOOR_TEXTURE_SIZE)
  const cleanUvs: readonly [Vec2, Vec2, Vec2, Vec2] = [
    [cleanU, cleanV],
    [cleanU, cleanV],
    [cleanU, cleanV],
    [cleanU, cleanV],
  ]
  const worldUv = (x: number, z: number): Vec2 => [
    x / FLOOR_TEXTURE_REPEAT_METERS,
    z / FLOOR_TEXTURE_REPEAT_METERS,
  ]

  const build: GeometryBuild = { positions: [], normals: [], uvs: [], indices: [] }
  // 顶面（+Y）：唯一带世界坐标 UV 的面
  appendQuad(
    build,
    [
      [minX, 0, minZ],
      [minX, 0, maxZ],
      [maxX, 0, maxZ],
      [maxX, 0, minZ],
    ],
    [0, 1, 0],
    [
      worldUv(minX, minZ),
      worldUv(minX, maxZ),
      worldUv(maxX, maxZ),
      worldUv(maxX, minZ),
    ],
  )
  // 底面（-Y）
  appendQuad(
    build,
    [
      [minX, bottom, maxZ],
      [minX, bottom, minZ],
      [maxX, bottom, minZ],
      [maxX, bottom, maxZ],
    ],
    [0, -1, 0],
    cleanUvs,
  )
  // 侧面 ±X / ±Z（纯净基色 UV）
  appendQuad(
    build,
    [
      [maxX, bottom, minZ],
      [maxX, 0, minZ],
      [maxX, 0, maxZ],
      [maxX, bottom, maxZ],
    ],
    [1, 0, 0],
    cleanUvs,
  )
  appendQuad(
    build,
    [
      [minX, bottom, maxZ],
      [minX, 0, maxZ],
      [minX, 0, minZ],
      [minX, bottom, minZ],
    ],
    [-1, 0, 0],
    cleanUvs,
  )
  appendQuad(
    build,
    [
      [minX, bottom, maxZ],
      [maxX, bottom, maxZ],
      [maxX, 0, maxZ],
      [minX, 0, maxZ],
    ],
    [0, 0, 1],
    cleanUvs,
  )
  appendQuad(
    build,
    [
      [maxX, bottom, minZ],
      [minX, bottom, minZ],
      [minX, 0, minZ],
      [maxX, 0, minZ],
    ],
    [0, 0, -1],
    cleanUvs,
  )
  return toBufferGeometry(build)
}

/**
 * 地坪分缝：6m×6m 世界对齐切缝细条（宽 FLOOR_JOINT_WIDTH，y=FLOOR_JOINT_Y），
 * 全部写入单一 BufferGeometry（1 个 mesh、1 次 draw call，§6.7）。
 */
export function buildFloorJointGeometry(bounds: FactoryBoundsDto): BufferGeometry {
  const { innerMinX: minX, innerMaxX: maxX, innerMinZ: minZ, innerMaxZ: maxZ } = bounds
  const halfWidth = FLOOR_JOINT_WIDTH / 2
  const build: GeometryBuild = { positions: [], normals: [], uvs: null, indices: [] }

  /** 追加一条贴地矩形细条（法线 +Y，与地坪顶面同一绕序约定） */
  const appendStrip = (x0: number, z0: number, x1: number, z1: number): void => {
    appendQuad(
      build,
      [
        [x0, FLOOR_JOINT_Y, z0],
        [x0, FLOOR_JOINT_Y, z1],
        [x1, FLOOR_JOINT_Y, z1],
        [x1, FLOOR_JOINT_Y, z0],
      ],
      [0, 1, 0],
      null,
    )
  }

  // 沿 Z 方向的缝（x = k·6m，横贯地坪纵深）
  for (const x of strictInteriorMultiples(minX, maxX, FLOOR_JOINT)) {
    appendStrip(x - halfWidth, minZ, x + halfWidth, maxZ)
  }
  // 沿 X 方向的缝（z = k·6m，横贯地坪宽度）
  for (const z of strictInteriorMultiples(minZ, maxZ, FLOOR_JOINT)) {
    appendStrip(minX, z - halfWidth, maxX, z + halfWidth)
  }
  return toBufferGeometry(build)
}
