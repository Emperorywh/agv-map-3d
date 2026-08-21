/**
 * 相机三模式切换的纯函数（SPEC §8.1）：自由 Orbit / 正交俯视 / AGV 跟随之间的
 * 平滑过渡（位置 / 目标点插值，约 CAMERA_TRANSITION_SECONDS 秒，无跳变）。
 *
 * 设计要点：
 * - 姿态用球坐标表达（与 three OrbitControls / Spherical 同口径：y-up、
 *   polar 自 +Y 起算、azimuth 自 +Z 起算），过渡在球面参数 + 关注点上线性插值，
 *   方位角走最短路径，避免直线位置插值在近正顶视角时的朝向打转；
 * - 正交 ↔ 透视的取景衔接按"视野宽度"匹配：进入俯视时以当前透视取景宽度换算
 *   正交 zoom（切出时反算透视距离），过渡起始帧取景零跳变；
 * - 跟随模式的目标在动，目的地以闭包形式每帧重解析，过渡始终收敛到目标当前位置；
 * - 所有常量（高度 / 极角 / 距离限 / 视野宽度限）由场景层自 config 注入，
 *   本模块不 import config / state（SPEC §12 分层）。
 *
 * rendering 层可 import three（SPEC §12）；相机模式字面量与 state/appStore 的
 * CameraMode 同构（渲染层不 import state，结构化类型天然兼容）。
 */

import { Vector3 } from 'three'

/** 相机三模式（SPEC §8.1；与 state/appStore 的 CameraMode 同构） */
export type CameraRigMode = 'orbit' | 'topdown' | 'follow'

/**
 * 球坐标相机姿态：关注点 target + 相机相对关注点的 半径 / 极角 / 方位角 + zoom。
 * zoom 仅正交俯视有意义；透视相机恒为 1（OrbitControls 透视缩放走距离）。
 */
export interface CameraPose {
  /** 视线关注点（OrbitControls target，世界坐标） */
  target: Vector3
  /** 相机到关注点的距离（米） */
  radius: number
  /** 极角（弧度，自 +Y 起算；0 = 正上方俯视） */
  polar: number
  /** 方位角（弧度，绕 Y 自 +Z 起算） */
  azimuth: number
  /** 相机 zoom（正交 = 视野缩放；透视恒 1） */
  zoom: number
}

/** 由相机位置与关注点解算球坐标姿态（in-place 写入 out，每帧路径零分配） */
export function poseFromCameraPosition(
  position: Vector3,
  target: Vector3,
  zoom: number,
  out: CameraPose,
): CameraPose {
  const offsetX = position.x - target.x
  const offsetY = position.y - target.y
  const offsetZ = position.z - target.z
  const radius = Math.sqrt(offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ)
  out.target.copy(target)
  out.radius = radius
  out.polar = radius > 0 ? Math.acos(Math.min(1, Math.max(-1, offsetY / radius))) : 0
  out.azimuth = Math.atan2(offsetX, offsetZ)
  out.zoom = zoom
  return out
}

/** 深拷贝姿态（过渡起点快照，过渡期间不随后续帧变化） */
export function clonePose(pose: CameraPose): CameraPose {
  return {
    target: pose.target.clone(),
    radius: pose.radius,
    polar: pose.polar,
    azimuth: pose.azimuth,
    zoom: pose.zoom,
  }
}

/** 由姿态解算相机世界位置（in-place 写入 out） */
export function cameraPositionFromPose(pose: CameraPose, out: Vector3): Vector3 {
  const sinPolar = Math.sin(pose.polar)
  return out.set(
    pose.target.x + pose.radius * sinPolar * Math.sin(pose.azimuth),
    pose.target.y + pose.radius * Math.cos(pose.polar),
    pose.target.z + pose.radius * sinPolar * Math.cos(pose.azimuth),
  )
}

/** 过渡缓动（easeInOutCubic）：起步 / 收尾平滑，中段匀加速 */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/** 方位角最短路径差（弧度，值域 [-π, π]）：170° → -170° 走 +20° 而非 -340° */
export function shortestAzimuthDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from))
}

/**
 * 过渡采样：关注点线性插值 + 球面参数线性插值（方位角走最短路径）+ zoom 插值。
 * easedT 为已过缓动的进度 [0, 1]；out 可与 to 复用同一对象（逐字段先读后写）。
 */
export function sampleTransitionPose(
  from: CameraPose,
  to: CameraPose,
  easedT: number,
  out: CameraPose,
): CameraPose {
  out.target.lerpVectors(from.target, to.target, easedT)
  out.radius = from.radius + (to.radius - from.radius) * easedT
  out.polar = from.polar + (to.polar - from.polar) * easedT
  out.azimuth = from.azimuth + shortestAzimuthDelta(from.azimuth, to.azimuth) * easedT
  out.zoom = from.zoom + (to.zoom - from.zoom) * easedT
  return out
}

/** 透视相机在关注点距离处的取景宽度（米）：2 · d · tan(fov/2) · aspect */
export function perspectiveViewWidth(fovDeg: number, aspect: number, distance: number): number {
  return 2 * distance * Math.tan((fovDeg * Math.PI) / 360) * aspect
}

/** 取景宽度反算透视相机距离（米），perspectiveViewWidth 的逆运算 */
export function perspectiveDistanceForViewWidth(
  fovDeg: number,
  aspect: number,
  viewWidth: number,
): number {
  return viewWidth / (2 * Math.tan((fovDeg * Math.PI) / 360) * aspect)
}

/** 正交视野宽度 → zoom（drei OrthographicCamera 视锥宽 = 视口像素宽，视野宽 = 视锥宽 / zoom） */
export function orthoZoomForViewWidth(viewportWidthPx: number, viewWidth: number): number {
  return viewportWidthPx / viewWidth
}

/** 正交 zoom → 视野宽度（orthoZoomForViewWidth 的逆运算） */
export function orthoViewWidthForZoom(viewportWidthPx: number, zoom: number): number {
  return viewportWidthPx / zoom
}

/** 按视野宽度上下限钳制正交 zoom（视野越宽 zoom 越小） */
export function clampOrthoZoomForViewWidth(
  zoom: number,
  viewportWidthPx: number,
  minViewWidth: number,
  maxViewWidth: number,
): number {
  return Math.min(
    orthoZoomForViewWidth(viewportWidthPx, minViewWidth),
    Math.max(orthoZoomForViewWidth(viewportWidthPx, maxViewWidth), zoom),
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 模式切换目的地解算参数（常量由场景层自 config/constants.ts 注入） */
export interface CameraTransitionParams {
  /** 透视垂直视场角（度，视野宽度 ↔ 距离换算用） */
  fovDeg: number
  /** 视口宽高比 */
  aspect: number
  /** 视口宽度（像素；drei OrthographicCamera 视锥宽 = 视口像素宽） */
  viewportWidthPx: number
  /** 正交俯视：相机离关注点高度（米） */
  orthoHeight: number
  /** 正交俯视极角（弧度，≈0 防 y-up lookAt 退化；方位角恒 0） */
  topdownPolarRad: number
  /** 正交俯视视野宽度上下限（米，换算 zoom 钳制） */
  orthoViewWidthMin: number
  orthoViewWidthMax: number
  /** 俯视切回透视的默认极角（弧度） */
  orbitReturnPolarRad: number
  /** 进入俯视前的方位角记忆（切回透视时恢复环绕朝向） */
  azimuthMemory: number
  /** 透视距离上下限（俯视切回时匹配距离的钳制，SPEC §8.1 距离 5~400m） */
  distanceMin: number
  distanceMax: number
  /**
   * 跟随目标关注点世界坐标瞬时值（场景层注入，每帧直读模拟瞬时值，不经 React 状态）；
   * 返回 null = 目标暂不可得，目的地原地驻留（无跳变），过渡结束后由跟随步进接管。
   */
  resolveFollowTarget: () => Vector3 | null
}

/** 一次模式切换过渡：起点姿态（以新相机口径表达）+ 目的地解析闭包 */
export interface CameraTransition {
  /**
   * 过渡起点：切换瞬间姿态的拷贝；进入俯视时 zoom 已按取景宽度匹配为正交口径、
   * 切回透视时 zoom 归 1——过渡起始帧取景与旧相机一致，零跳变。
   */
  from: CameraPose
  /** 目的地解析（写入 out）：跟随目标在动时每帧重算，其余模式为固定值 */
  resolveTo: (out: CameraPose) => void
}

/**
 * 构建模式切换过渡（SPEC §8.1：约 0.5s 位置 / 目标点插值平滑过渡，无跳变）：
 *
 * - → 正交俯视：关注点固定为切换瞬间值，相机升至正上方（极角 ≈0、方位角 0，
 *   屏幕右 = 世界 +X、屏幕上 = 世界 -Z 的 2D 地图视角），zoom 按当前透视取景宽度匹配；
 * - → 自由 Orbit：自俯视切回时按正交视野宽度反算透视距离（钳制 5~400m）、
 *   默认极角 + 进入俯视前的方位角记忆；自跟随退出时原地驻留（姿态不变即平滑）；
 * - → AGV 跟随：目的地每帧解析目标当前位置（目标在动仍收敛），环绕球面参数
 *   保持切换瞬间值（自俯视进入时先按切回透视口径落地），取景无跳变。
 */
export function buildCameraTransition(
  toMode: CameraRigMode,
  fromMode: CameraRigMode,
  fromPose: CameraPose,
  params: CameraTransitionParams,
): CameraTransition {
  if (toMode === 'topdown') {
    // 起点 zoom 与目的地 zoom 同取取景匹配值：过渡全程视野宽度不变，仅机位升顶
    const matchedZoom =
      fromMode === 'topdown'
        ? fromPose.zoom
        : clampOrthoZoomForViewWidth(
            orthoZoomForViewWidth(
              params.viewportWidthPx,
              perspectiveViewWidth(params.fovDeg, params.aspect, fromPose.radius),
            ),
            params.viewportWidthPx,
            params.orthoViewWidthMin,
            params.orthoViewWidthMax,
          )
    const target = fromPose.target.clone()
    return {
      from: { target: target.clone(), radius: fromPose.radius, polar: fromPose.polar, azimuth: fromPose.azimuth, zoom: matchedZoom },
      resolveTo: (out) => {
        out.target.copy(target)
        out.radius = params.orthoHeight
        out.polar = params.topdownPolarRad
        out.azimuth = 0
        out.zoom = matchedZoom
      },
    }
  }

  // 透视目的地球面参数：自俯视切回 → 按视野宽度匹配距离 + 默认极角 + 方位角记忆；
  // 其余（orbit ↔ follow）保持切换瞬间的环绕位姿
  const spherical =
    fromMode === 'topdown'
      ? {
          radius: clamp(
            perspectiveDistanceForViewWidth(
              params.fovDeg,
              params.aspect,
              orthoViewWidthForZoom(params.viewportWidthPx, fromPose.zoom),
            ),
            params.distanceMin,
            params.distanceMax,
          ),
          polar: params.orbitReturnPolarRad,
          azimuth: params.azimuthMemory,
        }
      : { radius: fromPose.radius, polar: fromPose.polar, azimuth: fromPose.azimuth }

  if (toMode === 'follow') {
    return {
      from: { ...clonePose(fromPose), zoom: 1 },
      resolveTo: (out) => {
        const target = params.resolveFollowTarget()
        if (target === null) {
          out.target.copy(fromPose.target)
          out.radius = fromPose.radius
          out.polar = fromPose.polar
          out.azimuth = fromPose.azimuth
          out.zoom = 1
          return
        }
        out.target.copy(target)
        out.radius = spherical.radius
        out.polar = spherical.polar
        out.azimuth = spherical.azimuth
        out.zoom = 1
      },
    }
  }

  // orbit：自俯视切回 → 匹配位姿；自跟随退出 → 原地驻留
  const fixedTarget = fromPose.target.clone()
  return {
    from: { ...clonePose(fromPose), zoom: 1 },
    resolveTo: (out) => {
      out.target.copy(fixedTarget)
      out.radius = spherical.radius
      out.polar = spherical.polar
      out.azimuth = spherical.azimuth
      out.zoom = 1
    },
  }
}
