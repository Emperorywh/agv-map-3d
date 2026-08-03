/**
 * ExteriorLayer：室外外景（SPEC §6.5）。
 * - 室外地坪（2000×2000m，y=-0.02，以厂房中心为中心）；
 * - drei Sky 程序化天空（sunPosition = normalize(0.5, 1, 0.35)，零资源）；
 * - THREE.Fog #D8E0E8 near 250 / far 1200：挂在 scene 上（非 mesh，不占批次），
 *   挂载时设置、卸载时恢复 null，StrictMode 重复挂载幂等。
 * 室外地坪 mesh 由 FactorySceneResources 装配（几何见同目录 exteriorGeometry.ts）。
 */

import { Sky } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import type { ReactElement } from 'react'
import { Fog } from 'three'

import { FOG_FAR, FOG_NEAR } from '../../../config/qualityProfile'
import { FOG_COLOR } from '../../../config/visualTheme'
import type { FactorySceneSnapshot } from '../../resources/FactorySceneResources'
import { sunDirection } from './exteriorGeometry'

export interface ExteriorLayerProps {
  readonly resources: FactorySceneSnapshot
}

export function ExteriorLayer({ resources }: ExteriorLayerProps): ReactElement {
  const scene = useThree((state) => state.scene)

  useEffect(() => {
    scene.fog = new Fog(FOG_COLOR, FOG_NEAR, FOG_FAR)
    return () => {
      scene.fog = null
    }
  }, [scene])

  return (
    <>
      <primitive object={resources.outdoorGroundMesh} />
      <Sky sunPosition={[...sunDirection()]} />
    </>
  )
}
