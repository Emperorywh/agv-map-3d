import { mapColors, sceneColors } from '../config/theme'

/**
 * 占位场景：TASK-001 脚手架阶段的空场景内容（网格地坪刻线 + 坐标轴 + 基础光源），
 * 验证 R3F Canvas 装配可用。TASK-002 起由真实地图 / 建筑场景组件逐步替换。
 */
export function PlaceholderScene() {
  return (
    <>
      {/* 基础光照：半球光 + 平行光（SPEC §5.3 光照基调） */}
      <hemisphereLight args={['#cfd4dc', '#20232a', 0.9]} />
      <directionalLight position={[40, 60, 20]} intensity={1.2} />

      {/* 占位网格：每 10m 一条刻线的地坪示意（SPEC §5.2 地坪网格刻线基调） */}
      <gridHelper
        args={[200, 20, mapColors.corridor, sceneColors.gridLine]}
        position={[0, 0, 0]}
      />
      {/* 坐标轴：x 红 / y 绿 / z 蓝 */}
      <axesHelper args={[10]} />
    </>
  )
}
