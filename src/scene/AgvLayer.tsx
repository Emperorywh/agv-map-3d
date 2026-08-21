import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { DoubleSide, InstancedBufferAttribute, Vector3 } from 'three'
import type { InstancedMesh, WebGLProgramParametersWithUniforms } from 'three'
import { useFrame } from '@react-three/fiber'

import {
  AGV_BACK_SPEED_FACTOR,
  AGV_BODY_LENGTH,
  AGV_BODY_WIDTH,
  AGV_CHASSIS_HEIGHT,
  AGV_COVER_HEIGHT,
  AGV_COVER_LENGTH,
  AGV_COVER_REAR_OFFSET,
  AGV_COVER_WIDTH,
  AGV_DEFAULT_COUNT,
  AGV_HEADLIGHT_DEPTH,
  AGV_HEADLIGHT_HEIGHT,
  AGV_HEADLIGHT_INSET,
  AGV_HEADLIGHT_LIFT,
  AGV_HEADLIGHT_WIDTH,
  AGV_LABEL_ANCHOR_HEIGHT,
  AGV_LABEL_FONT_HEIGHT,
  AGV_STATUS_RING_LIFT,
  AGV_STATUS_RING_RADIUS,
  AGV_STATUS_RING_TUBE,
  AGV_WEDGE_HEIGHT,
  AGV_WEDGE_LENGTH,
  AGV_WEDGE_WIDTH,
  BATTERY_CHARGE_PER_SECOND,
  BATTERY_DRAIN_PER_METER,
  BATTERY_LOW_THRESHOLD,
  LABEL_ATLAS_CELL_SIZE,
  LABEL_ATLAS_FONT_SIZE,
  LABEL_ATLAS_MAX_SIZE,
  LABEL_FONT_FAMILY,
  LABEL_ORTHO_MAX_VIEW_WIDTH,
  LABEL_PERSPECTIVE_MAX_DISTANCE,
  SIM_DEFAULT_ACCELERATION,
  SIM_DEFAULT_DECELERATION,
  SIM_DEFAULT_MAX_SPEED,
  SIM_DEFAULT_ROTATION_SPEED,
  SIM_FIXED_DT,
  SIM_GRAPH_WEIGHT_MODE,
  SIM_IDLE_RETRY_SECONDS,
  SIM_LOAD_UNLOAD_SECONDS,
  SIM_MAX_FRAME_DELTA,
  SIM_SEED,
  SIM_SNAPSHOT_INTERVAL,
} from '../config/constants'
import { agvBodyColors, agvStatusColors, mapColors } from '../config/theme'
import { createSimulator, snapshotSimulator, stepSimulator } from '../domain/simulator'
import type { SimulatorOptions, SimulatorState } from '../domain/simulator'
import {
  buildAgvBodyGeometry,
  buildAgvStatusRingGeometry,
  resolveAgvStatusColors,
  writeAgvInstanceMatrices,
  writeAgvStatusColors,
} from '../rendering/scene/map/instanceGeometry'
import type { AgvShapeColors, AgvShapeSizes } from '../rendering/scene/map/instanceGeometry'
import { createLabelAtlas } from '../rendering/scene/map/labelAtlas'
import type { LabelAtlas, LabelAtlasOptions } from '../rendering/scene/map/labelAtlas'
import {
  LABEL_LEVEL_KEY,
  buildLabelBatch,
  injectLabelBillboardShader,
  resolveLabelCameraView,
  resolveLabelVisibility,
} from '../rendering/scene/map/labelGeometry'
import type {
  LabelAnchor,
  LabelBatch,
  LabelVisibilityThresholds,
} from '../rendering/scene/map/labelGeometry'
import { useAppStore } from '../state/appStore'

/**
 * AGV 图层（SPEC §7.3）：风格化小车 InstancedMesh（底盘 + 顶盖 + 方向楔形/前灯
 * 合并单几何单 draw call）+ 顶部状态色环（实例色六状态，第二个 InstancedMesh）
 * + 编号标签（复用 §6.4 图集批渲染机制，全部编号单 mesh 单 draw call）。
 * 100 台上限内 draw call 恒为 3，与台数无关（SPEC §9）。
 *
 * 每帧纪律（SPEC §3 / §9）：
 * - useFrame 中以固定步长累积器驱动 stepSimulator（SIM_FIXED_DT，帧间隔大时多步，
 *   单帧推进上限 SIM_MAX_FRAME_DELTA 防追帧螺旋），与帧率解耦；
 * - 每帧仅 in-place 写实例矩阵与色环实例色（writeAgvInstanceMatrices /
 *   writeAgvStatusColors）与标签锚点（LabelBatch.setAnchorPosition），几何零重建；
 * - 模拟状态经 ref / 局部变量瞬时值读取，不触发 React 重渲染；store 仅按
 *   SIM_SNAPSHOT_INTERVAL 低频写入快照（供 TASK-013 / TASK-014 面板节流读取）；
 * - 模拟器实例为组件内单例（useMemo 持有，store 外）；位姿 / 朝向由快照提供
 *   （domain/simulator 内经 coordinates.ts 与 headingToWorldYaw 换算），
 *   本层不做任何坐标取反或二次翻转（倒车姿态由车头朝向语义自然得出，SPEC §7.2）。
 */

/** 模拟器配置：全部由 config/constants.ts 注入（domain 不 import config，SPEC §12） */
const SIMULATOR_OPTIONS: SimulatorOptions = {
  seed: SIM_SEED,
  agvCount: AGV_DEFAULT_COUNT,
  loadUnloadSeconds: SIM_LOAD_UNLOAD_SECONDS,
  idleRetrySeconds: SIM_IDLE_RETRY_SECONDS,
  batteryLowThreshold: BATTERY_LOW_THRESHOLD,
  batteryDrainPerMeter: BATTERY_DRAIN_PER_METER,
  batteryChargePerSecond: BATTERY_CHARGE_PER_SECOND,
  defaultMaxSpeed: SIM_DEFAULT_MAX_SPEED,
  defaultAcceleration: SIM_DEFAULT_ACCELERATION,
  defaultDeceleration: SIM_DEFAULT_DECELERATION,
  defaultRotationSpeed: SIM_DEFAULT_ROTATION_SPEED,
  backSpeedFactor: AGV_BACK_SPEED_FACTOR,
  graphWeightMode: SIM_GRAPH_WEIGHT_MODE,
}

/** AGV 造型尺寸 / 分段色：全部来自 config（SPEC §5.1 / §7.3 常量集中） */
const AGV_SHAPE_SIZES: AgvShapeSizes = {
  bodyLength: AGV_BODY_LENGTH,
  bodyWidth: AGV_BODY_WIDTH,
  chassisHeight: AGV_CHASSIS_HEIGHT,
  coverLength: AGV_COVER_LENGTH,
  coverWidth: AGV_COVER_WIDTH,
  coverHeight: AGV_COVER_HEIGHT,
  coverRearOffset: AGV_COVER_REAR_OFFSET,
  wedgeLength: AGV_WEDGE_LENGTH,
  wedgeWidth: AGV_WEDGE_WIDTH,
  wedgeHeight: AGV_WEDGE_HEIGHT,
  headlightWidth: AGV_HEADLIGHT_WIDTH,
  headlightHeight: AGV_HEADLIGHT_HEIGHT,
  headlightDepth: AGV_HEADLIGHT_DEPTH,
  headlightInset: AGV_HEADLIGHT_INSET,
  headlightLift: AGV_HEADLIGHT_LIFT,
  ringRadius: AGV_STATUS_RING_RADIUS,
  ringTube: AGV_STATUS_RING_TUBE,
  ringLift: AGV_STATUS_RING_LIFT,
}

const AGV_SHAPE_COLORS: AgvShapeColors = {
  chassis: agvBodyColors.chassis,
  cover: agvBodyColors.cover,
  wedge: agvBodyColors.wedge,
  headlight: agvBodyColors.headlight,
}

/** 六状态实例色 RGB 查表（hex 预解析一次，每帧写入不再解析字符串） */
const AGV_STATUS_RGB = resolveAgvStatusColors(agvStatusColors)

/** 编号标签图集参数：与节点标签同一套 config 口径（§6.4 机制复用） */
const AGV_LABEL_ATLAS_OPTIONS: LabelAtlasOptions = {
  cellSize: LABEL_ATLAS_CELL_SIZE,
  fontSize: LABEL_ATLAS_FONT_SIZE,
  fontFamily: LABEL_FONT_FAMILY,
  textColor: mapColors.labelText,
  maxSize: LABEL_ATLAS_MAX_SIZE,
}

/** 编号标签分级阈值：与节点标签同一组 config 常量（AGV 编号恒为等级 0 关键标签） */
const AGV_LABEL_VISIBILITY_THRESHOLDS: LabelVisibilityThresholds = {
  perspectiveMaxDistance: LABEL_PERSPECTIVE_MAX_DISTANCE,
  orthoMaxViewWidth: LABEL_ORTHO_MAX_VIEW_WIDTH,
}

/** AGV 编号标签文本（两位编号；台数上限 100 内恒两位） */
function agvLabelText(agvId: number): string {
  return String(agvId).padStart(2, '0')
}

/** 编号标签锚点 id（LabelBatch 内唯一寻址；与节点 id 命名空间隔离） */
function agvLabelAnchorId(agvId: number): string {
  return `agv:${agvId}`
}

/** 实例矩阵缓冲（three 对 instanceMatrix 固定分配 Float32Array；类型声明为 TypedArray 联合，收窄一次） */
function instanceMatrixArray(mesh: InstancedMesh): Float32Array {
  return mesh.instanceMatrix.array as Float32Array
}

export function AgvLayer() {
  const mapData = useAppStore((state) => state.mapData)
  const labelsVisible = useAppStore((state) => state.layers.labels)
  // 模拟器单例：store 外持有（纯数据容器，创建幂等；StrictMode 双调用结果一致）
  const simulator = useMemo(
    () => (mapData === null ? null : createSimulator(mapData, SIMULATOR_OPTIONS)),
    [mapData],
  )

  const bodyMeshRef = useRef<InstancedMesh>(null)
  const ringMeshRef = useRef<InstancedMesh>(null)
  const labelBatchRef = useRef<LabelBatch | null>(null)
  /** 固定步长累积器 / 低频快照计时（ref，不进渲染路径） */
  const accumulatorRef = useRef(0)
  const snapshotClockRef = useRef(0)

  useFrame((_, delta) => {
    if (simulator === null) {
      return
    }
    // 固定步长推进（SPEC §7.1）：帧间隔大时多步；钳制单帧推进上限，防后台恢复后追帧螺旋
    accumulatorRef.current += Math.min(delta, SIM_MAX_FRAME_DELTA)
    while (accumulatorRef.current >= SIM_FIXED_DT) {
      stepSimulator(simulator, SIM_FIXED_DT)
      accumulatorRef.current -= SIM_FIXED_DT
    }

    // 每帧瞬时值读取（局部变量，不经 React 渲染路径，SPEC §3 / §9）
    const snapshots = snapshotSimulator(simulator)
    const body = bodyMeshRef.current
    const ring = ringMeshRef.current
    if (body !== null && ring !== null) {
      // 只写实例矩阵与实例色，几何零重建（SPEC §7.3）
      writeAgvInstanceMatrices(instanceMatrixArray(body), snapshots)
      body.instanceMatrix.needsUpdate = true
      writeAgvInstanceMatrices(instanceMatrixArray(ring), snapshots)
      ring.instanceMatrix.needsUpdate = true
      if (ring.instanceColor !== null) {
        writeAgvStatusColors(
          ring.instanceColor.array as Float32Array,
          snapshots,
          AGV_STATUS_RGB,
        )
        ring.instanceColor.needsUpdate = true
      }
    }
    const batch = labelBatchRef.current
    if (batch !== null) {
      for (const snapshot of snapshots) {
        batch.setAnchorPosition(
          agvLabelAnchorId(snapshot.id),
          snapshot.position.x,
          AGV_LABEL_ANCHOR_HEIGHT,
          snapshot.position.z,
        )
      }
    }

    // 低频快照写 store（TASK-013 / TASK-014 面板节流读取；每帧路径不进 store）
    snapshotClockRef.current += delta
    if (snapshotClockRef.current >= SIM_SNAPSHOT_INTERVAL) {
      snapshotClockRef.current = 0
      useAppStore.getState().setAgvSnapshot(snapshots)
    }
  })

  if (simulator === null) {
    return null
  }
  return (
    <group>
      <AgvInstances
        simulator={simulator}
        bodyMeshRef={bodyMeshRef}
        ringMeshRef={ringMeshRef}
      />
      <AgvLabels simulator={simulator} visible={labelsVisible} batchRef={labelBatchRef} />
    </group>
  )
}

/**
 * AGV 本体 + 状态色环实例层：两个 InstancedMesh 共享同一份每帧位姿写入；
 * 几何一次性构建（useMemo），运行期零重建。
 */
function AgvInstances({
  simulator,
  bodyMeshRef,
  ringMeshRef,
}: {
  simulator: SimulatorState
  bodyMeshRef: RefObject<InstancedMesh | null>
  ringMeshRef: RefObject<InstancedMesh | null>
}) {
  const count = simulator.agvs.length
  const bodyGeometry = useMemo(() => buildAgvBodyGeometry(AGV_SHAPE_SIZES, AGV_SHAPE_COLORS), [])
  const ringGeometry = useMemo(() => buildAgvStatusRingGeometry(AGV_SHAPE_SIZES), [])
  useEffect(
    () => () => {
      bodyGeometry.dispose()
      ringGeometry.dispose()
    },
    [bodyGeometry, ringGeometry],
  )

  // 首帧前写入初始位姿与状态色（layout effect 保证首帧就绪；之后由 useFrame 每帧覆写）
  useLayoutEffect(() => {
    const body = bodyMeshRef.current
    const ring = ringMeshRef.current
    if (body === null || ring === null) {
      return
    }
    const snapshots = snapshotSimulator(simulator)
    writeAgvInstanceMatrices(instanceMatrixArray(body), snapshots)
    body.instanceMatrix.needsUpdate = true
    writeAgvInstanceMatrices(instanceMatrixArray(ring), snapshots)
    ring.instanceMatrix.needsUpdate = true
    // 分配实例色缓冲并立即写入真实状态色（首帧即正确，无黑环闪烁）
    ring.instanceColor = new InstancedBufferAttribute(new Float32Array(count * 3), 3)
    writeAgvStatusColors(ring.instanceColor.array as Float32Array, snapshots, AGV_STATUS_RGB)
    ring.instanceColor.needsUpdate = true
  }, [simulator, count, bodyMeshRef, ringMeshRef])

  return (
    <>
      {/* 车体：底盘 + 顶盖 + 方向楔形/前灯合并几何（顶点色）；AGV 为投影元素（SPEC §5.3 / §9） */}
      <instancedMesh
        ref={bodyMeshRef}
        args={[undefined, undefined, count]}
        geometry={bodyGeometry}
        castShadow
        frustumCulled={false}
      >
        <meshStandardMaterial vertexColors roughness={0.55} metalness={0} />
      </instancedMesh>
      {/* 顶部状态色环：实例色六状态（theme.agvStatusColors），toneMapped=false 保持高饱和层级 */}
      <instancedMesh
        ref={ringMeshRef}
        args={[undefined, undefined, count]}
        geometry={ringGeometry}
        frustumCulled={false}
      >
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </>
  )
}

/**
 * AGV 编号标签层（SPEC §7.3 复用 §6.4 机制）：全部编号合并为单个 BufferGeometry
 * （每字符一个 quad，共享单张图集纹理），单 mesh 单 draw call；锚点每帧由
 * AgvLayer 驱动 LabelBatch.setAnchorPosition 跟随车体（in-place 写，非几何重建）。
 * 编号恒为等级 0（关键标签），分级 / billboard 与节点标签同一注入。
 */
function AgvLabels({
  simulator,
  visible,
  batchRef,
}: {
  simulator: SimulatorState
  visible: boolean
  batchRef: RefObject<LabelBatch | null>
}) {
  const [built, setBuilt] = useState<{ atlas: LabelAtlas; batch: LabelBatch } | null>(null)
  // 各等级可见性 uniform（每帧写入，不经 React 渲染路径；与节点标签同一口径）
  const levelVisible = useMemo(() => ({ value: new Vector3(1, 1, 1) }), [])

  // 图集 + 合并几何批一次性构建（编号字符集创建即全覆盖，运行期无需重建纹理）；
  // cleanup 对称 dispose（StrictMode 双调用安全）
  useEffect(() => {
    const snapshots = snapshotSimulator(simulator)
    const atlas = createLabelAtlas(
      snapshots.map((snapshot) => agvLabelText(snapshot.id)),
      AGV_LABEL_ATLAS_OPTIONS,
    )
    const anchors: LabelAnchor[] = snapshots.map((snapshot) => ({
      id: agvLabelAnchorId(snapshot.id),
      text: agvLabelText(snapshot.id),
      level: LABEL_LEVEL_KEY,
      x: snapshot.position.x,
      y: AGV_LABEL_ANCHOR_HEIGHT,
      z: snapshot.position.z,
    }))
    const batch = buildLabelBatch(anchors, atlas, AGV_LABEL_FONT_HEIGHT)
    batchRef.current = batch
    setBuilt({ atlas, batch })
    return () => {
      if (batchRef.current === batch) {
        batchRef.current = null
      }
      batch.dispose()
      atlas.dispose()
    }
  }, [simulator, batchRef])

  useFrame(({ camera, controls }) => {
    const target = (controls as unknown as { target?: Vector3 } | null)?.target
    const [key, park, nav] = resolveLabelVisibility(
      resolveLabelCameraView(camera, target),
      AGV_LABEL_VISIBILITY_THRESHOLDS,
    )
    levelVisible.value.set(key ? 1 : 0, park ? 1 : 0, nav ? 1 : 0)
  })

  const injectLabelShader = useCallback(
    (shader: WebGLProgramParametersWithUniforms) =>
      injectLabelBillboardShader(shader, levelVisible),
    [levelVisible],
  )

  if (built === null) {
    return null
  }
  return (
    <mesh geometry={built.batch.geometry} visible={visible} frustumCulled={false}>
      {/* 单张图集纹理 + 合并 quad 几何 = 单 draw call；depthWrite 关 + alphaTest 防透明排序瑕疵 */}
      <meshBasicMaterial
        map={built.atlas.texture}
        transparent
        alphaTest={0.05}
        depthWrite={false}
        side={DoubleSide}
        toneMapped={false}
        onBeforeCompile={injectLabelShader}
      />
    </mesh>
  )
}
