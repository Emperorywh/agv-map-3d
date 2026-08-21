import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { DoubleSide, Vector3 } from 'three'
import type { Group, InstancedMesh, MeshStandardMaterial } from 'three'
import { useFrame } from '@react-three/fiber'

import {
  COLUMN_CORRIDOR_CLEARANCE,
  COLUMN_FADE_PITCH_RAD,
  COLUMN_SIZE,
  COLUMN_SPACING,
  FACTORY_MARGIN,
  FLOOR_GRID_LIFT,
  FLOOR_GRID_STEP,
  OCCLUSION_FADE_TAU_SECONDS,
  OCCLUSION_OPACITY_EPSILON,
  SKYLIGHT_EDGE_INSET,
  SKYLIGHT_LIFT,
  SKYLIGHT_STRIP_SPACING,
  SKYLIGHT_STRIP_WIDTH,
  WALL_FADE_FAR_DISTANCE,
  WALL_FADE_MIN_OPACITY,
  WALL_FADE_NEAR_DISTANCE,
  WALL_HEIGHT,
  WALL_OCCLUSION_EXIT_HEIGHT_MARGIN,
  WALL_OCCLUSION_SEGMENT_MARGIN,
} from '../config/constants'
import { buildingColors } from '../config/theme'
import { worldToMapInto } from '../domain/coordinates'
import type { MapPoint } from '../domain/types'
import {
  computeCameraPitchRad,
  dampOpacity,
  isCameraInsideFootprint,
  resolveRoofTargetVisible,
  resolveWallFadeTarget,
  shouldFadeColumns,
} from '../rendering/scene/factory/occlusion'
import type {
  WallFadeParams,
  WallFadeTarget,
  WallOcclusionInput,
} from '../rendering/scene/factory/occlusion'
import { buildShellGeometry } from '../rendering/scene/factory/shellGeometry'
import type { ShellGeometryParams } from '../rendering/scene/factory/shellGeometry'
import { useAppStore } from '../state/appStore'

/**
 * 建筑外壳（SPEC §5.2）与遮挡处理（SPEC §5.5，TASK-012）。
 *
 * 外壳：程序化厂房轮廓——深灰哑光地坪（每 10m 浅网格刻线）、6m 外墙沿包围盒矩形、
 * 12m 柱距立柱阵列（避开走廊 ribbon 区域）、平屋顶 + 规则天窗带；尺寸 = 地图包围盒
 * （NormalizedMap.bounds）+ 四周各 FACTORY_MARGIN，全部几何经 mapToWorld 与地图天然对齐。
 *
 * 遮挡（SPEC §5.5，全部判定收敛于 rendering/scene/factory/occlusion.ts 纯函数）：
 * - 屋顶 / 天窗：默认隐藏；仅当相机 XZ 落外墙矩形内且高度低于屋檐（footprint 交集，
 *   非单纯高度阈值）自动淡入；跟随模式强制隐藏；layers.roof 三态手动覆盖
 *   （自动 / 强制显示 / 强制隐藏）优先于一切自动判定；
 * - 墙体：按 footprint 四边拆为 4 段独立 mesh（独立材质不透明度），每帧对每段取
 *   ① 相机穿透 / 贴近（3D 距离驱动 smoothstep 不透明度）与 ② 遮挡 相机→关注点
 *   连线（穿越高度 + 墙段外延双重滞后防闪烁）的并集淡出；
 * - 立柱：相机俯角超 COLUMN_FADE_PITCH_RAD（默认 60°）或正交俯视时整组淡出，
 *   完全淡出后置 visible=false（同时脱离阴影与渲染列表）；
 * - 平滑过渡：所有不透明度经 dampOpacity 指数阻尼（时间常数 OCCLUSION_FADE_TAU_SECONDS，
 *   帧率无关）；判定与阈值全部为 config/constants.ts 可调常量；
 * - 每帧路径零分配（worldToMapInto / resolveWallFadeTarget out 参数 + 模块级 scratch），
 *   只写材质 opacity 与 visible，不触发 React 重渲染（SPEC §3）；相机与关注点
 *   （OrbitControls target，跟随模式 = 目标 AGV）即 CameraRig 维护的每帧瞬时值。
 *
 * draw call：地坪 / 刻线 / 外墙×4（逐段淡出）/ 立柱（InstancedMesh）/ 屋顶 / 天窗带，
 * 共 9 个（SPEC §9 预算）；建筑元素不可拾取（SPEC §8.2）：全部网格 raycast 置空；
 * 阴影（SPEC §5.3 / §9）：仅外墙 / 屋顶 castShadow，地坪 receiveShadow，立柱不投影。
 */

/** 外壳几何参数：尺寸阈值集中 config/constants.ts（SPEC §5.1 / §5.2） */
const SHELL_PARAMS: ShellGeometryParams = {
  margin: FACTORY_MARGIN,
  wallHeight: WALL_HEIGHT,
  gridStep: FLOOR_GRID_STEP,
  gridLift: FLOOR_GRID_LIFT,
  columnSpacing: COLUMN_SPACING,
  columnSize: COLUMN_SIZE,
  columnClearance: COLUMN_CORRIDOR_CLEARANCE,
  skylightStripWidth: SKYLIGHT_STRIP_WIDTH,
  skylightStripSpacing: SKYLIGHT_STRIP_SPACING,
  skylightEdgeInset: SKYLIGHT_EDGE_INSET,
  skylightLift: SKYLIGHT_LIFT,
}

/** 墙体淡出参数：阈值全部集中 config/constants.ts（SPEC §5.5 可调常量） */
const WALL_FADE_PARAMS: WallFadeParams = {
  proximityNearDistance: WALL_FADE_NEAR_DISTANCE,
  proximityFarDistance: WALL_FADE_FAR_DISTANCE,
  minOpacity: WALL_FADE_MIN_OPACITY,
  occlusionExitHeightMargin: WALL_OCCLUSION_EXIT_HEIGHT_MARGIN,
  occlusionSegmentMargin: WALL_OCCLUSION_SEGMENT_MARGIN,
}

/** 建筑元素不可拾取（SPEC §8.2）：raycast 置空，任何拾取路径都不可命中 */
const NO_RAYCAST = () => null

export function FactoryBuilding() {
  const mapData = useAppStore((state) => state.mapData)
  const interiorVisible = useAppStore((state) => state.layers.interior)

  // 外壳几何一次性构建（体量小：若干合并 quad + 百级柱位实例，无需分帧）；
  // 柱位避让采样依赖走廊几何（TASK-003 corridors 输出）
  const shell = useMemo(() => {
    if (mapData === null) {
      return null
    }
    return buildShellGeometry(
      mapData.bounds,
      mapData.corridors.map((corridor) => corridor.geometry),
      mapData.calibration,
      SHELL_PARAMS,
    )
  }, [mapData])

  // 重建 / 卸载时释放 GPU 几何（StrictMode 双调用安全）
  useEffect(() => {
    if (shell === null) {
      return
    }
    return () => shell.dispose()
  }, [shell])

  const columnsRef = useRef<InstancedMesh>(null)
  const columnMaterialRef = useRef<MeshStandardMaterial>(null)
  const roofGroupRef = useRef<Group>(null)
  const roofMaterialRef = useRef<MeshStandardMaterial>(null)
  const skylightMaterialRef = useRef<MeshStandardMaterial>(null)
  const wallMaterialsRef = useRef<Array<MeshStandardMaterial | null>>([])

  /**
   * 遮挡每帧状态（随几何重建重置）：不透明度初值 = 默认观感
   * （屋顶隐藏 / 墙体不透明 / 立柱不透明），occluding 为判定②滞后记忆
   */
  const fadeState = useMemo(
    () => ({
      roofOpacity: 0,
      columnOpacity: 1,
      wallOccluding: shell?.wallSegments.map(() => false) ?? [],
      wallOpacity: shell?.wallSegments.map(() => 1) ?? [],
    }),
    [shell],
  )

  /** 每帧 scratch（复用对象零分配）：世界 → 地图平面转换结果与墙体判定输入 / 输出 */
  const scratch = useMemo(() => {
    const cameraMap: MapPoint = { x: 0, y: 0 }
    const targetMap: MapPoint = { x: 0, y: 0 }
    const wallInput: WallOcclusionInput = {
      cameraMap,
      cameraHeight: 0,
      targetMap,
      targetHeight: 0,
      wallHeight: WALL_HEIGHT,
    }
    return {
      cameraMap,
      targetMap,
      wallInput,
      wallTarget: { occluding: false, targetOpacity: 1 } as WallFadeTarget,
      fallbackTarget: new Vector3(),
    }
  }, [])

  // 立柱实例矩阵一次性写入（静态）；layout effect 保证首帧前就绪
  useLayoutEffect(() => {
    const mesh = columnsRef.current
    if (mesh === null || shell === null) {
      return
    }
    mesh.instanceMatrix.array.set(shell.columnMatrices)
    mesh.instanceMatrix.needsUpdate = true
  }, [shell])

  // 遮挡驱动（SPEC §5.5）：组件挂载序在 CameraRig 之后（App.tsx 注释），同优先级
  // useFrame 内读取的相机位姿 / controls.target（跟随模式 = 当帧目标 AGV）为当帧值
  useFrame(({ camera, controls }, delta) => {
    const roofGroup = roofGroupRef.current
    const roofMaterial = roofMaterialRef.current
    const skylightMaterial = skylightMaterialRef.current
    const columnsMesh = columnsRef.current
    const columnMaterial = columnMaterialRef.current
    if (
      shell === null ||
      mapData === null ||
      roofGroup === null ||
      roofMaterial === null ||
      skylightMaterial === null ||
      columnsMesh === null ||
      columnMaterial === null
    ) {
      return
    }
    // 模式与屋顶手动覆盖走 getState 瞬时值：每帧数据不进 React 渲染路径（SPEC §3）
    const { cameraMode, layers } = useAppStore.getState()
    // makeDefault 的 OrbitControls 在 state.controls 上暴露 target（视线关注点，SPEC §5.5）
    const target =
      (controls as unknown as { target?: Vector3 } | null)?.target ??
      scratch.fallbackTarget.set(0, 0, 0)
    worldToMapInto(camera.position, mapData.calibration, scratch.cameraMap)
    worldToMapInto(target, mapData.calibration, scratch.targetMap)

    // 屋顶 / 天窗：footprint 交集淡入 + 跟随强制隐藏 + 三态手动覆盖（纯函数判定）
    const insideFootprint = isCameraInsideFootprint(
      shell.footprint,
      scratch.cameraMap.x,
      scratch.cameraMap.y,
      camera.position.y,
      WALL_HEIGHT,
    )
    const roofVisible = resolveRoofTargetVisible(layers.roof, cameraMode, insideFootprint)
    fadeState.roofOpacity = dampOpacity(
      fadeState.roofOpacity,
      roofVisible ? 1 : 0,
      delta,
      OCCLUSION_FADE_TAU_SECONDS,
      OCCLUSION_OPACITY_EPSILON,
    )
    // 完全淡出后隐藏整组（脱离渲染列表与 shadow map）；淡入起步即恢复可见
    roofGroup.visible = fadeState.roofOpacity > 0
    roofMaterial.opacity = fadeState.roofOpacity
    skylightMaterial.opacity = fadeState.roofOpacity

    // 墙体：逐段取 ① 贴近 ∪ ② 视线遮挡的淡出目标（判定带滞后），阻尼写材质
    const wallInput = scratch.wallInput
    wallInput.cameraHeight = camera.position.y
    wallInput.targetHeight = target.y
    for (let i = 0; i < shell.wallSegments.length; i++) {
      const { occluding, targetOpacity } = resolveWallFadeTarget(
        fadeState.wallOccluding[i],
        shell.wallSegments[i].outline,
        wallInput,
        WALL_FADE_PARAMS,
        scratch.wallTarget,
      )
      fadeState.wallOccluding[i] = occluding
      fadeState.wallOpacity[i] = dampOpacity(
        fadeState.wallOpacity[i],
        targetOpacity,
        delta,
        OCCLUSION_FADE_TAU_SECONDS,
        OCCLUSION_OPACITY_EPSILON,
      )
      const material = wallMaterialsRef.current[i]
      if (material !== null && material !== undefined) {
        material.opacity = fadeState.wallOpacity[i]
      }
    }

    // 立柱：俯角超阈值或正交俯视淡出；完全淡出后隐藏（不投影，仅脱离渲染列表）
    const pitch = computeCameraPitchRad(
      camera.position.y - target.y,
      Math.hypot(camera.position.x - target.x, camera.position.z - target.z),
    )
    const columnsFaded = shouldFadeColumns(cameraMode, pitch, COLUMN_FADE_PITCH_RAD)
    fadeState.columnOpacity = dampOpacity(
      fadeState.columnOpacity,
      columnsFaded ? 0 : 1,
      delta,
      OCCLUSION_FADE_TAU_SECONDS,
      OCCLUSION_OPACITY_EPSILON,
    )
    columnMaterial.opacity = fadeState.columnOpacity
    columnsMesh.visible = fadeState.columnOpacity > 0
  })

  if (shell === null) {
    return null
  }
  return (
    <group name="factory-building">
      {/* 地坪：单块深灰哑光平面 + 每 10m 浅网格刻线；地坪承接建筑阴影（不投影） */}
      <group name="factory-floor">
        <mesh geometry={shell.floor} raycast={NO_RAYCAST} receiveShadow>
          <meshStandardMaterial color={buildingColors.floor} roughness={0.95} metalness={0} />
        </mesh>
        <lineSegments geometry={shell.floorGrid} raycast={NO_RAYCAST}>
          <lineBasicMaterial color={buildingColors.floorGrid} />
        </lineSegments>
      </group>
      {/* 外墙：footprint 四边 4 段独立 mesh（SPEC §5.5 逐段淡出，每段独立不透明度）；
          transparent + depthWrite=false 防半透明排序瑕疵（不透明度 1 时混合等价覆盖，
          淡出时后方标签 / 内部元素正确透出）；双面可见；建筑投影（阴影不随淡出变化） */}
      <group name="factory-walls">
        {shell.wallSegments.map((segment, index) => (
          <mesh key={index} geometry={segment.geometry} raycast={NO_RAYCAST} castShadow>
            <meshStandardMaterial
              ref={(material: MeshStandardMaterial | null) => {
                wallMaterialsRef.current[index] = material
              }}
              color={buildingColors.wall}
              roughness={0.9}
              metalness={0}
              side={DoubleSide}
              transparent
              depthWrite={false}
            />
          </mesh>
        ))}
      </group>
      {/* 立柱：12m 柱距规则阵列（避开走廊 ribbon 区域），单个 InstancedMesh；
          不投影（SPEC §5.3）；俯角 / 正交俯视淡出由 useFrame 写材质与 visible（SPEC §5.5） */}
      <group name="factory-columns" visible={interiorVisible}>
        <instancedMesh
          ref={columnsRef}
          args={[undefined, undefined, shell.columnCount]}
          geometry={shell.columnGeometry}
          raycast={NO_RAYCAST}
          frustumCulled={false}
        >
          <meshStandardMaterial
            ref={columnMaterialRef}
            color={buildingColors.column}
            roughness={0.85}
            metalness={0}
            transparent
            depthWrite={false}
          />
        </instancedMesh>
      </group>
      {/* 屋顶天窗：默认隐藏（SPEC §5.5）；visible / 不透明度由 useFrame 遮挡驱动
          （visible={false} 仅为初始值，R3F 对未变更 prop 不重复应用，此后由
          useFrame 接管）；屋顶投影、天窗带为发光材质模拟透光不投影 */}
      <group name="factory-roof" ref={roofGroupRef} visible={false}>
        <mesh geometry={shell.roof} raycast={NO_RAYCAST} castShadow>
          <meshStandardMaterial
            ref={roofMaterialRef}
            color={buildingColors.roof}
            roughness={0.9}
            metalness={0}
            side={DoubleSide}
            transparent
            depthWrite={false}
            opacity={0}
          />
        </mesh>
        <mesh geometry={shell.skylights} raycast={NO_RAYCAST}>
          <meshStandardMaterial
            ref={skylightMaterialRef}
            color={buildingColors.skylight}
            emissive={buildingColors.skylight}
            emissiveIntensity={0.4}
            roughness={0.6}
            metalness={0}
            side={DoubleSide}
            transparent
            depthWrite={false}
            opacity={0}
          />
        </mesh>
      </group>
    </group>
  )
}
