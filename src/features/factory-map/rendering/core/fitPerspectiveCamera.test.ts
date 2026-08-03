/**
 * fitPerspectiveCamera 单元测试（SPEC §9.1、§15.1 fitPerspectiveCamera 行）。
 *
 * - 16:9 / 4:3 / 32:9 三画幅把厂房三维包围盒 8 角投影到 NDC，断言 |x|≤1 且 |y|≤1；
 * - 基准地图（public/map.json）16:9 距离 ≈189.2m，且明确拒绝旧二维公式的 ≈143.13m；
 * - 220m×220m 上限地图 4:3 画幅 fit 距离 ≤ ORBIT_MAX_DIST(350m)（约 348.7m，
 *   仅约 1.3m 余量是刻意边界设计，§9.1）。
 *
 * NDC 投影使用 three 的 PerspectiveCamera/Vector3（纯矩阵运算，node 环境可运行）。
 */

import { readFileSync } from 'node:fs'

import { PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { toFactoryBoundsDto } from '../../application/factorySceneModel'
import type { FactoryBoundsDto } from '../../application/factorySceneModel'
import {
  CAMERA_FAR,
  CAMERA_FOV,
  CAMERA_NEAR,
  ORBIT_MAX_DIST,
} from '../../config/cameraConfig'
import { FACTORY_MARGIN, STRUCTURE_MAX_Y } from '../../config/sceneMetrics'
import { computeMapBounds, deriveFactoryBounds } from '../../domain/bounds'
import { decodeMapEnvelope } from '../../domain/decodeMapEnvelope'
import { fitPerspectiveCamera } from './fitPerspectiveCamera'
import type { PerspectiveCameraFit } from './fitPerspectiveCamera'

/** 基准地图（public/map.json）推导的厂房内空边界（§6.1） */
const baselineBounds: FactoryBoundsDto = (() => {
  const url = new URL('../../../../../public/map.json', import.meta.url)
  const map = decodeMapEnvelope(JSON.parse(readFileSync(url, 'utf8')))
  return toFactoryBoundsDto(deriveFactoryBounds(computeMapBounds(map), FACTORY_MARGIN))
})()

/** 220m×220m 上限地图 + 四周 FACTORY_MARGIN=10m → 厂房内空 240m×240m（§3.3、§6.1） */
const maxExtentBounds: FactoryBoundsDto = {
  innerMinX: -120,
  innerMaxX: 120,
  innerMinZ: -120,
  innerMaxZ: 120,
  centerX: 0,
  centerZ: 0,
}

/**
 * 按 fit 结果架设 PerspectiveCamera（先设 up 再 lookAt），把 8 角投影到 NDC 并断言
 * |x|≤1、|y|≤1（§9.1）；返回全部角 |ndc| 的最大值供贴合度断言。
 */
function expectAllCornersInView(fit: PerspectiveCameraFit, bounds: FactoryBoundsDto): number {
  const camera = new PerspectiveCamera(fit.fov, fit.aspect, fit.near, fit.far)
  camera.position.set(fit.position[0], fit.position[1], fit.position[2])
  camera.up.set(fit.up[0], fit.up[1], fit.up[2])
  camera.lookAt(fit.target[0], fit.target[1], fit.target[2])
  camera.updateMatrixWorld(true)

  let maxAbs = 0
  for (const x of [bounds.innerMinX, bounds.innerMaxX]) {
    for (const y of [0, STRUCTURE_MAX_Y]) {
      for (const z of [bounds.innerMinZ, bounds.innerMaxZ]) {
        const ndc = new Vector3(x, y, z).project(camera)
        expect(Math.abs(ndc.x), `角(${x}, ${y}, ${z}) 的 NDC.x 越界`).toBeLessThanOrEqual(1)
        expect(Math.abs(ndc.y), `角(${x}, ${y}, ${z}) 的 NDC.y 越界`).toBeLessThanOrEqual(1)
        maxAbs = Math.max(maxAbs, Math.abs(ndc.x), Math.abs(ndc.y))
      }
    }
  }
  return maxAbs
}

describe('fitPerspectiveCamera（SPEC §9.1、§15.1）', () => {
  it('夹具锚定：基准地图厂房内空 187.84m×95.32m（§6.1）', () => {
    expect(baselineBounds.innerMaxX - baselineBounds.innerMinX).toBeCloseTo(187.84, 2)
    expect(baselineBounds.innerMaxZ - baselineBounds.innerMinZ).toBeCloseTo(95.32, 2)
  })

  it('基准地图 16:9 距离 ≈189.2m，且明确拒绝旧二维公式的 ≈143.13m', () => {
    const fit = fitPerspectiveCamera(baselineBounds, 16 / 9)
    expect(fit.distance).toBeCloseTo(189.2, 1)

    // 旧二维公式 max(halfW/tan(hHalf), halfD/tan(vHalf))×1.15 的数值锚点：
    // 它不计入近侧深度，横向越界约 20%，新算法必须显著大于它（回归防护）
    const halfW = (baselineBounds.innerMaxX - baselineBounds.innerMinX) / 2
    const halfD = (baselineBounds.innerMaxZ - baselineBounds.innerMinZ) / 2
    const tanV = Math.tan((CAMERA_FOV / 2) * (Math.PI / 180))
    const old2dDistance = Math.max(halfW / (tanV * (16 / 9)), halfD / tanV) * 1.15
    expect(old2dDistance).toBeCloseTo(143.13, 1)
    expect(fit.distance).toBeGreaterThan(old2dDistance + 40)
  })

  it.each([
    ['16:9', 16 / 9],
    ['4:3', 4 / 3],
    ['32:9', 32 / 9],
  ])('基准地图 %s 画幅：8 角 NDC 全部满足 |x|≤1、|y|≤1', (_label, aspect) => {
    const fit = fitPerspectiveCamera(baselineBounds, aspect)
    const maxAbs = expectAllCornersInView(fit, baselineBounds)
    // 贴合度：fit 不能过远（最大 |ndc| 应接近 1/1.15≈0.87 量级）
    expect(maxAbs).toBeGreaterThan(0.7)
  })

  it('220m×220m 上限地图 4:3 画幅：距离 ≈348.7m 且 ≤ ORBIT_MAX_DIST(350m)，8 角入画', () => {
    const fit = fitPerspectiveCamera(maxExtentBounds, 4 / 3)
    expect(fit.distance).toBeCloseTo(348.7, 1)
    expect(fit.distance).toBeLessThanOrEqual(ORBIT_MAX_DIST)
    expectAllCornersInView(fit, maxExtentBounds)
  })

  it('空态 60×40m 厂房（§6.1）同样 fit 成功且 8 角入画', () => {
    const emptyBounds: FactoryBoundsDto = {
      innerMinX: -30,
      innerMaxX: 30,
      innerMinZ: -20,
      innerMaxZ: 20,
      centerX: 0,
      centerZ: 0,
    }
    const fit = fitPerspectiveCamera(emptyBounds, 16 / 9)
    expect(Number.isFinite(fit.distance)).toBe(true)
    expect(fit.distance).toBeGreaterThan(0)
    expectAllCornersInView(fit, emptyBounds)
  })

  it('位置/target/up 与 §9.1 观察基一致，相机参数来自 §13.3 固定值', () => {
    const fit = fitPerspectiveCamera(baselineBounds, 16 / 9)

    expect(fit.target).toEqual([baselineBounds.centerX, 0, baselineBounds.centerZ])

    // camera.position = target - forward × dist，forward = (0, -√2/2, -√2/2)（南侧高位）
    expect(fit.position[0]).toBeCloseTo(baselineBounds.centerX, 10)
    expect(fit.position[1]).toBeCloseTo(Math.SQRT1_2 * fit.distance, 10)
    expect(fit.position[2]).toBeCloseTo(baselineBounds.centerZ + Math.SQRT1_2 * fit.distance, 10)

    // |position - target| = distance
    const dx = fit.position[0] - fit.target[0]
    const dy = fit.position[1] - fit.target[1]
    const dz = fit.position[2] - fit.target[2]
    expect(Math.hypot(dx, dy, dz)).toBeCloseTo(fit.distance, 10)

    // up = cross(right, forward)，与 forward 正交（否则 lookAt 画面带滚转）
    const dotUpForward =
      fit.up[1] * -Math.SQRT1_2 + fit.up[2] * -Math.SQRT1_2
    expect(dotUpForward).toBeCloseTo(0, 10)

    expect(fit.fov).toBe(CAMERA_FOV)
    expect(fit.near).toBe(CAMERA_NEAR)
    expect(fit.far).toBe(CAMERA_FAR)
    expect(fit.aspect).toBe(16 / 9)
  })

  it.each([
    ['0', 0],
    ['负数', -2],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('视口宽高比非法（%s）抛 RangeError', (_label, aspect) => {
    expect(() => fitPerspectiveCamera(baselineBounds, aspect)).toThrowError(RangeError)
    expect(() => fitPerspectiveCamera(baselineBounds, aspect)).toThrowError(/宽高比/)
  })
})
