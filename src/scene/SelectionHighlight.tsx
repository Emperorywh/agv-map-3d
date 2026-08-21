import { useEffect, useMemo, useRef } from 'react'
import { DoubleSide } from 'three'
import type { Group } from 'three'
import { useFrame } from '@react-three/fiber'

import {
  CORRIDOR_HIGHLIGHT_EXTRA_WIDTH,
  CORRIDOR_HOVER_OPACITY,
  HIGHLIGHT_RIBBON_LIFT,
  HOVER_RING_OPACITY,
  SELECTION_RING_LIFT,
  SELECTION_RING_MARGIN,
  SELECTION_RING_WIDTH,
} from '../config/constants'
import { highlightColors } from '../config/theme'
import { mapToWorld } from '../domain/coordinates'
import type { Calibration, Corridor, NormalizedMap, NormalizedNode } from '../domain/types'
import {
  agvSelectionRingRadius,
  buildCorridorHighlightParams,
  buildSelectionRingGeometry,
  nodeSelectionRingRadius,
} from '../rendering/scene/map/highlight'
import type { AgvShapeSizes, NodeShapeSizes, RenderableNodeKind } from '../rendering/scene/map/instanceGeometry'
import { buildRibbonGeometry } from '../rendering/scene/map/ribbonGeometry'
import {
  AGV_BODY_LENGTH,
  AGV_BODY_WIDTH,
  AGV_CHASSIS_HEIGHT,
  AGV_COVER_HEIGHT,
  AGV_COVER_LENGTH,
  AGV_COVER_REAR_OFFSET,
  AGV_COVER_WIDTH,
  AGV_HEADLIGHT_DEPTH,
  AGV_HEADLIGHT_HEIGHT,
  AGV_HEADLIGHT_INSET,
  AGV_HEADLIGHT_LIFT,
  AGV_HEADLIGHT_WIDTH,
  AGV_STATUS_RING_LIFT,
  AGV_STATUS_RING_RADIUS,
  AGV_STATUS_RING_TUBE,
  AGV_WEDGE_HEIGHT,
  AGV_WEDGE_LENGTH,
  AGV_WEDGE_WIDTH,
  NODE_CHARGE_HEIGHT,
  NODE_CHARGE_RADIUS,
  NODE_NAV_HEIGHT,
  NODE_NAV_RADIUS,
  NODE_PARK_HEIGHT,
  NODE_PARK_RADIUS,
  NODE_WORK_ICON_HEIGHT,
  NODE_WORK_ICON_SIZE,
  NODE_WORK_PLATFORM_HEIGHT,
  NODE_WORK_PLATFORM_SIZE,
} from '../config/constants'
import { agvRuntime } from '../state/agvRuntime'
import { sameSelectionTarget, useAppStore } from '../state/appStore'
import type { Selection } from '../state/appStore'
import { RIBBON_PARAMS } from './ribbonParams'

/**
 * 选中 / 悬停高亮层（SPEC §8.2）：订阅 store 的 selection / hover，为当前目标渲染
 * 场景高亮——节点与 AGV 用**描边色环**（平放地面的圆环，选中不透明 / 悬停弱化），
 * 走廊用**单条 ribbon 高亮覆盖**（高亮色顶点色重建，选中加宽形成描边、悬停半透明）。
 * 节点 / AGV 本体的 emissive 提升由各自实例层的 aHighlight 属性承担（MapLayer /
 * AgvLayer），本组件只负责覆盖层几何。
 *
 * - AGV 色环每帧经 agvRuntime 瞬时值通道跟随目标（不进 React 渲染路径，SPEC §3）；
 * - 走廊覆盖几何按目标重建（单条走廊，交互频次极低），切换 / 卸载时 dispose；
 * - 高亮网格一律 raycast 置空：不进入任何拾取路径（R3F 只 raycast 注册处理器的对象，
 *   此处双保险）；
 * - 悬停目标与选中目标相同（kind + id）时不重复渲染（选中为更强高亮，优先表达）。
 */

/** 高亮网格不可拾取（SPEC §8.2）：raycast 置空 */
const NO_RAYCAST = () => null

/** 节点造型尺寸（与 MapLayer 同一组 config 常量；色环半径按 footprint 推导） */
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

/** AGV 造型尺寸（与 AgvLayer 同一组 config 常量；色环半径按车体 footprint 推导） */
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

type HighlightVariant = 'selected' | 'hover'

export function SelectionHighlight() {
  const selection = useAppStore((state) => state.selection)
  const hover = useAppStore((state) => state.hover)
  const mapData = useAppStore((state) => state.mapData)

  // 节点查找索引（选中 / 悬停定位用；地图加载后一次性构建）
  const nodeById = useMemo(() => {
    if (mapData === null) {
      return null
    }
    return new Map(mapData.nodes.map((node) => [node.id, node]))
  }, [mapData])

  if (mapData === null || nodeById === null) {
    return null
  }
  return (
    <group name="selection-highlight">
      {selection !== null && (
        <TargetHighlight
          target={selection}
          variant="selected"
          mapData={mapData}
          nodeById={nodeById}
        />
      )}
      {hover !== null && !sameSelectionTarget(selection, hover) && (
        <TargetHighlight target={hover} variant="hover" mapData={mapData} nodeById={nodeById} />
      )}
    </group>
  )
}

/** 单目标高亮分发：节点 / AGV → 描边色环；走廊 → ribbon 覆盖 */
function TargetHighlight({
  target,
  variant,
  mapData,
  nodeById,
}: {
  target: Selection
  variant: HighlightVariant
  mapData: NormalizedMap
  nodeById: Map<string, NormalizedNode>
}) {
  if (target.kind === 'node') {
    const node = nodeById.get(target.id)
    // elevator 不渲染不可拾取，不会出现；其余类型必有造型尺寸
    if (node === undefined || node.kind === 'elevator') {
      return null
    }
    return (
      <NodeRing node={node} kind={node.kind} calibration={mapData.calibration} variant={variant} />
    )
  }
  if (target.kind === 'agv') {
    return <AgvRing agvId={Number(target.id)} variant={variant} />
  }
  const corridor = mapData.corridors.find((item) => item.id === target.id)
  if (corridor === undefined) {
    return null
  }
  return <CorridorOverlay corridor={corridor} calibration={mapData.calibration} variant={variant} />
}

/** 节点 / AGV 描边色环网格（平放地面；环体几何随半径重建并 dispose） */
function GroundRingMesh({
  innerRadius,
  variant,
}: {
  innerRadius: number
  variant: HighlightVariant
}) {
  const geometry = useMemo(
    () => buildSelectionRingGeometry(innerRadius, innerRadius + SELECTION_RING_WIDTH),
    [innerRadius],
  )
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <mesh geometry={geometry} raycast={NO_RAYCAST}>
      <meshBasicMaterial
        color={highlightColors.highlight}
        transparent
        opacity={variant === 'selected' ? 1 : HOVER_RING_OPACITY}
        toneMapped={false}
        depthWrite={false}
        side={DoubleSide}
      />
    </mesh>
  )
}

/** 节点描边色环：静态位置（节点世界坐标），内半径按类型 footprint 推导 */
function NodeRing({
  node,
  kind,
  calibration,
  variant,
}: {
  node: NormalizedNode
  kind: RenderableNodeKind
  calibration: Calibration
  variant: HighlightVariant
}) {
  const innerRadius = nodeSelectionRingRadius(kind, NODE_SHAPE_SIZES, SELECTION_RING_MARGIN)
  const world = mapToWorld({ x: node.x, y: node.y }, calibration)
  return (
    <group position={[world.x, SELECTION_RING_LIFT, world.z]}>
      <GroundRingMesh innerRadius={innerRadius} variant={variant} />
    </group>
  )
}

/**
 * AGV 描边色环：每帧经 agvRuntime 瞬时值通道跟随目标位姿（只写 position / visible，
 * 不触发 React 重渲染，SPEC §3）；目标消失（模拟器重建间隙）时隐藏。
 */
function AgvRing({ agvId, variant }: { agvId: number; variant: HighlightVariant }) {
  const groupRef = useRef<Group>(null)
  const innerRadius = agvSelectionRingRadius(AGV_SHAPE_SIZES, SELECTION_RING_MARGIN)

  useFrame(() => {
    const group = groupRef.current
    if (group === null) {
      return
    }
    const snapshot = agvRuntime.snapshots?.find((item) => item.id === agvId)
    if (snapshot === undefined) {
      group.visible = false
      return
    }
    group.visible = true
    group.position.set(snapshot.position.x, SELECTION_RING_LIFT, snapshot.position.z)
  })

  return (
    <group ref={groupRef} visible={false}>
      <GroundRingMesh innerRadius={innerRadius} variant={variant} />
    </group>
  )
}

/**
 * 走廊高亮覆盖：以高亮顶点色重建单条走廊 ribbon（实心带 + 倒车虚线标识同色高亮），
 * 抬升高于原 ribbon 与区域色块；选中加宽（边缘超出原 ribbon 形成描边）且不透明，
 * 悬停保持原宽、半透明弱化。几何随目标 / 变体重建，切换 / 卸载时 dispose。
 */
function CorridorOverlay({
  corridor,
  calibration,
  variant,
}: {
  corridor: Corridor
  calibration: Calibration
  variant: HighlightVariant
}) {
  const built = useMemo(() => {
    const params = buildCorridorHighlightParams(
      RIBBON_PARAMS,
      highlightColors.highlight,
      variant === 'selected' ? CORRIDOR_HIGHLIGHT_EXTRA_WIDTH : 0,
      HIGHLIGHT_RIBBON_LIFT,
    )
    return buildRibbonGeometry([corridor], calibration, params)
  }, [corridor, calibration, variant])
  useEffect(() => () => built.geometry.dispose(), [built])

  return (
    <mesh geometry={built.geometry} raycast={NO_RAYCAST}>
      <meshBasicMaterial
        vertexColors
        transparent
        opacity={variant === 'selected' ? 1 : CORRIDOR_HOVER_OPACITY}
        toneMapped={false}
        depthWrite={false}
        side={DoubleSide}
        polygonOffset
        polygonOffsetFactor={-2}
        polygonOffsetUnits={-2}
      />
    </mesh>
  )
}
