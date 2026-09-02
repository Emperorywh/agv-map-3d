/**
 * 交通锁资源聚合与几何构建（SPEC §5.3、§5.1、§7.2；TASK-012）。
 *
 * 职责：把全车队快照中的 trafficShapeResources 聚合为「单个合批动态
 *       BufferGeometry」——按车归一化矩形（无效逐项跳过）、以 100ms 窗口
 *       合并高频更新、只在规范化几何签名（哈希组合）变化时重建几何并换入
 *       场景网格；locked 红、applying 黄经顶点色表达。本模块拥有网格、材质
 *       与当前几何，资源生命周期自管（dispose 幂等）。材质附带交通锁脉冲
 *       uniforms（SPEC §6.5 行动 3「关闭交通锁脉冲」的效果本体）：uTime 由
 *       组件层逐帧写入，uLockPulseEnabled=0 时恒定不透明度（TASK-014 质量
 *       3 级经能力开关关闭）。
 * 边界：不判定 INVALID_DATA 告警（告警派生属 model/deriveVehicleState，本
 *       模块只负责「无效矩形不进入几何」）；不做坐标换算以外的任何业务解释；
 *       世界变换由调用方注入（app 组合层口径，SPEC §12.4）；不感知 React——
 *       组件层只挂载 mesh 并在 useFrame 中调用 sync。
 * 关键不变量：
 * 1. 重建判据唯一：规范化哈希组合签名（按 kind + 哈希排序后拼接）不变就绝
 *    不重建——2Hz 增量流中几何未变的矩形不触发任何 GPU 上传（SPEC §5.3）；
 * 2. 100ms 合并窗口：两次「检查签名」之间至少间隔 windowMs，窗口内到达的
 *    多条更新在窗口边界一次结算（世界变换换代除外——视图代际切换必须原子
 *    跟上，立即重建）；
 * 3. 每车归一化按快照引用缓存：同一快照对象不重复做几何裁决；无矩形或全部
 *    无效的车辆不产生几何，也不参与签名；
 * 4. 几何为索引三角化：凸四边形固定索引 (0,1,2)(0,2,3)，顶点色按 kind 常量
 *    （locked 红 / applying 黄，与标签边框配色同源）；无矩形时几何为 null
 *    且网格不可见，绝不提交空几何。
 */
import * as THREE from 'three'
import type { WorldTransform } from '@/shared/spatial'
import type { ReadonlyFleetEntity } from '../model/createFleetRuntime'
import {
  normalizeTrafficRectangle,
  type NormalizedTrafficRectangle,
} from '../model/trafficRectangle'
import {
  LABEL_BORDER_L1_COLOR,
  LABEL_BORDER_L2_COLOR,
  TRAFFIC_LOCK_OPACITY,
  TRAFFIC_LOCK_Y_M,
  TRAFFIC_PULSE_MIN,
  TRAFFIC_PULSE_PERIOD_S,
} from './fleetAppearance'

/** 默认合并窗口（毫秒，SPEC §5.3「交通资源更新按 100ms 窗口合并」） */
export const TRAFFIC_MERGE_WINDOW_MS = 100

/** locked 矩形顶点色（与 L2 告警红同源） */
const LOCKED_COLOR = LABEL_BORDER_L2_COLOR
/** applying 矩形顶点色（与 L1 告警黄同源） */
const APPLYING_COLOR = LABEL_BORDER_L1_COLOR

/** 单车的交通矩形归一化缓存（快照引用为差量依据） */
interface EntityTrafficCache {
  snapshot: unknown
  readonly locked: NormalizedTrafficRectangle[]
  readonly applying: NormalizedTrafficRectangle[]
}

export interface TrafficLocksResourcesOptions {
  /** 合并窗口毫秒数；默认 100（测试可注入更小/更大值） */
  windowMs?: number
}

/** 交通锁图层资源：场景网格 + 聚合状态；组件层只挂载 mesh 并驱动 sync */
export interface TrafficLocksResources {
  /** 常驻场景网格：几何随重建更换，无矩形时不可见 */
  readonly mesh: THREE.Mesh
  /**
   * 交通锁脉冲 uniforms（SPEC §6.5 行动 3 的可关效果本体；TASK-014）：
   * uTime 由组件层逐帧写入，uLockPulseEnabled=0 时恒定不透明度
   * （质量 3 级关闭脉冲）。uniforms 创建即存在，编译前后均可读写。
   */
  readonly pulseUniforms: {
    readonly uTime: { value: number }
    readonly uLockPulseEnabled: { value: number }
  }
  /**
   * 采集一帧实体并按需重建几何。
   * 返回 true 表示本次调用发生了几何重建（网格几何对象已更换）。
   */
  sync(
    entities: readonly ReadonlyFleetEntity[],
    worldTransform: WorldTransform,
    nowMs: number,
  ): boolean
  /** 幂等释放网格、当前几何与材质 */
  dispose(): void
}

/**
 * 交通锁材质：顶点色（locked 红 / applying 黄）+ 脉冲 alpha 调制。脉冲经
 * onBeforeCompile 注入最小 GLSL——uLockPulseEnabled=0 时系数恒为 1（恒定
 * 不透明度），几何与顶点色语义不受影响；customProgramCacheKey 声明注入身份，
 * 避免与其他补丁材质共享编译缓存。
 */
function createTrafficLockMaterial(): THREE.MeshBasicMaterial {
  const uniforms = {
    uTime: { value: 0 },
    uLockPulseEnabled: { value: 1 },
    uLockPulsePeriod: { value: TRAFFIC_PULSE_PERIOD_S },
    uLockPulseMin: { value: TRAFFIC_PULSE_MIN },
  }
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: TRAFFIC_LOCK_OPACITY,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  material.name = 'fleet-traffic-lock'
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime
    shader.uniforms.uLockPulseEnabled = uniforms.uLockPulseEnabled
    shader.uniforms.uLockPulsePeriod = uniforms.uLockPulsePeriod
    shader.uniforms.uLockPulseMin = uniforms.uLockPulseMin
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform float uTime;',
          'uniform float uLockPulseEnabled;',
          'uniform float uLockPulsePeriod;',
          'uniform float uLockPulseMin;',
        ].join('\n'),
      )
      .replace(
        '#include <opaque_fragment>',
        [
          '#include <opaque_fragment>',
          'float lockWave = 0.5 + 0.5 * sin( uTime * 6.28318530718 / max( uLockPulsePeriod, 0.001 ) );',
          'float lockFactor = mix( 1.0, uLockPulseMin + ( 1.0 - uLockPulseMin ) * lockWave, uLockPulseEnabled );',
          'gl_FragColor.a *= lockFactor;',
        ].join('\n'),
      )
  }
  material.customProgramCacheKey = () => 'fleet-traffic-lock'
  material.userData.uniforms = uniforms
  return material
}

export function createTrafficLocksResources(
  options: TrafficLocksResourcesOptions = {},
): TrafficLocksResources {
  const windowMs = options.windowMs ?? TRAFFIC_MERGE_WINDOW_MS

  const material = createTrafficLockMaterial()
  const pulseUniforms = material.userData.uniforms as TrafficLocksResources['pulseUniforms']
  /** 无矩形时的共享空几何占位：网格必须始终持有合法几何，且绝不重复创建 */
  const emptyGeometry = new THREE.BufferGeometry()
  const mesh = new THREE.Mesh(emptyGeometry, material)
  mesh.name = 'traffic-locks'
  mesh.matrixAutoUpdate = false
  mesh.frustumCulled = false // 几何动态重建，包围球不维护，交由 GPU 裁剪关闭
  mesh.renderOrder = 2
  mesh.raycast = () => {} // 交通锁不参与拾取（拾取仅车体外壳，SPEC §5.2）
  mesh.visible = false

  /** 每车归一化缓存：键为实体键，随实体消失清理 */
  const cacheByEntity = new Map<string, EntityTrafficCache>()
  /** 上一次重建的规范化签名；null 表示尚未建立 */
  let lastSignature: string | null = null
  /** 上一次签名检查时刻；-Infinity 保证首次 sync 立即结算 */
  let lastCheckAt = -Infinity
  /** 世界变换代际：引用变化即强制重建（视图原子替换） */
  let lastTransform: WorldTransform | null = null
  /** 当前已换入网格的几何；null 表示无几何（网格不可见） */
  let currentGeometry: THREE.BufferGeometry | null = null
  let disposed = false

  const dispose = (): void => {
    // 幂等：StrictMode 重复清理与重挂载路径都安全
    if (disposed) {
      return
    }
    disposed = true
    if (currentGeometry !== null && currentGeometry !== emptyGeometry) {
      currentGeometry.dispose()
    }
    mesh.geometry = emptyGeometry
    emptyGeometry.dispose()
    material.dispose()
    currentGeometry = null
  }

  const sync = (
    entities: readonly ReadonlyFleetEntity[],
    worldTransform: WorldTransform,
    nowMs: number,
  ): boolean => {
    if (disposed) {
      return false
    }
    const transformChanged = lastTransform !== worldTransform
    lastTransform = worldTransform
    // 合并窗口：窗口内的更新延迟到窗口边界一次结算；换代重建不受窗口限制
    if (!transformChanged && nowMs - lastCheckAt < windowMs) {
      return false
    }
    lastCheckAt = nowMs

    // —— 每车归一化（快照引用缓存）——
    const present = new Set<string>()
    for (const entity of entities) {
      const resources = entity.snapshot.trafficShapeResources
      // 无交通资源的车辆不进入缓存（无几何亦无签名贡献）
      if (
        resources === null ||
        (resources.lockedRectangles.length === 0 && resources.applyingRectangles.length === 0)
      ) {
        continue
      }
      present.add(entity.key)
      let cache = cacheByEntity.get(entity.key)
      if (cache === undefined || cache.snapshot !== entity.snapshot) {
        cache = {
          snapshot: entity.snapshot,
          locked: normalizeAll(resources.lockedRectangles),
          applying: normalizeAll(resources.applyingRectangles),
        }
        cacheByEntity.set(entity.key, cache)
      }
    }
    for (const key of [...cacheByEntity.keys()]) {
      if (!present.has(key)) {
        cacheByEntity.delete(key)
      }
    }

    // —— 规范化签名：kind + 哈希排序拼接（与车辆顺序无关）——
    const hashes: string[] = []
    for (const cache of cacheByEntity.values()) {
      for (const rect of cache.locked) {
        hashes.push(`L${rect.hash}`)
      }
      for (const rect of cache.applying) {
        hashes.push(`A${rect.hash}`)
      }
    }
    hashes.sort()
    const signature = hashes.join('|')
    if (!transformChanged && signature === lastSignature) {
      return false
    }
    lastSignature = signature

    // —— 重建：旧几何换出后立即释放（同一同步块内不会渲染）——
    const next = buildGeometry(cacheByEntity, worldTransform)
    const previous = currentGeometry
    if (next === null) {
      mesh.geometry = emptyGeometry
      mesh.visible = false
    } else {
      mesh.geometry = next
      mesh.visible = true
    }
    currentGeometry = next
    // 空几何占位被复用，绝不释放；真实旧几何在同一同步块内安全释放
    if (previous !== null && previous !== emptyGeometry) {
      previous.dispose()
    }
    return true
  }

  return { mesh, pulseUniforms, sync, dispose }
}

/** 逐项归一化：无效矩形静默跳过（INVALID_DATA 告警由模型层负责） */
function normalizeAll(rects: readonly unknown[]): NormalizedTrafficRectangle[] {
  const result: NormalizedTrafficRectangle[] = []
  for (const rect of rects) {
    const normalized = normalizeTrafficRectangle(rect)
    if (normalized !== null) {
      result.push(normalized)
    }
  }
  return result
}

/**
 * 由缓存构建合批几何：世界坐标顶点 + 顶点色 + 凸四边形固定索引三角化。
 * 全部矩形无效或无矩形时返回 null（调用方将网格置为不可见）。
 */
function buildGeometry(
  cacheByEntity: Map<string, EntityTrafficCache>,
  worldTransform: WorldTransform,
): THREE.BufferGeometry | null {
  let quadCount = 0
  for (const cache of cacheByEntity.values()) {
    quadCount += cache.locked.length + cache.applying.length
  }
  if (quadCount === 0) {
    return null
  }

  const positions = new Float32Array(quadCount * 4 * 3)
  const colors = new Float32Array(quadCount * 4 * 3)
  const indices = new Uint16Array(quadCount * 6)
  const lockedColor = new THREE.Color(LOCKED_COLOR)
  const applyingColor = new THREE.Color(APPLYING_COLOR)

  let quad = 0
  const appendQuad = (rect: NormalizedTrafficRectangle, color: THREE.Color): void => {
    const base = quad * 4
    for (let i = 0; i < 4; i += 1) {
      const point = rect.points[i]
      const world = worldTransform.toWorldXZ(point.x, point.y)
      positions[(base + i) * 3] = world.x
      positions[(base + i) * 3 + 1] = TRAFFIC_LOCK_Y_M
      positions[(base + i) * 3 + 2] = world.z
      colors[(base + i) * 3] = color.r
      colors[(base + i) * 3 + 1] = color.g
      colors[(base + i) * 3 + 2] = color.b
    }
    // 凸四边形固定索引三角化（顶点为逆时针环，SPEC §5.3 第 4 步）
    const indexBase = quad * 6
    indices[indexBase] = base
    indices[indexBase + 1] = base + 1
    indices[indexBase + 2] = base + 2
    indices[indexBase + 3] = base
    indices[indexBase + 4] = base + 2
    indices[indexBase + 5] = base + 3
    quad += 1
  }

  for (const cache of cacheByEntity.values()) {
    for (const rect of cache.locked) {
      appendQuad(rect, lockedColor)
    }
    for (const rect of cache.applying) {
      appendQuad(rect, applyingColor)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  return geometry
}
