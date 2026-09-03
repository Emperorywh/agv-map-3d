/**
 * 交通锁资源聚合与几何构建（SPEC §5.3、§5.1、§7.2；TASK-012；P1-8 视觉差距修订）。
 *
 * 职责：把全车队快照中的 trafficShapeResources 聚合为「单个合批动态
 *       BufferGeometry」——按车归一化矩形（无效逐项跳过）、以 100ms 窗口
 *       合并高频更新、只在规范化几何签名（哈希组合）变化时重建几何并换入
 *       场景网格；locked 红、applying 黄经顶点色表达。本模块拥有网格、材质
 *       与当前几何，资源生命周期自管（dispose 幂等）。材质附带交通锁脉冲
 *       uniforms（SPEC §6.5 行动 3「关闭交通锁脉冲」的效果本体）：uTime 由
 *       组件层逐帧写入，uLockPulseEnabled=0 时恒定不透明度（TASK-014 质量
 *       3 级经能力开关关闭）。
 *       P1-8 表达增强（不放大业务形状——矩形是调度系统上报的真实闭锁/申请
 *       范围）：面板抬升至 TRAFFIC_LOCK_Y_M（悬浮面板感）、透明度 0.5、边
 *       缘亮色描边条带（同材质、顶点色 ×亮度）与面板中央「已锁定/申请中」
 *       文字贴花（静态两格 Canvas 图集；Canvas 不可用时降级为无文字）。
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
 *    且网格不可见，绝不提交空几何。面板/描边/文字三张几何同签同换；
 * 5. 描边与文字是纯视觉增强：描边复用面板材质（脉冲同步），文字贴花静态
 *    图集不参与签名（内容恒定），矩形业务形状与尺寸零改动。
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
  TRAFFIC_LOCK_BORDER_BRIGHTNESS,
  TRAFFIC_LOCK_BORDER_LIFT_M,
  TRAFFIC_LOCK_BORDER_WIDTH_M,
  TRAFFIC_LOCK_FONT_FAMILY,
  TRAFFIC_LOCK_OPACITY,
  TRAFFIC_LOCK_TEXT_CELL_PX,
  TRAFFIC_LOCK_TEXT_COLOR,
  TRAFFIC_LOCK_TEXT_HEIGHT_M,
  TRAFFIC_LOCK_TEXT_STROKE_COLOR,
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

/** 面板文字贴花文案（与顶点色顺序一致：locked 在前） */
const LOCKED_TEXT = '已锁定'
const APPLYING_TEXT = '申请中'

/** 一次几何重建的产物：面板 / 描边 / 文字三张同签同换的合批几何 */
interface TrafficGeometrySet {
  readonly panel: THREE.BufferGeometry
  readonly border: THREE.BufferGeometry
  readonly text: THREE.BufferGeometry | null
}

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
  /** 边缘亮色描边网格（P1-8）：复用面板材质，几何与面板同签同换 */
  readonly borderMesh: THREE.Mesh
  /** 面板文字贴花网格（P1-8）：静态两格图集；Canvas 不可用时恒不可见 */
  readonly textMesh: THREE.Mesh
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

  // 描边网格（P1-8）：与面板共享材质（脉冲与透明度同步），顶点色带亮度乘数
  const borderMesh = new THREE.Mesh(emptyGeometry, material)
  borderMesh.name = 'traffic-lock-borders'
  borderMesh.matrixAutoUpdate = false
  borderMesh.frustumCulled = false
  borderMesh.renderOrder = 3
  borderMesh.raycast = () => {}
  borderMesh.visible = false

  // 文字贴花网格（P1-8）：静态两格图集（Canvas 不可用 → 恒不可见降级）
  const textTexture = createTrafficTextTexture()
  const textMaterial = new THREE.MeshBasicMaterial({
    map: textTexture,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  textMaterial.name = 'traffic-lock-text'
  const textMesh = new THREE.Mesh(emptyGeometry, textMaterial)
  textMesh.name = 'traffic-lock-texts'
  textMesh.matrixAutoUpdate = false
  textMesh.frustumCulled = false
  textMesh.renderOrder = 4
  textMesh.raycast = () => {}
  textMesh.visible = false

  /** 每车归一化缓存：键为实体键，随实体消失清理 */
  const cacheByEntity = new Map<string, EntityTrafficCache>()
  /** 上一次重建的规范化签名；null 表示尚未建立 */
  let lastSignature: string | null = null
  /** 上一次签名检查时刻；-Infinity 保证首次 sync 立即结算 */
  let lastCheckAt = -Infinity
  /** 世界变换代际：引用变化即强制重建（视图原子替换） */
  let lastTransform: WorldTransform | null = null
  /** 当前已换入网格的几何；null 表示无几何（网格不可见） */
  let currentSet: TrafficGeometrySet | null = null
  let disposed = false

  const hideAndClear = (): void => {
    mesh.geometry = emptyGeometry
    borderMesh.geometry = emptyGeometry
    textMesh.geometry = emptyGeometry
    mesh.visible = false
    borderMesh.visible = false
    textMesh.visible = false
  }

  const dispose = (): void => {
    // 幂等：StrictMode 重复清理与重挂载路径都安全
    if (disposed) {
      return
    }
    disposed = true
    if (currentSet !== null) {
      disposeGeometrySet(currentSet)
    }
    hideAndClear()
    emptyGeometry.dispose()
    material.dispose()
    textTexture?.dispose()
    textMaterial.dispose()
    currentSet = null
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
    const next = buildGeometrySet(cacheByEntity, worldTransform, textTexture !== null)
    const previous = currentSet
    if (next === null) {
      hideAndClear()
    } else {
      mesh.geometry = next.panel
      borderMesh.geometry = next.border
      textMesh.geometry = next.text ?? emptyGeometry
      mesh.visible = true
      borderMesh.visible = true
      textMesh.visible = next.text !== null
    }
    currentSet = next
    // 空几何占位被复用，绝不释放；真实旧几何在同一同步块内安全释放
    if (previous !== null) {
      disposeGeometrySet(previous)
    }
    return true
  }

  return { mesh, borderMesh, textMesh, pulseUniforms, sync, dispose }
}

/** 释放一次重建产物中的真实几何（null 成员跳过） */
function disposeGeometrySet(set: TrafficGeometrySet): void {
  set.panel.dispose()
  set.border.dispose()
  set.text?.dispose()
}

/**
 * 面板文字静态图集（P1-8）：两张单元（locked「已锁定」/ applying「申请中」），
 * 白字 + 深描边保证红/黄底上都可读。Canvas 不可用（无头测试环境）返回 null，
 * 文字网格恒不可见（降级不阻断）。
 */
function createTrafficTextTexture(): THREE.CanvasTexture | null {
  const canvas = document.createElement('canvas')
  canvas.width = TRAFFIC_LOCK_TEXT_CELL_PX * 2
  canvas.height = TRAFFIC_LOCK_TEXT_CELL_PX / 4
  const ctx = canvas.getContext('2d')
  if (ctx === null) {
    return null
  }
  const cellH = canvas.height
  ctx.clearRect(0, 0, canvas.width, cellH)
  ctx.font = `600 ${Math.round(cellH * 0.62)}px ${TRAFFIC_LOCK_FONT_FAMILY}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  for (const [cell, text] of [
    [0, LOCKED_TEXT],
    [1, APPLYING_TEXT],
  ] as const) {
    const cx = cell * TRAFFIC_LOCK_TEXT_CELL_PX + TRAFFIC_LOCK_TEXT_CELL_PX / 2
    ctx.strokeStyle = TRAFFIC_LOCK_TEXT_STROKE_COLOR
    ctx.lineWidth = Math.round(cellH * 0.09)
    ctx.strokeText(text, cx, cellH / 2)
    ctx.fillStyle = TRAFFIC_LOCK_TEXT_COLOR
    ctx.fillText(text, cx, cellH / 2)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
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
 * P1-8：同时产出面板（原语义不变）、边缘亮色描边条带（顶点色 ×亮度）与
 * 「已锁定/申请中」文字贴花（uv 指向静态图集单元；withText=false 时省略）。
 */
function buildGeometrySet(
  cacheByEntity: Map<string, EntityTrafficCache>,
  worldTransform: WorldTransform,
  withText: boolean,
): TrafficGeometrySet | null {
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
  const borderPositions = new Float32Array(quadCount * 16 * 3)
  const borderColors = new Float32Array(quadCount * 16 * 3)
  const borderIndices = new Uint16Array(quadCount * 24)
  const textPositions = withText ? new Float32Array(quadCount * 4 * 3) : null
  const textUvs = withText ? new Float32Array(quadCount * 4 * 2) : null
  const textIndices = withText ? new Uint16Array(quadCount * 6) : null
  const lockedColor = new THREE.Color(LOCKED_COLOR)
  const applyingColor = new THREE.Color(APPLYING_COLOR)
  const borderY = TRAFFIC_LOCK_Y_M + TRAFFIC_LOCK_BORDER_LIFT_M

  let quad = 0
  const appendQuad = (rect: NormalizedTrafficRectangle, color: THREE.Color): void => {
    const base = quad * 4
    const world: { x: number; z: number }[] = []
    for (let i = 0; i < 4; i += 1) {
      const point = rect.points[i]
      const w = worldTransform.toWorldXZ(point.x, point.y)
      world.push(w)
      positions[(base + i) * 3] = w.x
      positions[(base + i) * 3 + 1] = TRAFFIC_LOCK_Y_M
      positions[(base + i) * 3 + 2] = w.z
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

    // —— 边缘亮色描边：4 条边各一条窄条带（几何居中于边上，半在面板外）——
    const brightR = color.r * TRAFFIC_LOCK_BORDER_BRIGHTNESS
    const brightG = color.g * TRAFFIC_LOCK_BORDER_BRIGHTNESS
    const brightB = color.b * TRAFFIC_LOCK_BORDER_BRIGHTNESS
    const bw = TRAFFIC_LOCK_BORDER_WIDTH_M / 2
    for (let e = 0; e < 4; e += 1) {
      const p = world[e]
      const q = world[(e + 1) % 4]
      const dx = q.x - p.x
      const dz = q.z - p.z
      const len = Math.hypot(dx, dz)
      const vBase = base * 4 + e * 4
      if (len < 1e-9) {
        // 退化边：写零缩放意义上的重合顶点（索引仍指向它，面积贡献为零）
        for (let v = 0; v < 4; v += 1) {
          borderPositions[(vBase + v) * 3] = p.x
          borderPositions[(vBase + v) * 3 + 1] = borderY
          borderPositions[(vBase + v) * 3 + 2] = p.z
        }
      } else {
        const nx = (-dz / len) * bw
        const nz = (dx / len) * bw
        const corners = [
          { x: p.x + nx, z: p.z + nz },
          { x: p.x - nx, z: p.z - nz },
          { x: q.x - nx, z: q.z - nz },
          { x: q.x + nx, z: q.z + nz },
        ]
        for (let v = 0; v < 4; v += 1) {
          borderPositions[(vBase + v) * 3] = corners[v].x
          borderPositions[(vBase + v) * 3 + 1] = borderY
          borderPositions[(vBase + v) * 3 + 2] = corners[v].z
        }
      }
      for (let v = 0; v < 4; v += 1) {
        borderColors[(vBase + v) * 3] = brightR
        borderColors[(vBase + v) * 3 + 1] = brightG
        borderColors[(vBase + v) * 3 + 2] = brightB
      }
      const bi = quad * 24 + e * 6
      borderIndices[bi] = vBase
      borderIndices[bi + 1] = vBase + 1
      borderIndices[bi + 2] = vBase + 2
      borderIndices[bi + 3] = vBase
      borderIndices[bi + 4] = vBase + 2
      borderIndices[bi + 5] = vBase + 3
    }

    // —— 面板中央文字贴花：沿矩形长轴方向的一块四边形，uv 指向图集单元 ——
    if (textPositions !== null && textUvs !== null && textIndices !== null) {
      const cx = (world[0].x + world[1].x + world[2].x + world[3].x) / 4
      const cz = (world[0].z + world[1].z + world[2].z + world[3].z) / 4
      let longLen = 0
      let angle = 0
      for (let e = 0; e < 4; e += 1) {
        const p = world[e]
        const q = world[(e + 1) % 4]
        const len = Math.hypot(q.x - p.x, q.z - p.z)
        if (len > longLen) {
          longLen = len
          angle = Math.atan2(q.z - p.z, q.x - p.x)
        }
      }
      // 归一到 (−π/2, π/2]：文字不颠倒（左右翻转由读向保证，俯视 180° 翻转
      // 比上下颠倒更可读）
      while (angle > Math.PI / 2) {
        angle -= Math.PI
      }
      while (angle <= -Math.PI / 2) {
        angle += Math.PI
      }
      const cellAspect = 4
      const maxW = longLen * 0.85
      const h = Math.min(TRAFFIC_LOCK_TEXT_HEIGHT_M, maxW / cellAspect)
      const w = h * cellAspect
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const corners = [
        { lx: -w / 2, lz: -h / 2 },
        { lx: w / 2, lz: -h / 2 },
        { lx: w / 2, lz: h / 2 },
        { lx: -w / 2, lz: h / 2 },
      ]
      const u0 = color === lockedColor ? 0 : 0.5
      const u1 = u0 + 0.5
      const uvs = [
        [u0, 0],
        [u1, 0],
        [u1, 1],
        [u0, 1],
      ]
      for (let v = 0; v < 4; v += 1) {
        textPositions[(base + v) * 3] = cx + corners[v].lx * cos - corners[v].lz * sin
        textPositions[(base + v) * 3 + 1] = borderY
        textPositions[(base + v) * 3 + 2] = cz + corners[v].lx * sin + corners[v].lz * cos
        textUvs[(base + v) * 2] = uvs[v][0]
        textUvs[(base + v) * 2 + 1] = uvs[v][1]
      }
      textIndices.set([base, base + 1, base + 2, base, base + 2, base + 3], quad * 6)
    }

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

  const panel = new THREE.BufferGeometry()
  panel.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  panel.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  panel.setIndex(new THREE.BufferAttribute(indices, 1))

  const border = new THREE.BufferGeometry()
  border.setAttribute('position', new THREE.BufferAttribute(borderPositions, 3))
  border.setAttribute('color', new THREE.BufferAttribute(borderColors, 3))
  border.setIndex(new THREE.BufferAttribute(borderIndices, 1))

  let text: THREE.BufferGeometry | null = null
  if (textPositions !== null && textUvs !== null && textIndices !== null) {
    text = new THREE.BufferGeometry()
    text.setAttribute('position', new THREE.BufferAttribute(textPositions, 3))
    text.setAttribute('uv', new THREE.BufferAttribute(textUvs, 2))
    text.setIndex(new THREE.BufferAttribute(textIndices, 1))
  }

  return { panel, border, text }
}
