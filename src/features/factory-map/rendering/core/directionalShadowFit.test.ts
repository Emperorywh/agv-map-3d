/**
 * fitDirectionalShadowCamera 单元测试（SPEC §6.6 阴影行）。
 *
 * - light target = 厂房中心（Y=0）、position = target + normalize(0.5,1,0.35) × 300m；
 * - 厂房三维 bounds（min y=0、max y=STRUCTURE_MAX_Y=9.0）8 角 → light-view 空间，
 *   投影 min/max + 20m padding 设置正交 shadow camera；near/far 由 light-view
 *   深度范围推导；
 * - light-view 基与 three Matrix4.lookAt(eye, target, up=(0,1,0)) 的一致性经
 *   three 独立重算交叉核对；端到端用 three OrthographicCamera 把 8 角投影到 NDC，
 *   断言全部位于 padding 内且深度端点恰达 ±1（near/far 无冗余、不裁切）。
 *
 * NDC 投影使用 three 的 OrthographicCamera/Vector3（纯矩阵运算，node 环境可运行）。
 */

import { readFileSync } from 'node:fs'

import { Matrix4, OrthographicCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { toFactoryBoundsDto } from '../../application/factorySceneModel'
import type { FactoryBoundsDto } from '../../application/factorySceneModel'
import { FACTORY_MARGIN, STRUCTURE_MAX_Y } from '../../config/sceneMetrics'
import { computeMapBounds, deriveFactoryBounds } from '../../domain/bounds'
import { decodeMapEnvelope } from '../../domain/decodeMapEnvelope'
import { sunDirection } from '../scene/exterior/exteriorGeometry'
import {
  SHADOW_CAMERA_PADDING,
  SUN_LIGHT_DISTANCE,
  fitDirectionalShadowCamera,
} from './directionalShadowFit'
import type { DirectionalShadowSetup } from './directionalShadowFit'

/** 居中 bounds：100m × 60m 内空，中心原点 */
const CENTERED_BOUNDS: FactoryBoundsDto = {
  innerMinX: -50,
  innerMaxX: 50,
  innerMinZ: -30,
  innerMaxZ: 30,
  centerX: 0,
  centerZ: 0,
}

/** 偏移 bounds：160m × 120m 内空，中心 (180, -140)（验证非原点中心的平移正确性） */
const OFFSET_BOUNDS: FactoryBoundsDto = {
  innerMinX: 100,
  innerMaxX: 260,
  innerMinZ: -200,
  innerMaxZ: -80,
  centerX: 180,
  centerZ: -140,
}

/** 基准地图（public/map.json）推导的厂房内空边界（§6.1：187.84m × 95.32m） */
const baselineBounds: FactoryBoundsDto = (() => {
  const url = new URL('../../../../../public/map.json', import.meta.url)
  const map = decodeMapEnvelope(JSON.parse(readFileSync(url, 'utf8')))
  return toFactoryBoundsDto(deriveFactoryBounds(computeMapBounds(map), FACTORY_MARGIN))
})()

/** 厂房三维 bounds 的 8 个角（min y=0、max y=STRUCTURE_MAX_Y，§9.1 同一包围盒约定） */
function structureCorners(bounds: FactoryBoundsDto): Vector3[] {
  const corners: Vector3[] = []
  for (const x of [bounds.innerMinX, bounds.innerMaxX]) {
    for (const y of [0, STRUCTURE_MAX_Y]) {
      for (const z of [bounds.innerMinZ, bounds.innerMaxZ]) {
        corners.push(new Vector3(x, y, z))
      }
    }
  }
  return corners
}

/**
 * 用 three Matrix4.lookAt 独立重算 8 角的 light-view 坐标与深度（交叉核对基约定）：
 * zAxis = normalize(eye - target)、xAxis = normalize(cross(up, zAxis))、
 * yAxis = cross(zAxis, xAxis)；深度 = -dot(rel, zAxis)。
 */
function lightViewCoordsViaThree(
  bounds: FactoryBoundsDto,
  setup: DirectionalShadowSetup,
): { viewX: number[]; viewY: number[]; depth: number[] } {
  const eye = new Vector3(...setup.lightPosition)
  const target = new Vector3(...setup.lightTarget)
  const look = new Matrix4().lookAt(eye, target, new Vector3(0, 1, 0))
  const e = look.elements
  const xAxis = new Vector3(e[0], e[1], e[2])
  const yAxis = new Vector3(e[4], e[5], e[6])
  const zAxis = new Vector3(e[8], e[9], e[10])

  const viewX: number[] = []
  const viewY: number[] = []
  const depth: number[] = []
  for (const corner of structureCorners(bounds)) {
    const rel = corner.clone().sub(eye)
    viewX.push(rel.dot(xAxis))
    viewY.push(rel.dot(yAxis))
    depth.push(-rel.dot(zAxis))
  }
  return { viewX, viewY, depth }
}

/** 端到端：按 setup 架设 three OrthographicCamera，把 8 角投影到 NDC */
function projectCornersToNdc(bounds: FactoryBoundsDto, setup: DirectionalShadowSetup): Vector3[] {
  const camera = new OrthographicCamera(
    setup.camera.left,
    setup.camera.right,
    setup.camera.top,
    setup.camera.bottom,
    setup.camera.near,
    setup.camera.far,
  )
  camera.position.set(...setup.lightPosition)
  camera.up.set(0, 1, 0)
  camera.lookAt(...setup.lightTarget)
  camera.updateMatrixWorld(true)
  return structureCorners(bounds).map((corner) => corner.clone().project(camera))
}

describe('fitDirectionalShadowCamera 灯光位置与方向（§6.6）', () => {
  it('target = 厂房中心（Y=0）；position = target + normalize(0.5,1,0.35) × 300m', () => {
    for (const bounds of [CENTERED_BOUNDS, OFFSET_BOUNDS]) {
      const setup = fitDirectionalShadowCamera(bounds)
      expect(setup.lightTarget).toEqual([bounds.centerX, 0, bounds.centerZ])

      const direction = sunDirection()
      expect(Math.hypot(...direction)).toBeCloseTo(1, 12)
      expect(setup.lightPosition[0]).toBeCloseTo(bounds.centerX + direction[0] * SUN_LIGHT_DISTANCE, 10)
      expect(setup.lightPosition[1]).toBeCloseTo(direction[1] * SUN_LIGHT_DISTANCE, 10)
      expect(setup.lightPosition[2]).toBeCloseTo(bounds.centerZ + direction[2] * SUN_LIGHT_DISTANCE, 10)
      expect(SUN_LIGHT_DISTANCE).toBe(300)

      // 光源与厂房中心距离恰好 300m（§6.6 direction × 300m）
      const distance = new Vector3(...setup.lightPosition)
        .sub(new Vector3(...setup.lightTarget))
        .length()
      expect(distance).toBeCloseTo(300, 10)
    }
  })
})

describe('fitDirectionalShadowCamera shadow camera 推导（§6.6：8 角 light-view min/max + 20m padding）', () => {
  it('light-view 基与 three Matrix4.lookAt 一致：视锥 = 投影 min/max ± 20m、深度区间 = near/far', () => {
    for (const bounds of [CENTERED_BOUNDS, OFFSET_BOUNDS, baselineBounds]) {
      const setup = fitDirectionalShadowCamera(bounds)
      const { viewX, viewY, depth } = lightViewCoordsViaThree(bounds, setup)

      expect(setup.camera.left).toBeCloseTo(Math.min(...viewX) - SHADOW_CAMERA_PADDING, 8)
      expect(setup.camera.right).toBeCloseTo(Math.max(...viewX) + SHADOW_CAMERA_PADDING, 8)
      expect(setup.camera.bottom).toBeCloseTo(Math.min(...viewY) - SHADOW_CAMERA_PADDING, 8)
      expect(setup.camera.top).toBeCloseTo(Math.max(...viewY) + SHADOW_CAMERA_PADDING, 8)
      expect(setup.camera.near).toBeCloseTo(Math.min(...depth), 8)
      expect(setup.camera.far).toBeCloseTo(Math.max(...depth), 8)
      expect(SHADOW_CAMERA_PADDING).toBe(20)
    }
  })

  it('padding 恰好为 20m：视锥宽/高 = 8 角投影跨度 + 40m', () => {
    const setup = fitDirectionalShadowCamera(OFFSET_BOUNDS)
    const { viewX, viewY } = lightViewCoordsViaThree(OFFSET_BOUNDS, setup)
    const spanX = Math.max(...viewX) - Math.min(...viewX)
    const spanY = Math.max(...viewY) - Math.min(...viewY)
    expect(setup.camera.right - setup.camera.left - spanX).toBeCloseTo(40, 8)
    expect(setup.camera.top - setup.camera.bottom - spanY).toBeCloseTo(40, 8)
  })

  it.each([
    ['居中', CENTERED_BOUNDS],
    ['偏移', OFFSET_BOUNDS],
    ['基准地图', baselineBounds],
  ])('端到端 NDC（%s bounds）：8 角全部位于 padding 内，深度端点恰达 ±1', (_label, bounds) => {
    const setup = fitDirectionalShadowCamera(bounds)
    const ndcs = projectCornersToNdc(bounds, setup)

    const halfW = (setup.camera.right - setup.camera.left) / 2
    const halfH = (setup.camera.top - setup.camera.bottom) / 2
    // 20m padding → 角点 NDC 距边界恰好 20m 对应的 NDC 余量
    const limitX = (halfW - SHADOW_CAMERA_PADDING) / halfW
    const limitY = (halfH - SHADOW_CAMERA_PADDING) / halfH

    let maxAbsX = 0
    let maxAbsY = 0
    let minZ = Infinity
    let maxZ = -Infinity
    for (const ndc of ndcs) {
      expect(Math.abs(ndc.x)).toBeLessThanOrEqual(limitX + 1e-8)
      expect(Math.abs(ndc.y)).toBeLessThanOrEqual(limitY + 1e-8)
      expect(ndc.z).toBeGreaterThanOrEqual(-1 - 1e-8)
      expect(ndc.z).toBeLessThanOrEqual(1 + 1e-8)
      maxAbsX = Math.max(maxAbsX, Math.abs(ndc.x))
      maxAbsY = Math.max(maxAbsY, Math.abs(ndc.y))
      minZ = Math.min(minZ, ndc.z)
      maxZ = Math.max(maxZ, ndc.z)
    }
    // 8 角投影极值恰达 padding 内边界（视锥无冗余）；深度端点恰达 ±1（near/far 无冗余）
    expect(maxAbsX).toBeCloseTo(limitX, 8)
    expect(maxAbsY).toBeCloseTo(limitY, 8)
    expect(minZ).toBeCloseTo(-1, 8)
    expect(maxZ).toBeCloseTo(1, 8)
  })

  it('基准地图：8 角恒在光前方（near > 0），深度区间紧凑（不随 300m 距离放大）', () => {
    const setup = fitDirectionalShadowCamera(baselineBounds)
    expect(setup.camera.near).toBeGreaterThan(0)
    expect(setup.camera.far).toBeGreaterThan(setup.camera.near)
    // 深度区间上界：结构三维对角线（187.84 × 9 × 95.32 → 对角线 ≈ 211m）
    const diagonal = Math.hypot(
      baselineBounds.innerMaxX - baselineBounds.innerMinX,
      STRUCTURE_MAX_Y,
      baselineBounds.innerMaxZ - baselineBounds.innerMinZ,
    )
    expect(setup.camera.far - setup.camera.near).toBeLessThanOrEqual(diagonal + 1e-8)
  })
})
