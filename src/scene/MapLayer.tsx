import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Color, DoubleSide, Euler, Matrix4, Quaternion, Vector3 } from 'three'
import type { InstancedMesh } from 'three'

import {
  CORRIDOR_ARROW_LENGTH,
  CORRIDOR_ARROW_SPACING,
  CORRIDOR_ARROW_WIDTH,
  MAP_GEOMETRY_CHUNK_SIZE,
  RIBBON_DASH_GAP,
  RIBBON_DASH_LENGTH,
  RIBBON_DASH_WIDTH,
  RIBBON_LIFT,
  RIBBON_MITER_LIMIT,
  RIBBON_OVERLAY_LIFT,
  RIBBON_WIDTH,
} from '../config/constants'
import { mapColors } from '../config/theme'
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
 * + 单向方向箭头（单个 InstancedMesh）。
 *
 * 静态几何分帧构建（SPEC §4.4：每帧处理 MAP_GEOMETRY_CHUNK_SIZE 条走廊，
 * 避免主线程长任务）；节点 / 标签层由 TASK-004 / TASK-005 并入本组件。
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

export function MapLayer() {
  const mapData = useAppStore((state) => state.mapData)
  const corridorsVisible = useAppStore((state) => state.layers.corridors)
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

  if (ribbon === null) {
    return null
  }
  return (
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
