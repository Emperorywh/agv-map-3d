import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DoubleSide } from 'three'
import type { InstancedMesh } from 'three'

import {
  AREA_BLOCK_LIFT,
  AREA_BLOCK_OPACITY,
  CHANDELIER_DROP,
  CHANDELIER_EDGE_INSET,
  CHANDELIER_RADIUS,
  CHANDELIER_SPACING,
  CHANDELIER_THICKNESS,
  CHARGE_PILE_OFFSET,
  CHARGE_SPOT_LENGTH,
  CHARGE_SPOT_WIDTH,
  CHARGING_PILE_DEPTH,
  CHARGING_PILE_HEIGHT,
  CHARGING_PILE_WIDTH,
  FACTORY_MARGIN,
  LANE_LINE_GAP,
  LANE_LINE_WIDTH,
  LOADING_AREA_SIZE,
  MARKING_LIFT,
  RIBBON_WIDTH,
  ROLLER_DOOR_BEAM_HEIGHT,
  ROLLER_DOOR_FRACTIONS,
  ROLLER_DOOR_FRAME_DEPTH,
  ROLLER_DOOR_HEIGHT,
  ROLLER_DOOR_INSET,
  ROLLER_DOOR_PANEL_THICKNESS,
  ROLLER_DOOR_POST_SIZE,
  ROLLER_DOOR_RIB_HEIGHT,
  ROLLER_DOOR_RIB_SPACING,
  ROLLER_DOOR_WIDTH,
  SHELF_CELL_SIZE,
  SHELF_CHARGE_CLEARANCE,
  SHELF_CORRIDOR_CLEARANCE,
  SHELF_DOOR_CLEARANCE,
  SHELF_MIN_RUN_CELLS,
  SHELF_ROW_DEPTH,
  SHELF_ROW_HEIGHT,
  SHELF_WALL_INSET,
  WALL_HEIGHT,
  WORKBENCH_ROW_DEPTH,
  WORKBENCH_ROW_HEIGHT,
  ZEBRA_START_INSET,
  ZEBRA_STRIPE_COUNT,
  ZEBRA_STRIPE_GAP,
  ZEBRA_STRIPE_WIDTH,
} from '../config/constants'
import { interiorColors, markingColors } from '../config/theme'
import { headingToWorldYaw, mapToWorld } from '../domain/coordinates'
import { loadDecorativeAssets } from '../infrastructure/assetLoader'
import type { DecorativeAssetFallbacks } from '../infrastructure/assetLoader'
import {
  buildChargingPilePlaceholder,
  buildInteriorGeometry,
  buildRollerDoorFramePlaceholder,
} from '../rendering/scene/factory/interiorGeometry'
import type { InteriorGeometryParams } from '../rendering/scene/factory/interiorGeometry'
import { useAppStore } from '../state/appStore'

/**
 * 工厂内部元素与地面标线（SPEC §5.3 / §5.4）：
 *
 * - 室内陈设分组（layers.interior）：货架 / 工作台排（网格采样空地、成排低多边形、
 *   各一个 InstancedMesh）、吊灯阵列（仅发光体的 InstancedMesh 灯盘，不逐个投影）、
 *   充电桩造型与卷帘门门框（public/assets/ glTF 点缀，按 charge 节点 / 外墙长边摆放
 *   克隆；加载失败时程序化占位体替换 + console 警告，不阻塞场景）、固定关闭的
 *   卷帘门扇板（含横肋的合并几何）；
 * - 地面标线分组（layers.groundMarkings）：通道两侧边缘线 + 卷帘门内侧斑马线
 *   （单个合并几何，顶点色）、充电区 / 装卸区区域色块（单个合并几何，半透明）；
 *   贴地坪标线抬升 MARKING_LIFT 低于 ribbon 的 2cm 层高、区域色块 AREA_BLOCK_LIFT
 *   高于 ribbon overlay，并配 polygonOffset，避免 z-fighting；
 * - 充电区为数据关联元素：充电桩位置 / 朝向与地面充电位色块严格对齐 charge 节点
 *   （坐标经 mapToWorld、朝向经 headingToWorldYaw，收口于 domain/coordinates.ts）；
 * - 建筑元素不可拾取（SPEC §8.2）：全部网格 raycast 置空；
 * - 几何一次性构建（货架采样经走廊包围盒预筛为百毫秒级；SPEC §4.4 分帧针对
 *   走廊 / 节点万级几何）；材质为 schematic 平涂，光照 / 阴影整合同 TASK-008。
 */

/** 内部元素几何参数：尺寸阈值集中 config/constants.ts，色值集中 config/theme.ts */
const INTERIOR_PARAMS: InteriorGeometryParams = {
  margin: FACTORY_MARGIN,
  ribbonWidth: RIBBON_WIDTH,
  wallHeight: WALL_HEIGHT,
  storage: {
    cellSize: SHELF_CELL_SIZE,
    wallInset: SHELF_WALL_INSET,
    corridorClearance: SHELF_CORRIDOR_CLEARANCE,
    doorClearance: SHELF_DOOR_CLEARANCE,
    chargeClearance: SHELF_CHARGE_CLEARANCE,
    minRunCells: SHELF_MIN_RUN_CELLS,
    shelfDepth: SHELF_ROW_DEPTH,
    shelfHeight: SHELF_ROW_HEIGHT,
    workbenchDepth: WORKBENCH_ROW_DEPTH,
    workbenchHeight: WORKBENCH_ROW_HEIGHT,
  },
  chargePileOffset: CHARGE_PILE_OFFSET,
  chargeSpotLength: CHARGE_SPOT_LENGTH,
  chargeSpotWidth: CHARGE_SPOT_WIDTH,
  loadingAreaSize: LOADING_AREA_SIZE,
  doorFractions: ROLLER_DOOR_FRACTIONS,
  doorWidth: ROLLER_DOOR_WIDTH,
  doorHeight: ROLLER_DOOR_HEIGHT,
  doorInset: ROLLER_DOOR_INSET,
  doorPanelThickness: ROLLER_DOOR_PANEL_THICKNESS,
  doorRibSpacing: ROLLER_DOOR_RIB_SPACING,
  doorRibHeight: ROLLER_DOOR_RIB_HEIGHT,
  zebraStripeWidth: ZEBRA_STRIPE_WIDTH,
  zebraStripeGap: ZEBRA_STRIPE_GAP,
  zebraStripeCount: ZEBRA_STRIPE_COUNT,
  zebraStartInset: ZEBRA_START_INSET,
  chandelierSpacing: CHANDELIER_SPACING,
  chandelierEdgeInset: CHANDELIER_EDGE_INSET,
  chandelierDrop: CHANDELIER_DROP,
  chandelierRadius: CHANDELIER_RADIUS,
  chandelierThickness: CHANDELIER_THICKNESS,
  laneLineGap: LANE_LINE_GAP,
  laneLineWidth: LANE_LINE_WIDTH,
  markingLift: MARKING_LIFT,
  areaBlockLift: AREA_BLOCK_LIFT,
  colors: {
    laneLine: markingColors.laneLine,
    zebra: markingColors.zebra,
    chargeArea: markingColors.chargeArea,
    loadingArea: markingColors.loadingArea,
    doorPanel: interiorColors.rollerDoorPanel,
    doorRib: interiorColors.rollerDoorRib,
  },
}

/**
 * glTF 缺失 / 失败时的程序化占位体工厂（SPEC §10 分级降级）：
 * 占位体几何由 rendering 层构建器生成（+Z 正面、米制、原点底部中心，与 glTF 同约定），
 * 尺寸 / 色值自 config 注入（infrastructure 不 import config，SPEC §12）。
 */
const DECORATIVE_FALLBACKS: DecorativeAssetFallbacks = {
  chargingPile: () =>
    buildChargingPilePlaceholder(
      { width: CHARGING_PILE_WIDTH, height: CHARGING_PILE_HEIGHT, depth: CHARGING_PILE_DEPTH },
      { body: interiorColors.chargingPile, screen: interiorColors.chargingPileScreen },
    ),
  rollerDoorFrame: () =>
    buildRollerDoorFramePlaceholder(
      {
        width: ROLLER_DOOR_WIDTH,
        height: ROLLER_DOOR_HEIGHT,
        postSize: ROLLER_DOOR_POST_SIZE,
        beamHeight: ROLLER_DOOR_BEAM_HEIGHT,
        frameDepth: ROLLER_DOOR_FRAME_DEPTH,
      },
      interiorColors.doorFrame,
    ),
}

/** 建筑元素不可拾取（SPEC §8.2）：raycast 置空，任何拾取路径都不可命中 */
const NO_RAYCAST = () => null

export function FactoryInterior() {
  const mapData = useAppStore((state) => state.mapData)
  const interiorVisible = useAppStore((state) => state.layers.interior)
  const markingsVisible = useAppStore((state) => state.layers.groundMarkings)

  // 内部元素几何一次性构建（百级实例 + 若干合并几何；货架采样经包围盒预筛）
  const interior = useMemo(
    () => (mapData === null ? null : buildInteriorGeometry(mapData, INTERIOR_PARAMS)),
    [mapData],
  )

  // 重建 / 卸载时释放 GPU 几何（StrictMode 双调用安全）
  useEffect(() => {
    if (interior === null) {
      return
    }
    return () => interior.dispose()
  }, [interior])

  // glTF 点缀资产加载（SPEC §5.4）：失败 / 缺失 → assetLoader 内占位降级 + 警告，不阻塞场景
  const [assets, setAssets] = useState<Awaited<
    ReturnType<typeof loadDecorativeAssets>
  > | null>(null)
  useEffect(() => {
    let cancelled = false
    void loadDecorativeAssets({ fallbacks: DECORATIVE_FALLBACKS }).then((loaded) => {
      if (!cancelled) {
        setAssets(loaded)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  // 充电桩造型克隆：与 charge 节点严格对齐（位置 mapToWorld、朝向 headingToWorldYaw）；
  // 静态网格 clone 共享几何 / 材质，克隆体自身不产生额外 GPU 资源，无需 dispose
  const pileObjects = useMemo(() => {
    if (assets === null || mapData === null) {
      return []
    }
    const { calibration } = mapData
    return (interior?.chargePlacements ?? []).map((placement) => {
      const object = assets.chargingPile.clone(true)
      const world = mapToWorld(placement.pile, calibration)
      object.position.set(world.x, 0, world.z)
      object.rotation.y = headingToWorldYaw(placement.pileHeading, calibration)
      object.traverse((child) => {
        child.raycast = NO_RAYCAST
      })
      return { key: placement.nodeId, object }
    })
  }, [assets, mapData, interior])

  // 卷帘门门框克隆：外墙长边各 2 扇（固定关闭），门框中心自墙线向内 inset（背面不贴墙）
  const doorFrameObjects = useMemo(() => {
    if (assets === null || mapData === null) {
      return []
    }
    const { calibration } = mapData
    return (interior?.doorPlacements ?? []).map((placement, index) => {
      const object = assets.rollerDoorFrame.clone(true)
      const world = mapToWorld(
        {
          x: placement.center.x + Math.cos(placement.heading) * ROLLER_DOOR_INSET,
          y: placement.center.y + Math.sin(placement.heading) * ROLLER_DOOR_INSET,
        },
        calibration,
      )
      object.position.set(world.x, 0, world.z)
      object.rotation.y = headingToWorldYaw(placement.heading, calibration)
      object.traverse((child) => {
        child.raycast = NO_RAYCAST
      })
      return { key: `door-${index}`, object }
    })
  }, [assets, mapData, interior])

  const shelvesRef = useRef<InstancedMesh>(null)
  const workbenchesRef = useRef<InstancedMesh>(null)
  const chandeliersRef = useRef<InstancedMesh>(null)

  // 实例矩阵一次性写入（静态）；layout effect 保证首帧前就绪
  useLayoutEffect(() => {
    if (interior === null) {
      return
    }
    const writes: Array<[InstancedMesh | null, Float32Array]> = [
      [shelvesRef.current, interior.shelfMatrices],
      [workbenchesRef.current, interior.workbenchMatrices],
      [chandeliersRef.current, interior.chandelierMatrices],
    ]
    for (const [mesh, matrices] of writes) {
      if (mesh === null) {
        continue
      }
      mesh.instanceMatrix.array.set(matrices)
      mesh.instanceMatrix.needsUpdate = true
    }
  }, [interior])

  if (interior === null) {
    return null
  }
  return (
    <>
      {/* 室内陈设（SPEC §8.3 图层开关）：货架 / 工作台 / 吊灯 / 充电桩造型 / 卷帘门 */}
      <group name="factory-interior" visible={interiorVisible}>
        <instancedMesh
          ref={shelvesRef}
          args={[undefined, undefined, interior.shelfCount]}
          geometry={interior.storageBoxGeometry}
          raycast={NO_RAYCAST}
          frustumCulled={false}
        >
          <meshStandardMaterial color={interiorColors.shelf} roughness={0.9} metalness={0} />
        </instancedMesh>
        <instancedMesh
          ref={workbenchesRef}
          args={[undefined, undefined, interior.workbenchCount]}
          geometry={interior.storageBoxGeometry}
          raycast={NO_RAYCAST}
          frustumCulled={false}
        >
          <meshStandardMaterial color={interiorColors.workbench} roughness={0.9} metalness={0} />
        </instancedMesh>
        {/* 吊灯阵列：仅发光体（emissive 灯盘），不逐个投影、不产生灯光 */}
        <instancedMesh
          ref={chandeliersRef}
          args={[undefined, undefined, interior.chandelierCount]}
          geometry={interior.chandelierGeometry}
          raycast={NO_RAYCAST}
          frustumCulled={false}
        >
          <meshStandardMaterial
            color={interiorColors.chandelier}
            emissive={interiorColors.chandelier}
            emissiveIntensity={0.9}
            roughness={0.6}
            metalness={0}
          />
        </instancedMesh>
        {/* 固定关闭的卷帘门扇板（含横肋，顶点色分色合并几何） */}
        <mesh geometry={interior.doorPanels} raycast={NO_RAYCAST}>
          <meshStandardMaterial vertexColors roughness={0.85} metalness={0} />
        </mesh>
        {pileObjects.map((pile) => (
          <primitive key={pile.key} object={pile.object} />
        ))}
        {doorFrameObjects.map((frame) => (
          <primitive key={frame.key} object={frame.object} />
        ))}
      </group>
      {/* 地面标线（含区域色块）：贴地坪标线低于 ribbon 层高、区域色块高于 ribbon overlay */}
      <group name="factory-ground-markings" visible={markingsVisible}>
        <mesh geometry={interior.groundMarkings} raycast={NO_RAYCAST} frustumCulled={false}>
          <meshBasicMaterial
            vertexColors
            side={DoubleSide}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
          />
        </mesh>
        <mesh geometry={interior.areaBlocks} raycast={NO_RAYCAST} frustumCulled={false}>
          <meshBasicMaterial
            vertexColors
            transparent
            opacity={AREA_BLOCK_OPACITY}
            depthWrite={false}
            side={DoubleSide}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
          />
        </mesh>
      </group>
    </>
  )
}
