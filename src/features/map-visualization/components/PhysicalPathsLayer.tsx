/**
 * 路线复用已去重的物理索引，并从业务模型读取真实方向与控制点。
 * 路面与边界复用地图已有的并集合批，导航状态直接更新缓冲，无逐帧分配。
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { MapGeometry } from '../scene/buildMapGeometry'
import type { MapModel } from '../model/types'
import type { WorldTransform } from '@/shared/spatial'
import { createNavigationGeometry, createNavigationMaterial } from '../scene/navigationGeometry'
import { NAVIGATION_STYLE as S } from '../scene/navigationAppearance'
import { ROAD_SURFACE_COLOR, ROAD_SURFACE_OPACITY, ROAD_BOUNDARY_COLOR } from '../scene/mapAppearance'
import { useNavigationState } from '../model/navigationState'

export function PhysicalPathsLayer({ geometry, mapModel, worldTransform }: { geometry: MapGeometry; mapModel: MapModel; worldTransform: WorldTransform }) {
  const group = useMemo(() => new THREE.Group(), [])
  useEffect(() => {
    const data = createNavigationGeometry(mapModel, geometry, worldTransform)
    /**
     * 实际路面采用半透明深色铺装，保留底层金属地坪的纹理与反射。
     * 外边界来自整个路面的并集，交叉口内部不会出现横穿道路的封口线。
     */
    const surface = new THREE.Mesh(geometry.roadSurface, new THREE.MeshBasicMaterial({ color: ROAD_SURFACE_COLOR, opacity: ROAD_SURFACE_OPACITY, transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true }))
    const boundaries = new THREE.Mesh(geometry.roadBoundaries, new THREE.MeshBasicMaterial({ color: new THREE.Color(ROAD_BOUNDARY_COLOR).multiplyScalar(S.emission), transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true }))
    const ribbon = new THREE.Mesh(data.ribbon, createNavigationMaterial(true))
    const arrows = new THREE.Mesh(data.arrows, createNavigationMaterial(false))
    surface.name = 'map-road-surface'
    boundaries.name = 'map-road-boundaries'
    ribbon.name = 'map-navigation-ribbons'
    arrows.name = 'map-navigation-arrows'
    ribbon.position.y = S.routeY
    arrows.position.y = S.arrowY
    surface.renderOrder = 1
    boundaries.renderOrder = 2
    ribbon.renderOrder = 3
    arrows.renderOrder = 4
    /**
     * 路面与边界的高度已烘入共享几何，只有导航网格需要额外设置高度。
     * 路线不参与节点拾取，避免新增大面积路面增加每次鼠标移动的相交计算。
     */
    for (const mesh of [surface, boundaries, ribbon, arrows]) mesh.raycast = () => {}
    group.add(surface, boundaries, ribbon, arrows)
    data.update(useNavigationState.getState().pathStates)
    const unsubscribe = useNavigationState.subscribe((state, previous) => {
      if (state.pathStates !== previous.pathStates) data.update(state.pathStates)
    })
    /**
     * 路面及边界几何仍由地图运行时释放，本层只清理新增材质与自有导航资源。
     * 严格模式重挂和上下文恢复不会提前释放其他图层共享的地图几何。
     */
    return () => { unsubscribe(); group.clear(); data.dispose(); surface.material.dispose(); boundaries.material.dispose(); ribbon.material.dispose(); arrows.material.dispose() }
  }, [group, geometry, mapModel, worldTransform])
  return <primitive object={group} dispose={null} />
}
