/**
 * 地坪图层（视觉对齐改造：程序化地坪落地）。
 *
 * 职责：把 createGroundSurface 产出的地面平面挂载到场景——包围盒随视图，
 *       平面接收车辆/充电桩的实时阴影，为整场提供「落地感」。图层每视图
 *       最多一个 Draw Call；纹理在工厂内按世界尺寸平铺，总览与近景共用。
 * 边界：网格/材质/纹理全部由本组件 useMemo 创建并在卸载或视图更换时释放
 *       （创建者释放）；本组件不感知地图业务语义，不释放任何外部资源。
 *       各向异性过滤取渲染器能力与外观上限的较小值。
 * 关键不变量：
 * 1. 资源代序号随每次重建递增并作为 primitive 的 key：R3F 对已挂载
 *    primitive 换 object 依赖「兄弟序列尾部」探测，与兄弟元素组合时重建
 *    会被静默丢弃（TASK-005 实测），key 变化强制走干净的卸载/挂载路径；
 * 2. dispose={null}：对象由本组件 effect 显式释放，禁止 R3F 二次释放；
 * 3. 纹理降级（Canvas 不可得）不阻断挂载：材质退为纯色，地面照常接收阴影。
 */
import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import type { SceneBounds } from '../model/types'
import { createGroundSurface } from '../scene/groundSurface'

export interface GroundLayerProps {
  /**
   * 统一厂房的世界包围盒，地坪直接铺到墙体外边界。
   * 本层不再自行增加边距，保证相机保护与实际地面范围一致。
   */
  readonly bounds: SceneBounds
}

export function GroundLayer({ bounds }: GroundLayerProps) {
  const gl = useThree((state) => state.gl)
  const surface = useMemo(
    () => createGroundSurface(bounds, gl.capabilities.getMaxAnisotropy()),
    [bounds, gl],
  )
  useEffect(() => () => surface.dispose(), [surface])

  return (
    <primitive
      key={`ground-${surface.id}`}
      object={surface.mesh}
      dispose={null}
    />
  )
}
