/**
 * 地坪图层（视觉对齐改造：程序化地坪落地）。
 *
 * 职责：把 createGroundSurface 产出的地面平面挂载到场景——包围盒随视图，
 *       平面接收车辆/充电桩的实时阴影，为整场提供「落地感」。图层每视图
 *       基础地坪使用一个 Draw Call，每帧另采集一次镜像场景；
 *       纹理在工厂内按世界尺寸平铺，总览与近景共用。
 * 边界：网格/材质/纹理全部由本组件 effect 创建并在卸载或视图更换时释放
 *       （创建者释放）；本组件不感知地图业务语义，不释放任何外部资源。
 *       各向异性过滤取渲染器能力与外观上限的较小值。
 * 关键不变量：
 * 1. 稳定的挂载组不拥有 GPU 资源；每次 effect 设置创建新地坪并加入该组，
 *    清理时先移除再释放，严格模式重复设置也不复用已经释放的句柄；
 * 2. dispose={null}：对象由本组件 effect 显式释放，禁止 R3F 二次释放；
 * 3. 纹理降级（Canvas 不可得）不阻断挂载：材质退为纯色，地面照常接收阴影。
 */
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Group } from 'three'
import type { SceneBounds } from '../model/types'
import { createGroundSurface } from '../scene/groundSurface'
import { createGroundReflection } from '../scene/groundReflection'

export interface GroundLayerProps {
  /**
   * 统一厂房的世界包围盒，地坪直接铺到墙体外边界。
   * 本层不再自行增加边距，保证相机保护与实际地面范围一致。
   */
  readonly bounds: SceneBounds
}

/**
 * 正式地图与预览始终创建完整地坪反射，使用同一固定分辨率。
 * 地坪和倒影由同一个副作用持有，卸载时先解除反射回调再释放地坪材质。
 */
export function GroundLayer({ bounds }: GroundLayerProps) {
  const gl = useThree((state) => state.gl)
  const group = useMemo(() => new Group(), [])
  /**
   * 动画帧号由图层统一推进，使水晶透射预通道和主通道共用同帧倒影。
   * 反射句柄换代时同步替换引用，卸载后不再访问旧资源。
   */
  const reflectionRef = useRef<ReturnType<typeof createGroundReflection> | null>(null)
  useFrame(() => reflectionRef.current?.beginFrame())
  /**
   * 地坪句柄必须在每次副作用设置时新建，不能复用严格模式清理过的句柄。
   * 稳定组负责挂载位置，实际网格由同一副作用添加、移除和释放。
   */
  useEffect(() => {
    const surface = createGroundSurface(bounds, gl.capabilities.getMaxAnisotropy())
    const reflection = createGroundReflection(surface.mesh)
    reflectionRef.current = reflection
    group.add(surface.mesh)
    return () => {
      if (reflectionRef.current === reflection) reflectionRef.current = null
      reflection.dispose()
      group.remove(surface.mesh)
      surface.dispose()
    }
  }, [bounds, gl, group])

  return (
    <primitive
      object={group}
      dispose={null}
    />
  )
}
