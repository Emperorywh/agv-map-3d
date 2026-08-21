import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Color, DoubleSide, Euler, Matrix4, Quaternion, Vector3 } from 'three'
import type { Group, InstancedMesh } from 'three'
import { useFrame } from '@react-three/fiber'

import {
  CORRIDOR_ARROW_LENGTH,
  CORRIDOR_ARROW_SPACING,
  CORRIDOR_ARROW_WIDTH,
  MAP_GEOMETRY_CHUNK_SIZE,
  NODE_CHARGE_HEIGHT,
  NODE_CHARGE_RADIUS,
  NODE_EMISSIVE_INTENSITY,
  NODE_NAV_HEIGHT,
  NODE_NAV_HIDE_DISTANCE,
  NODE_NAV_RADIUS,
  NODE_PARK_HEIGHT,
  NODE_PARK_RADIUS,
  NODE_WORK_ICON_HEIGHT,
  NODE_WORK_ICON_SIZE,
  NODE_WORK_PLATFORM_HEIGHT,
  NODE_WORK_PLATFORM_SIZE,
  RIBBON_DASH_GAP,
  RIBBON_DASH_LENGTH,
  RIBBON_DASH_WIDTH,
  RIBBON_LIFT,
  RIBBON_MITER_LIMIT,
  RIBBON_OVERLAY_LIFT,
  RIBBON_WIDTH,
} from '../config/constants'
import { mapColors } from '../config/theme'
import type { Calibration, NormalizedNode } from '../domain/types'
import {
  buildNodeKindGeometries,
  createNodeInstanceBuilder,
  shouldHideNavNodes,
} from '../rendering/scene/map/instanceGeometry'
import type {
  NodeInstanceBuildResult,
  NodeInstanceGroup,
  NodeShapeSizes,
  RenderableNodeKind,
} from '../rendering/scene/map/instanceGeometry'
import {
  buildArrowGeometry,
  createRibbonGeometryBuilder,
} from '../rendering/scene/map/ribbonGeometry'
import type {
  ArrowPlacement,
  RibbonBuildResult,
  RibbonGeometryParams,
} from '../rendering/scene/map/ribbonGeometry'
import { useAppStore } from '../state/appStore'

/**
 * 地图图层（SPEC §6）：走廊 ribbon + 倒车虚线标识（单个合并 BufferGeometry）
 * + 单向方向箭头（单个 InstancedMesh）+ 按类型分组的节点 InstancedMesh（5 个 draw call）。
 *
 * 静态几何分帧构建（SPEC §4.4：每帧处理 MAP_GEOMETRY_CHUNK_SIZE 条走廊 / 个节点，
 * 避免主线程长任务）；标签层由 TASK-005 并入本组件。
 */

/** ribbon 几何参数：尺寸阈值与色彩集中在 config（SPEC §5.1 / §6.2） */
const RIBBON_PARAMS: RibbonGeometryParams = {
  width: RIBBON_WIDTH,
  lift: RIBBON_LIFT,
  miterLimit: RIBBON_MITER_LIMIT,
  dashLength: RIBBON_DASH_LENGTH,
  dashGap: RIBBON_DASH_GAP,
  dashWidth: RIBBON_DASH_WIDTH,
  overlayLift: RIBBON_OVERLAY_LIFT,
  arrowSpacing: CORRIDOR_ARROW_SPACING,
  colors: {
    normal: mapColors.corridor,
    oneWay: mapColors.corridorOneWay,
    back: mapColors.corridorBack,
  },
}

/** 节点造型尺寸（SPEC §6.3 尺寸层级 work > charge > park > node），集中在 config/constants.ts */
const NODE_SHAPE_SIZES: NodeShapeSizes = {
  workPlatformSize: NODE_WORK_PLATFORM_SIZE,
  workPlatformHeight: NODE_WORK_PLATFORM_HEIGHT,
  workIconSize: NODE_WORK_ICON_SIZE,
  workIconHeight: NODE_WORK_ICON_HEIGHT,
  chargeRadius: NODE_CHARGE_RADIUS,
  chargeHeight: NODE_CHARGE_HEIGHT,
  parkRadius: NODE_PARK_RADIUS,
  parkHeight: NODE_PARK_HEIGHT,
  navRadius: NODE_NAV_RADIUS,
  navHeight: NODE_NAV_HEIGHT,
}

/** 各类型几何段对应的材质色（work = 方台底色 + 高饱和图标色块），色值集中 config/theme.ts */
const NODE_KIND_COLORS: Record<RenderableNodeKind, string[]> = {
  work: [mapColors.nodeWorkBase, mapColors.nodeWork],
  charge: [mapColors.nodeCharge],
  park: [mapColors.nodePark],
  node: [mapColors.node],
}

export function MapLayer() {
  const mapData = useAppStore((state) => state.mapData)
  const corridorsVisible = useAppStore((state) => state.layers.corridors)
  const nodesVisible = useAppStore((state) => state.layers.nodes)
  const [ribbon, setRibbon] = useState<RibbonBuildResult | null>(null)

  useEffect(() => {
    if (mapData === null) {
      setRibbon(null)
      return
    }
    const builder = createRibbonGeometryBuilder(
      mapData.corridors,
      mapData.calibration,
      RIBBON_PARAMS,
    )
    let rafId = 0
    let cancelled = false
    const buildChunk = () => {
      builder.buildNext(MAP_GEOMETRY_CHUNK_SIZE)
      if (!builder.done) {
        rafId = requestAnimationFrame(buildChunk)
        return
      }
      if (!cancelled) {
        setRibbon(builder.finalize())
      }
    }
    rafId = requestAnimationFrame(buildChunk)
    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
    }
  }, [mapData])

  // 重建 / 卸载时释放 GPU 几何（three 对已 dispose 对象会在下次渲染时重传，StrictMode 安全）
  useEffect(() => {
    if (ribbon === null) {
      return
    }
    return () => ribbon.geometry.dispose()
  }, [ribbon])

  return (
    <>
      {ribbon !== null && (
        <group visible={corridorsVisible}>
          {/* 合并 ribbon：实心三角带 + 虚线标识单 mesh 单 draw call；polygonOffset 防 z-fighting */}
          <mesh geometry={ribbon.geometry}>
            <meshBasicMaterial
              vertexColors
              side={DoubleSide}
              polygonOffset
              polygonOffsetFactor={-1}
              polygonOffsetUnits={-1}
            />
          </mesh>
          <CorridorArrows placements={ribbon.arrowPlacements} />
        </group>
      )}
      {mapData !== null && (
        <MapNodes
          nodes={mapData.nodes}
          calibration={mapData.calibration}
          visible={nodesVisible}
        />
      )}
    </>
  )
}

/** 单向走廊方向箭头：全部箭头单个 InstancedMesh（SPEC §6.2，不产生 per-走廊 draw call） */
function CorridorArrows({ placements }: { placements: ArrowPlacement[] }) {
  const meshRef = useRef<InstancedMesh>(null)
  const geometry = useMemo(
    () => buildArrowGeometry(CORRIDOR_ARROW_LENGTH, CORRIDOR_ARROW_WIDTH),
    [],
  )
  useEffect(() => () => geometry.dispose(), [geometry])

  // 实例矩阵 / 颜色一次性写入（placements 静态）；layout effect 保证首帧前就绪
  useLayoutEffect(() => {
    const mesh = meshRef.current
    if (mesh === null) {
      return
    }
    const matrix = new Matrix4()
    const quaternion = new Quaternion()
    const euler = new Euler()
    const position = new Vector3()
    const scale = new Vector3(1, 1, 1)
    const normalColor = new Color(mapColors.corridorArrow)
    const backColor = new Color(mapColors.corridorBack)
    for (let i = 0; i < placements.length; i++) {
      const placement = placements[i]
      euler.set(0, placement.yaw, 0)
      quaternion.setFromEuler(euler)
      position.set(placement.x, placement.y, placement.z)
      matrix.compose(position, quaternion, scale)
      mesh.setMatrixAt(i, matrix)
      mesh.setColorAt(i, placement.isBack ? backColor : normalColor)
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor !== null) {
      mesh.instanceColor.needsUpdate = true
    }
  }, [placements])

  if (placements.length === 0) {
    return null
  }
  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, placements.length]}
      geometry={geometry}
      frustumCulled={false}
    >
      <meshBasicMaterial
        side={DoubleSide}
        polygonOffset
        polygonOffsetFactor={-1}
        polygonOffsetUnits={-1}
      />
    </instancedMesh>
  )
}

/**
 * 节点实例层（SPEC §6.3）：实例矩阵分帧构建（与走廊几何同一节奏）；
 * node 类整类隐藏由 useFrame 按相机距离驱动整组 visible 开关（不逐实例遍历）。
 */
function MapNodes({
  nodes,
  calibration,
  visible,
}: {
  nodes: NormalizedNode[]
  calibration: Calibration
  visible: boolean
}) {
  const [result, setResult] = useState<NodeInstanceBuildResult | null>(null)

  useEffect(() => {
    const builder = createNodeInstanceBuilder(nodes, calibration)
    let rafId = 0
    let cancelled = false
    const buildChunk = () => {
      builder.buildNext(MAP_GEOMETRY_CHUNK_SIZE)
      if (!builder.done) {
        rafId = requestAnimationFrame(buildChunk)
        return
      }
      if (!cancelled) {
        setResult(builder.finalize())
      }
    }
    rafId = requestAnimationFrame(buildChunk)
    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
    }
  }, [nodes, calibration])

  const navGroupRef = useRef<Group>(null)

  // node 类整类隐藏（SPEC §6.3）：相机距关注点超过阈值时整组隐藏，拉近恢复；
  // 只写 ref 上的 visible，不触发 React 重渲染（SPEC §3 每帧数据不走渲染路径）
  useFrame(({ camera, controls }) => {
    const navGroup = navGroupRef.current
    if (navGroup === null) {
      return
    }
    // makeDefault 的 OrbitControls 在 state.controls 上暴露 target（视线关注点）
    const target = (controls as unknown as { target?: Vector3 } | null)?.target
    const distance =
      target === undefined ? camera.position.length() : camera.position.distanceTo(target)
    const hidden = shouldHideNavNodes(distance, NODE_NAV_HIDE_DISTANCE)
    if (navGroup.visible === hidden) {
      navGroup.visible = !hidden
    }
  })

  if (result === null) {
    return null
  }
  return (
    <group visible={visible}>
      {result.groups.map((group) =>
        group.kind === 'node' ? (
          <group key={group.kind} ref={navGroupRef}>
            <NodeKindInstances group={group} />
          </group>
        ) : (
          <NodeKindInstances key={group.kind} group={group} />
        ),
      )}
    </group>
  )
}

/**
 * 单类型节点实例组：每段几何一个 InstancedMesh（work = 方台 + 图标色块两段，
 * 共享同一组实例矩阵与 instanceId 映射）；实例矩阵由 buildNodeInstances 一次性写入。
 */
function NodeKindInstances({ group }: { group: NodeInstanceGroup }) {
  const geometries = useMemo(
    () => buildNodeKindGeometries(group.kind, NODE_SHAPE_SIZES),
    [group.kind],
  )
  useEffect(() => () => geometries.forEach((geometry) => geometry.dispose()), [geometries])
  const meshRefs = useRef<Array<InstancedMesh | null>>([])

  // 实例矩阵一次性写入（节点静态）；layout effect 保证首帧前就绪
  useLayoutEffect(() => {
    for (const mesh of meshRefs.current) {
      if (mesh === null) {
        continue
      }
      mesh.instanceMatrix.array.set(group.matrices)
      mesh.instanceMatrix.needsUpdate = true
    }
  }, [group, geometries])

  const colors = NODE_KIND_COLORS[group.kind]
  return geometries.map((geometry, index) => (
    <instancedMesh
      key={index}
      ref={(mesh) => {
        meshRefs.current[index] = mesh
      }}
      args={[undefined, undefined, group.nodeIds.length]}
      geometry={geometry}
      frustumCulled={false}
    >
      {/* schematic 高饱和 + 轻微 emissive（SPEC §5.1；材质氛围由 TASK-008 统一校准） */}
      <meshStandardMaterial
        color={colors[index]}
        emissive={colors[index]}
        emissiveIntensity={NODE_EMISSIVE_INTENSITY}
        roughness={0.7}
        metalness={0}
      />
    </instancedMesh>
  ))
}
