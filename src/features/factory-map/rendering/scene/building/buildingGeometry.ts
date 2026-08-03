/**
 * 围墙三段（实墙/玻璃/实墙）与墙柱分格条几何构建（SPEC §6.3）。
 *
 * 纯函数、无 DOM；顶点直接烘焙世界坐标（mesh 位于原点，无二次变换）。
 * - 每面墙沿高度拆为 0~4.0m 实墙、4.0~6.5m 玻璃、6.5~8.0m 实墙三段
 *  （WINDOW_BAND_BOTTOM/WINDOW_BAND_TOP/WALL_HEIGHT，§13.1）；
 *   玻璃带后方不存在任何不透明几何——实墙几何只含下/上两段。
 * - 四面实墙（每面 2 段共 8 块薄板）合并为一个 BufferGeometry；
 *   四面玻璃（4 块）合并为另一个（§6.3、§6.7）。
 * - 墙板为薄板盒体（厚 WALL_THICKNESS=0.2m，中心线压在厂房内边界上，v1 简化取值，
 *   未列入 §13 配置表）：沿 X 墙板两端各外延半厚补齐墙角，沿 Z 墙板两端内缩半厚，
 *   墙角无缝无共面重叠；不做门洞（§6.3 v1 简化）。
 * - 墙柱：沿墙每 6m 一条（世界对齐，与地坪分缝同相位），0~8m 全高贯通穿过玻璃带；
 *   方形截面 WALL_COLUMN_SECTION=0.26m（凸出两侧墙面各 0.03m），实例矩阵为纯平移，
 *   全部实例由一个 InstancedMesh 承载（§6.3）。
 */

import { BufferAttribute, BufferGeometry } from 'three'

import type { FactoryBoundsDto } from '../../../application/factorySceneModel'
import { FLOOR_JOINT, WALL_HEIGHT, WINDOW_BAND_BOTTOM, WINDOW_BAND_TOP } from '../../../config/sceneMetrics'

/** 墙板厚度（v1 简化取值：0.2m，SPEC 未固定，唯一定义于此） */
export const WALL_THICKNESS = 0.2

/** 墙柱分格条方形截面边长（v1 简化取值：0.26m，凸出墙面 0.03m，SPEC 未固定） */
export const WALL_COLUMN_SECTION = 0.26

/** 实例几何批次：InstancedMesh 的 geometry + 纯平移实例矩阵（每实例 16 个浮点） */
export interface InstanceGeometryBatch {
  readonly geometry: BufferGeometry
  /** column-major 4×4 矩阵，连续 count 个（three InstancedMesh.instanceMatrix 布局） */
  readonly matrices: Float32Array
  readonly count: number
}

/** 围墙几何对：实墙（下/上两段合并）与玻璃带（合并） */
export interface WallGeometryPair {
  readonly solid: BufferGeometry
  readonly glass: BufferGeometry
}

type Vec3 = readonly [number, number, number]

interface GeometryBuild {
  readonly positions: number[]
  readonly normals: number[]
  readonly indices: number[]
}

/**
 * 追加一个轴对齐盒体（24 顶点 / 36 索引，每面独立法线）。
 * 各面顶点按从外侧看逆时针排序，与 three 正面绕序约定一致。
 */
export function appendBox(
  build: GeometryBuild,
  centerX: number,
  centerY: number,
  centerZ: number,
  sizeX: number,
  sizeY: number,
  sizeZ: number,
): void {
  const hx = sizeX / 2
  const hy = sizeY / 2
  const hz = sizeZ / 2
  const x0 = centerX - hx
  const x1 = centerX + hx
  const y0 = centerY - hy
  const y1 = centerY + hy
  const z0 = centerZ - hz
  const z1 = centerZ + hz

  const faces: readonly (readonly [readonly [Vec3, Vec3, Vec3, Vec3], Vec3])[] = [
    // +X
    [[[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0]],
    // -X
    [[[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]], [-1, 0, 0]],
    // +Y
    [[[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [0, 1, 0]],
    // -Y
    [[[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]], [0, -1, 0]],
    // +Z
    [[[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]],
    // -Z
    [[[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1]],
  ]

  for (const [corners, normal] of faces) {
    const base = build.positions.length / 3
    for (let i = 0; i < 4; i += 1) {
      build.positions.push(corners[i][0], corners[i][1], corners[i][2])
      build.normals.push(normal[0], normal[1], normal[2])
    }
    build.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
}

function toBufferGeometry(build: GeometryBuild): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(build.positions), 3))
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(build.normals), 3))
  geometry.setIndex(new BufferAttribute(new Uint32Array(build.indices), 1))
  return geometry
}

/** 以原点为中心的轴对齐盒体几何（InstancedMesh 实例几何；实例矩阵负责平移） */
export function createBoxGeometry(sizeX: number, sizeY: number, sizeZ: number): BufferGeometry {
  const build: GeometryBuild = { positions: [], normals: [], indices: [] }
  appendBox(build, 0, 0, 0, sizeX, sizeY, sizeZ)
  return toBufferGeometry(build)
}

/** 写入一个 column-major 纯平移 4×4 矩阵（three Matrix4.elements 布局） */
export function writeTranslationMatrix(
  out: Float32Array,
  offset: number,
  x: number,
  y: number,
  z: number,
): void {
  out[offset] = 1
  out[offset + 1] = 0
  out[offset + 2] = 0
  out[offset + 3] = 0
  out[offset + 4] = 0
  out[offset + 5] = 1
  out[offset + 6] = 0
  out[offset + 7] = 0
  out[offset + 8] = 0
  out[offset + 9] = 0
  out[offset + 10] = 1
  out[offset + 11] = 0
  out[offset + 12] = x
  out[offset + 13] = y
  out[offset + 14] = z
  out[offset + 15] = 1
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
 * 四面墙的三段几何：实墙对（0~4.0m 与 6.5~8.0m）合并进 solid，
 * 玻璃带（4.0~6.5m）合并进 glass。沿 X 墙板（z=innerMinZ/innerMaxZ）两端外延半厚
 * 补角，沿 Z 墙板（x=innerMinX/innerMaxX）两端内缩半厚；进深不足墙厚时沿 Z 墙板
 * 退化为不生成（正常厂房内空 ≥ 20m，仅为防御性边界）。
 */
export function buildWallGeometries(bounds: FactoryBoundsDto): WallGeometryPair {
  const { innerMinX: minX, innerMaxX: maxX, innerMinZ: minZ, innerMaxZ: maxZ } = bounds
  const innerWidth = maxX - minX
  const innerDepth = maxZ - minZ

  const solid: GeometryBuild = { positions: [], normals: [], indices: [] }
  const glass: GeometryBuild = { positions: [], normals: [], indices: [] }

  // §6.3 三段高度区间：实墙 / 玻璃 / 实墙
  const segments: readonly (readonly [kind: 'solid' | 'glass', y0: number, y1: number])[] = [
    ['solid', 0, WINDOW_BAND_BOTTOM],
    ['glass', WINDOW_BAND_BOTTOM, WINDOW_BAND_TOP],
    ['solid', WINDOW_BAND_TOP, WALL_HEIGHT],
  ]

  for (const [kind, y0, y1] of segments) {
    const build = kind === 'solid' ? solid : glass
    const centerY = (y0 + y1) / 2
    const sizeY = y1 - y0
    // 沿 X 墙板（南/北）：长度 = 内空宽 + 一个墙厚（两端各外延半厚补角）
    for (const z of [minZ, maxZ]) {
      appendBox(build, bounds.centerX, centerY, z, innerWidth + WALL_THICKNESS, sizeY, WALL_THICKNESS)
    }
    // 沿 Z 墙板（东/西）：长度 = 内空深 - 一个墙厚（两端内缩半厚，与沿 X 墙板无缝衔接）
    if (innerDepth > WALL_THICKNESS) {
      for (const x of [minX, maxX]) {
        appendBox(build, x, centerY, bounds.centerZ, WALL_THICKNESS, sizeY, innerDepth - WALL_THICKNESS)
      }
    }
  }

  return { solid: toBufferGeometry(solid), glass: toBufferGeometry(glass) }
}

/**
 * 墙柱分格条实例：沿每面墙每 6m（世界对齐，与地坪分缝同相位）一根，
 * 0~WALL_HEIGHT 全高贯通（穿过玻璃带）；实例几何为原点居中盒体，
 * 实例矩阵为纯平移（柱心压墙板中心线，柱底 y=0 → 平移 y=WALL_HEIGHT/2）。
 */
export function buildWallColumnInstances(bounds: FactoryBoundsDto): InstanceGeometryBatch {
  const { innerMinX: minX, innerMaxX: maxX, innerMinZ: minZ, innerMaxZ: maxZ } = bounds
  const columnY = WALL_HEIGHT / 2

  const positions: number[] = []
  // 沿 X 墙板上的柱（z = innerMinZ / innerMaxZ）
  for (const x of strictInteriorMultiples(minX, maxX, FLOOR_JOINT)) {
    positions.push(x, minZ, x, maxZ)
  }
  // 沿 Z 墙板上的柱（x = innerMinX / innerMaxX）
  for (const z of strictInteriorMultiples(minZ, maxZ, FLOOR_JOINT)) {
    positions.push(minX, z, maxX, z)
  }

  const count = positions.length / 2
  const matrices = new Float32Array(count * 16)
  for (let i = 0; i < count; i += 1) {
    writeTranslationMatrix(matrices, i * 16, positions[i * 2], columnY, positions[i * 2 + 1])
  }

  return {
    geometry: createBoxGeometry(WALL_COLUMN_SECTION, WALL_HEIGHT, WALL_COLUMN_SECTION),
    matrices,
    count,
  }
}
