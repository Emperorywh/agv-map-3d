import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'

import {
  buildCameraTransition,
  cameraPositionFromPose,
  clampOrthoZoomForViewWidth,
  clonePose,
  easeInOutCubic,
  orthoViewWidthForZoom,
  orthoZoomForViewWidth,
  perspectiveDistanceForViewWidth,
  perspectiveViewWidth,
  poseFromCameraPosition,
  sampleTransitionPose,
  shortestAzimuthDelta,
} from './cameraTransitions'
import type { CameraPose, CameraTransitionParams } from './cameraTransitions'

/** 构造姿态（测试便捷工厂） */
function makePose(
  target: [number, number, number],
  radius: number,
  polar: number,
  azimuth: number,
  zoom = 1,
): CameraPose {
  return { target: new Vector3(...target), radius, polar, azimuth, zoom }
}

/** 目的地解算测试参数（与 config 常量同量级；follow 目标默认 null） */
function makeParams(overrides: Partial<CameraTransitionParams> = {}): CameraTransitionParams {
  return {
    fovDeg: 50,
    aspect: 16 / 9,
    viewportWidthPx: 1920,
    orthoHeight: 120,
    topdownPolarRad: 0.0001,
    orthoViewWidthMin: 20,
    orthoViewWidthMax: 400,
    orbitReturnPolarRad: (55 * Math.PI) / 180,
    azimuthMemory: Math.PI / 4,
    distanceMin: 5,
    distanceMax: 400,
    resolveFollowTarget: () => null,
    ...overrides,
  }
}

function resolveDest(resolveTo: (out: CameraPose) => void): CameraPose {
  const out = makePose([0, 0, 0], 0, 0, 0)
  resolveTo(out)
  return out
}

describe('姿态球坐标换算', () => {
  it('poseFromCameraPosition 与 cameraPositionFromPose 往返一致', () => {
    const pose = poseFromCameraPosition(
      new Vector3(80, 60, 80),
      new Vector3(10, 0, -20),
      1,
      makePose([0, 0, 0], 0, 0, 0),
    )
    expect(pose.target.x).toBeCloseTo(10)
    expect(pose.target.z).toBeCloseTo(-20)
    expect(pose.radius).toBeCloseTo(Math.hypot(70, 60, 100))
    expect(pose.polar).toBeCloseTo(Math.acos(60 / Math.hypot(70, 60, 100)))
    expect(pose.azimuth).toBeCloseTo(Math.atan2(70, 100))

    const position = cameraPositionFromPose(pose, new Vector3())
    expect(position.x).toBeCloseTo(80)
    expect(position.y).toBeCloseTo(60)
    expect(position.z).toBeCloseTo(80)
  })

  it('极角 0 = 相机在关注点正上方；方位角 0 + 极角 90° = 相机在 +Z 侧', () => {
    const top = cameraPositionFromPose(makePose([1, 0, 2], 120, 0, 0), new Vector3())
    expect(top.x).toBeCloseTo(1)
    expect(top.y).toBeCloseTo(120)
    expect(top.z).toBeCloseTo(2)

    const side = cameraPositionFromPose(makePose([0, 0, 0], 50, Math.PI / 2, 0), new Vector3())
    expect(side.x).toBeCloseTo(0)
    expect(side.y).toBeCloseTo(0, 5)
    expect(side.z).toBeCloseTo(50)
  })
})

describe('过渡插值', () => {
  it('easeInOutCubic 端点 / 中点值且单调', () => {
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(1)).toBe(1)
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5)
    let previous = -1
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const value = easeInOutCubic(Math.min(1, t))
      expect(value).toBeGreaterThanOrEqual(previous)
      previous = value
    }
  })

  it('shortestAzimuthDelta 走最短路径（跨 ±π 环绕）', () => {
    const from = (170 * Math.PI) / 180
    const to = (-170 * Math.PI) / 180
    expect(shortestAzimuthDelta(from, to)).toBeCloseTo((20 * Math.PI) / 180)
    expect(shortestAzimuthDelta(to, from)).toBeCloseTo((-20 * Math.PI) / 180)
    expect(shortestAzimuthDelta(0.3, 0.3)).toBe(0)
  })

  it('sampleTransitionPose 端点等于起点 / 终点，中点为目标点中值', () => {
    const from = makePose([0, 0, 0], 100, Math.PI / 3, Math.PI / 2, 1)
    const to = makePose([40, 0, -30], 120, 0.0001, 0, 8)
    const out = makePose([0, 0, 0], 0, 0, 0)

    const atStart = sampleTransitionPose(from, to, 0, out)
    expect(atStart.target.x).toBeCloseTo(0)
    expect(atStart.radius).toBeCloseTo(100)
    expect(atStart.polar).toBeCloseTo(Math.PI / 3)
    expect(atStart.azimuth).toBeCloseTo(Math.PI / 2)
    expect(atStart.zoom).toBeCloseTo(1)

    const atEnd = sampleTransitionPose(from, to, 1, out)
    expect(atEnd.target.x).toBeCloseTo(40)
    expect(atEnd.target.z).toBeCloseTo(-30)
    expect(atEnd.radius).toBeCloseTo(120)
    expect(atEnd.polar).toBeCloseTo(0.0001)
    expect(atEnd.azimuth).toBeCloseTo(0)
    expect(atEnd.zoom).toBeCloseTo(8)

    const atMid = sampleTransitionPose(from, to, 0.5, out)
    expect(atMid.target.x).toBeCloseTo(20)
    expect(atMid.target.z).toBeCloseTo(-15)
    expect(atMid.radius).toBeCloseTo(110)
    expect(atMid.zoom).toBeCloseTo(4.5)
  })

  it('sampleTransitionPose 方位角跨 ±π 时经 ±π 侧插值（不绕远路）', () => {
    const from = makePose([0, 0, 0], 100, 1, (170 * Math.PI) / 180)
    const to = makePose([0, 0, 0], 100, 1, (-170 * Math.PI) / 180)
    const atMid = sampleTransitionPose(from, to, 0.5, makePose([0, 0, 0], 0, 0, 0))
    // 中点应在 ±π 附近（最短路径），而非 0 附近（绕远路）
    expect(Math.abs(Math.abs(atMid.azimuth) - Math.PI)).toBeLessThan(0.01)
  })
})

describe('视野宽度换算', () => {
  it('perspectiveViewWidth 与 perspectiveDistanceForViewWidth 互逆', () => {
    const width = perspectiveViewWidth(50, 16 / 9, 129)
    expect(width).toBeCloseTo(2 * 129 * Math.tan((25 * Math.PI) / 180) * (16 / 9))
    expect(perspectiveDistanceForViewWidth(50, 16 / 9, width)).toBeCloseTo(129)
  })

  it('orthoZoomForViewWidth / orthoViewWidthForZoom 互逆', () => {
    expect(orthoZoomForViewWidth(1920, 240)).toBeCloseTo(8)
    expect(orthoViewWidthForZoom(1920, 8)).toBeCloseTo(240)
  })

  it('clampOrthoZoomForViewWidth 按视野宽度上下限钳制', () => {
    // 视野宽度限 [20, 400]、视口 1920px → zoom ∈ [4.8, 96]
    expect(clampOrthoZoomForViewWidth(8, 1920, 20, 400)).toBeCloseTo(8)
    expect(clampOrthoZoomForViewWidth(1, 1920, 20, 400)).toBeCloseTo(4.8)
    expect(clampOrthoZoomForViewWidth(200, 1920, 20, 400)).toBeCloseTo(96)
  })
})

describe('模式切换目的地解算', () => {
  it('orbit → topdown：关注点不变、相机升顶、方位角归 0、zoom 按取景宽度匹配', () => {
    const from = makePose([10, 0, -5], 129, Math.PI / 3, Math.PI / 2, 1)
    const transition = buildCameraTransition('topdown', 'orbit', from, makeParams())

    // 起点 zoom 即匹配 zoom：过渡全程视野宽度不变（取景无跳变）
    const expectedZoom =
      1920 / perspectiveViewWidth(50, 16 / 9, 129)
    expect(transition.from.zoom).toBeCloseTo(expectedZoom)
    expect(transition.from.radius).toBeCloseTo(129)

    const dest = resolveDest(transition.resolveTo)
    expect(dest.target.x).toBeCloseTo(10)
    expect(dest.target.z).toBeCloseTo(-5)
    expect(dest.radius).toBeCloseTo(120)
    expect(dest.polar).toBeCloseTo(0.0001)
    expect(dest.azimuth).toBe(0)
    expect(dest.zoom).toBeCloseTo(expectedZoom)
  })

  it('orbit → topdown：取景过宽 / 过窄时 zoom 按视野宽度限钳制', () => {
    const params = makeParams()
    // 距离 400m 透视取景宽 ≈ 662m > 400m 上限 → zoom 钳到 1920/400
    const far = buildCameraTransition('topdown', 'orbit', makePose([0, 0, 0], 400, 1, 0), params)
    expect(resolveDest(far.resolveTo).zoom).toBeCloseTo(1920 / 400)
    // 距离 5m 取景宽 ≈ 8.3m < 20m 下限 → zoom 钳到 1920/20
    const near = buildCameraTransition('topdown', 'orbit', makePose([0, 0, 0], 5, 1, 0), params)
    expect(resolveDest(near.resolveTo).zoom).toBeCloseTo(1920 / 20)
  })

  it('topdown → orbit：按正交视野宽度反算距离、默认极角、方位角记忆、zoom 归 1', () => {
    // 正交 zoom 8 → 视野宽 240m → 透视距离 = 240 / (2·tan25°·16/9)
    const from = makePose([30, 0, 40], 120, 0.0001, 0, 8)
    const transition = buildCameraTransition('orbit', 'topdown', from, makeParams())

    // 起点（新透视相机口径）：同关注点同球面、zoom 归 1
    expect(transition.from.zoom).toBe(1)
    expect(transition.from.radius).toBeCloseTo(120)

    const dest = resolveDest(transition.resolveTo)
    const expectedDistance = perspectiveDistanceForViewWidth(50, 16 / 9, 1920 / 8)
    expect(dest.target.x).toBeCloseTo(30)
    expect(dest.target.z).toBeCloseTo(40)
    expect(dest.radius).toBeCloseTo(expectedDistance)
    expect(dest.polar).toBeCloseTo((55 * Math.PI) / 180)
    expect(dest.azimuth).toBeCloseTo(Math.PI / 4)
    expect(dest.zoom).toBe(1)
  })

  it('topdown → orbit：反算距离钳制在 5~400m（SPEC §8.1 距离限）', () => {
    const params = makeParams()
    // zoom 0.48 → 视野宽 4000m → 距离 ≈ 4820m → 钳到 400
    const wide = buildCameraTransition('orbit', 'topdown', makePose([0, 0, 0], 120, 0.0001, 0, 0.48), params)
    expect(resolveDest(wide.resolveTo).radius).toBe(400)
    // zoom 960 → 视野宽 2m → 距离 ≈ 2.4m → 钳到 5
    const narrow = buildCameraTransition('orbit', 'topdown', makePose([0, 0, 0], 120, 0.0001, 0, 960), params)
    expect(resolveDest(narrow.resolveTo).radius).toBe(5)
  })

  it('follow → orbit：原地驻留（目的地 = 切换瞬间姿态，无跳变）', () => {
    const from = makePose([12, 0.5, 8], 30, 1.1, 2.2, 1)
    const transition = buildCameraTransition('orbit', 'follow', from, makeParams())
    const dest = resolveDest(transition.resolveTo)
    expect(dest.target.x).toBeCloseTo(12)
    expect(dest.target.y).toBeCloseTo(0.5)
    expect(dest.target.z).toBeCloseTo(8)
    expect(dest.radius).toBeCloseTo(30)
    expect(dest.polar).toBeCloseTo(1.1)
    expect(dest.azimuth).toBeCloseTo(2.2)
  })

  it('orbit → follow：目的地每帧解析移动目标，环绕球面参数保持切换瞬间值', () => {
    const movingTarget = new Vector3(0, 0.5, 0)
    const params = makeParams({ resolveFollowTarget: () => movingTarget })
    const from = makePose([100, 0, -60], 129, Math.PI / 3, Math.PI / 2, 1)
    const transition = buildCameraTransition('follow', 'orbit', from, params)

    expect(transition.from.zoom).toBe(1)

    const first = resolveDest(transition.resolveTo)
    expect(first.target.x).toBeCloseTo(0)
    expect(first.radius).toBeCloseTo(129)
    expect(first.polar).toBeCloseTo(Math.PI / 3)
    expect(first.azimuth).toBeCloseTo(Math.PI / 2)
    expect(first.zoom).toBe(1)

    // 目标移动后目的地跟随移动（过渡始终收敛到目标当前位置）
    movingTarget.set(25, 0.5, -15)
    const second = resolveDest(transition.resolveTo)
    expect(second.target.x).toBeCloseTo(25)
    expect(second.target.z).toBeCloseTo(-15)
    expect(second.radius).toBeCloseTo(129)
  })

  it('topdown → follow：自俯视进入时按切回透视口径落地（距离匹配 / 默认极角 / 方位角记忆）', () => {
    const agv = new Vector3(-7, 0.5, 3)
    const params = makeParams({ resolveFollowTarget: () => agv })
    const from = makePose([30, 0, 40], 120, 0.0001, 0, 8)
    const transition = buildCameraTransition('follow', 'topdown', from, params)
    const dest = resolveDest(transition.resolveTo)
    expect(dest.target.x).toBeCloseTo(-7)
    expect(dest.target.z).toBeCloseTo(3)
    expect(dest.radius).toBeCloseTo(perspectiveDistanceForViewWidth(50, 16 / 9, 240))
    expect(dest.polar).toBeCloseTo((55 * Math.PI) / 180)
    expect(dest.azimuth).toBeCloseTo(Math.PI / 4)
  })

  it('follow 目标瞬时值缺失：目的地原地驻留（无跳变）', () => {
    const params = makeParams({ resolveFollowTarget: () => null })
    const from = makePose([5, 0, 5], 60, 1.2, 0.8, 1)
    const transition = buildCameraTransition('follow', 'orbit', from, params)
    const dest = resolveDest(transition.resolveTo)
    expect(dest.target.x).toBeCloseTo(5)
    expect(dest.target.z).toBeCloseTo(5)
    expect(dest.radius).toBeCloseTo(60)
    expect(dest.polar).toBeCloseTo(1.2)
    expect(dest.azimuth).toBeCloseTo(0.8)
  })

  it('clonePose 深拷贝：修改拷贝不影响原姿态', () => {
    const pose = makePose([1, 2, 3], 50, 1, 0.5, 7)
    const copy = clonePose(pose)
    copy.target.set(9, 9, 9)
    copy.radius = 1
    expect(pose.target.x).toBe(1)
    expect(pose.radius).toBe(50)
    expect(copy.zoom).toBe(7)
  })
})
