/**
 * 场景细节等级控制器（视觉对齐改造 P0-5.1）。
 *
 * 职责：持有当前 SceneDetailLevel 与跨材质共享的 uSceneLevel uniform 对象，
 *       每帧由场景侧驱动组件用「相机到关注地面点的距离」刷新等级（带迟
 *       滞），全部地图图层材质经同一 uniform 对象读取等级，在 GPU 侧完成
 *       按角色显隐——等级跃迁是低频事件，绝不进 React state。
 * 边界：控制器是纯 JS 对象（无 GPU 资源、无订阅），由 MapVisualizationFeature
 *       以地图对角线创建并下发给各图层；相机读取归驱动组件（React 侧），
 *       本模块只提供从相机位姿到聚焦距离的纯函数。
 * 关键不变量：
 * 1. uSceneLevel 是共享的单一 uniform 对象：所有材质的 onBeforeCompile 引用
 *       同一实例，控制器写一次全场景生效；
 * 2. 聚焦距离 = 相机沿视线方向到 y=0 地面交点的距离（俯视/轨道/跟随视角
 *       下即「看向的区域」）；视线不指向地面（近水平或朝上）时以相机高度
 *       推算保守距离（假设 30° 俯角），保证永远产出有限正值。
 */
import { Vector3, type PerspectiveCamera } from 'three'
import {
  resolveSceneDetailLevel,
  type SceneDetailLevel,
} from './sceneDetail'

/** 共享给全部场景等级门控材质的 uniform 包 */
export interface SceneDetailUniforms {
  /** 当前场景细节等级（0/1/2；控制器逐帧写入） */
  readonly uSceneLevel: { value: number }
}

export interface SceneDetailController {
  readonly uniforms: SceneDetailUniforms
  /** 当前等级（迟滞后的真值，诊断与测试用） */
  readonly level: SceneDetailLevel
  /** 以聚焦距离刷新等级；等级变化时返回新等级（否则 null） */
  update(focusDistanceM: number): SceneDetailLevel | null
}

export function createSceneDetailController(diagonalM: number): SceneDetailController {
  let level: SceneDetailLevel = 0
  const uniforms: SceneDetailUniforms = { uSceneLevel: { value: level } }
  return {
    uniforms,
    get level() {
      return level
    },
    update(focusDistanceM) {
      const next = resolveSceneDetailLevel(level, focusDistanceM, diagonalM)
      if (next === level) {
        return null
      }
      level = next
      uniforms.uSceneLevel.value = next
      return next
    },
  }
}

/** 视线不指向地面时的保守俯角（度）：以相机高度反推聚焦距离 */
const FALLBACK_PITCH_DEG = 30

/**
 * 由相机位姿计算聚焦距离：视线与地面 y=0 的交点到相机的距离。
 * 俯视轨道、跟随与近景视角下即「当前看向区域」的距离，是场景等级的
 * 唯一驱动量（视觉对齐 P0-5.1：由相机距离与关注区域决定）。
 */
export function computeCameraFocusDistance(camera: PerspectiveCamera): number {
  const position = camera.position
  camera.getWorldDirection(DIR_SCRATCH)
  if (DIR_SCRATCH.y < -1e-4) {
    // 视线指向地面：t = -py / dy 为地面交点参数，距离 = |t·dir|
    const t = -position.y / DIR_SCRATCH.y
    if (Number.isFinite(t) && t > 0) {
      return t * DIR_SCRATCH.length()
    }
  }
  // 视线近水平或朝上：按保守俯角由高度反推
  const pitchRad = (FALLBACK_PITCH_DEG * Math.PI) / 180
  return Math.max(position.y, 0) / Math.sin(pitchRad)
}

/** 模块级方向向量暂存（每帧复用，避免分配） */
const DIR_SCRATCH = new Vector3()
