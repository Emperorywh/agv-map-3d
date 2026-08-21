import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { DoubleSide } from 'three'
import type { InstancedMesh } from 'three'

import {
  COLUMN_CORRIDOR_CLEARANCE,
  COLUMN_SIZE,
  COLUMN_SPACING,
  FACTORY_MARGIN,
  FLOOR_GRID_LIFT,
  FLOOR_GRID_STEP,
  SKYLIGHT_EDGE_INSET,
  SKYLIGHT_LIFT,
  SKYLIGHT_STRIP_SPACING,
  SKYLIGHT_STRIP_WIDTH,
  WALL_HEIGHT,
} from '../config/constants'
import { buildingColors } from '../config/theme'
import { buildShellGeometry } from '../rendering/scene/factory/shellGeometry'
import type { ShellGeometryParams } from '../rendering/scene/factory/shellGeometry'
import { useAppStore } from '../state/appStore'

/**
 * 建筑外壳（SPEC §5.2）：程序化厂房轮廓——深灰哑光地坪（每 10m 浅网格刻线）、
 * 6m 外墙沿包围盒矩形、12m 柱距立柱阵列（避开走廊 ribbon 区域）、平屋顶 + 规则天窗带。
 *
 * - 尺寸 = 地图包围盒（NormalizedMap.bounds，含边折线与贝塞尔控制点，与 §4.3
 *   calibration offset 同口径）+ 四周各 FACTORY_MARGIN；全部几何经 mapToWorld
 *   与地图共用同一 calibration 转换，天然对齐无二次配准；
 * - 分组组织：地坪（含刻线）/ 外墙 / 立柱 / 屋顶天窗 四个分组，可见性可控——
 *   立柱随 layers.interior 开关（SPEC §8.3 室内陈设分组）；屋顶天窗默认隐藏
 *   （SPEC §5.5 默认行为），layers.roof = 'show' 强制显示，'auto' 的相机联动
 *   淡入淡出由 TASK-012 实现；
 * - draw call：地坪 / 刻线 / 外墙 / 立柱（InstancedMesh）/ 屋顶 / 天窗带各 1，共 6 个；
 * - 建筑元素不可拾取（SPEC §8.2）：全部网格 raycast 置空，拾取系统（TASK-013）不可命中；
 * - 材质为 schematic 平涂（哑光、低饱和）；阴影（SPEC §5.3 / §9）：仅建筑外壳投影
 *   （外墙 / 屋顶 castShadow），地坪承接阴影（receiveShadow）；立柱不投影；
 *   天窗带为发光材质模拟透光，不投影。
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

/** 建筑元素不可拾取（SPEC §8.2）：raycast 置空，任何拾取路径都不可命中 */
const NO_RAYCAST = () => null

export function FactoryBuilding() {
  const mapData = useAppStore((state) => state.mapData)
  const interiorVisible = useAppStore((state) => state.layers.interior)
  const roofOverride = useAppStore((state) => state.layers.roof)

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

  // 立柱实例矩阵一次性写入（静态）；layout effect 保证首帧前就绪
  useLayoutEffect(() => {
    const mesh = columnsRef.current
    if (mesh === null || shell === null) {
      return
    }
    mesh.instanceMatrix.array.set(shell.columnMatrices)
    mesh.instanceMatrix.needsUpdate = true
  }, [shell])

  if (shell === null) {
    return null
  }
  // SPEC §5.5：屋顶天窗默认隐藏；'show' 强制显示；'auto' 的自动淡入淡出由 TASK-012 接管
  const roofVisible = roofOverride === 'show'
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
      {/* 外墙：6m 高沿包围盒矩形，schematic 浅色，双面可见（室内 / 室外）；建筑投影 */}
      <group name="factory-walls">
        <mesh geometry={shell.walls} raycast={NO_RAYCAST} castShadow>
          <meshStandardMaterial
            color={buildingColors.wall}
            roughness={0.9}
            metalness={0}
            side={DoubleSide}
          />
        </mesh>
      </group>
      {/* 立柱：12m 柱距规则阵列（避开走廊 ribbon 区域），单个 InstancedMesh；
          不投影（SPEC §5.3：货架 / 立柱不开阴影） */}
      <group name="factory-columns" visible={interiorVisible}>
        <instancedMesh
          ref={columnsRef}
          args={[undefined, undefined, shell.columnCount]}
          geometry={shell.columnGeometry}
          raycast={NO_RAYCAST}
          frustumCulled={false}
        >
          <meshStandardMaterial color={buildingColors.column} roughness={0.85} metalness={0} />
        </instancedMesh>
      </group>
      {/* 屋顶天窗：平屋顶 + 规则天窗带，默认隐藏（SPEC §5.5）；屋顶投影、
          天窗带为发光材质模拟透光不投影（visible=false 时不参与 shadow map） */}
      <group name="factory-roof" visible={roofVisible}>
        <mesh geometry={shell.roof} raycast={NO_RAYCAST} castShadow>
          <meshStandardMaterial
            color={buildingColors.roof}
            roughness={0.9}
            metalness={0}
            side={DoubleSide}
          />
        </mesh>
        <mesh geometry={shell.skylights} raycast={NO_RAYCAST}>
          <meshStandardMaterial
            color={buildingColors.skylight}
            emissive={buildingColors.skylight}
            emissiveIntensity={0.4}
            roughness={0.6}
            metalness={0}
            side={DoubleSide}
          />
        </mesh>
      </group>
    </group>
  )
}
