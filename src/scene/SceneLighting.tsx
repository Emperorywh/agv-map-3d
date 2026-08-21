import { useMemo } from 'react'

import {
  DIRECTIONAL_LIGHT_DIRECTION,
  DIRECTIONAL_LIGHT_INTENSITY,
  FACTORY_MARGIN,
  HEMISPHERE_LIGHT_INTENSITY,
  SHADOW_MAP_SIZE,
  WALL_HEIGHT,
} from '../config/constants'
import { sceneColors } from '../config/theme'
import { computeDirectionalShadowFrustum } from '../rendering/scene/lighting'
import { useAppStore } from '../state/appStore'

/**
 * 场景光照（SPEC §5.3 / §9）：恰好 1 盏平行光 + 半球光，无其他光源。
 *
 * - 半球光为环境基调（天光 / 地面反射色取自 config/theme.ts），不产生阴影；
 * - 平行光为唯一投影光源：shadow map 边长 SHADOW_MAP_SIZE ≤ 1024（SPEC §9 预算），
 *   正交视锥由 computeDirectionalShadowFrustum 按建筑 footprint（地图包围盒
 *   + FACTORY_MARGIN，与建筑外壳同口径）+ 墙高推导，覆盖整个厂房；
 * - 投影开启面按 SPEC §5.3 收口：仅建筑外壳（外墙 / 屋顶）与 AGV（TASK-010/011
 *   落地）castShadow；货架 / 立柱 / 吊灯 / 地图元素一律不投影，地坪承接阴影。
 */
export function SceneLighting() {
  const mapData = useAppStore((state) => state.mapData)

  // 阴影视锥按建筑 footprint 一次性推导（世界 footprint 中心恒为原点，见 §4.3）
  const frustum = useMemo(
    () =>
      mapData === null
        ? null
        : computeDirectionalShadowFrustum({
            bounds: mapData.bounds,
            margin: FACTORY_MARGIN,
            direction: DIRECTIONAL_LIGHT_DIRECTION,
            wallHeight: WALL_HEIGHT,
          }),
    [mapData],
  )

  if (frustum === null) {
    return null
  }
  return (
    <>
      <hemisphereLight
        args={[sceneColors.hemisphereSky, sceneColors.hemisphereGround, HEMISPHERE_LIGHT_INTENSITY]}
      />
      <directionalLight
        castShadow
        position={frustum.position}
        intensity={DIRECTIONAL_LIGHT_INTENSITY}
        shadow-mapSize={[SHADOW_MAP_SIZE, SHADOW_MAP_SIZE]}
      >
        {/* args 构造即生成正确的 projectionMatrix，无需手动 updateProjectionMatrix */}
        <orthographicCamera
          attach="shadow-camera"
          args={[-frustum.extent, frustum.extent, frustum.extent, -frustum.extent, frustum.near, frustum.far]}
        />
      </directionalLight>
    </>
  )
}
