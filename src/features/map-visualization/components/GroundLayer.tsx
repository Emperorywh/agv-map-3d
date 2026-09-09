/**
 * 地坪图层（视觉对齐改造：程序化地坪落地）。
 *
 * 职责：把 createGroundSurface 产出的地面平面挂载到场景——包围盒随视图，
 *       平面接收车辆/充电桩的实时阴影，为整场提供「落地感」。图层每视图
 *       基础地坪使用一个 Draw Call，按画质预算采集镜像场景；
 *       独立环境按资源代预过滤，纹理按世界尺寸平铺，总览与近景共用。
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
import { createGroundEnvironment } from '../scene/createSceneEnvironment'
import { useRenderQuality } from '@/shared/rendering/renderQuality'

export interface GroundLayerProps {
  /**
   * 统一厂房的世界包围盒，地坪直接铺到墙体外边界。
   * 本层不再自行增加边距，保证相机保护与实际地面范围一致。
   */
  readonly bounds: SceneBounds
}

/**
 * 正式地图与预览共用显式画质预算，静止镜头下按预算降低倒影刷新率。
 * 地坪和倒影由同一个副作用持有，卸载时先解除反射回调再释放地坪材质。
 */
export function GroundLayer({ bounds }: GroundLayerProps) {
  const quality = useRenderQuality()
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const group = useMemo(() => new Group(), [])
  /**
   * 动画帧号由图层统一推进，使水晶透射预通道和主通道共用同帧倒影。
   * 反射句柄换代时同步替换引用，卸载后不再访问旧资源。
   */
  const reflectionRef = useRef<ReturnType<typeof createGroundReflection> | null>(null)
  useFrame((_, delta) => reflectionRef.current?.beginFrame(delta))
  /**
   * 地坪句柄必须在每次副作用设置时新建，不能复用严格模式清理过的句柄。
   * 稳定组负责挂载位置，实际网格由同一副作用添加、移除和释放。
   */
  useEffect(() => {
    const surface = createGroundSurface(bounds, gl.capabilities.getMaxAnisotropy())
    /**
     * 地板使用独立的室内宽柔光环境，设备继续读取原有场景环境。
     * 预过滤只在资源创建时执行；失败时回退到已存在的场景环境。
     */
    let environment: ReturnType<typeof createGroundEnvironment> | null = null
    try {
      environment = createGroundEnvironment(gl)
      surface.mesh.material.envMap = environment.texture
    } catch (error) {
      console.warn('地面反射环境创建失败，继续使用场景环境。', error)
    }
    const reflection = createGroundReflection(surface.mesh, quality.reflectionSize, quality.reflectionFps)
    reflectionRef.current = reflection
    group.add(surface.mesh)
    /**
     * 场景钩子在相机及世界矩阵更新后、透射和实体绘制前执行，先生成本帧倒影。
     * 避免地坪在透射预通道中途切走 MSAA 目标，导致 Apple 后端丢弃深度内容。
     * 地坪原钩子的重入保护与帧号去重仍生效，镜像和主画面不会重复采集。
     */
    const originalSceneRender = scene.onBeforeRender
    const prepareReflection: typeof scene.onBeforeRender = (...args) => {
      originalSceneRender.apply(scene, args)
      surface.mesh.onBeforeRender(args[0], args[1], args[2], surface.mesh.geometry, surface.mesh.material, group)
    }
    scene.onBeforeRender = prepareReflection
    return () => {
      /**
       * 只撤销本层安装的场景钩子，严格模式与资源换代时恢复原所有者。
       * 先解除采集入口，再释放倒影纹理，防止场景继续调用已释放的句柄。
       */
      if (scene.onBeforeRender === prepareReflection) scene.onBeforeRender = originalSceneRender
      if (reflectionRef.current === reflection) reflectionRef.current = null
      reflection.dispose()
      /**
       * 先解除环境引用再释放目标纹理，资源所有权与地板保持一致。
       * 不释放由场景照明持有的共享环境。
       */
      surface.mesh.material.envMap = null
      environment?.dispose()
      group.remove(surface.mesh)
      surface.dispose()
    }
  }, [bounds, gl, scene, group, quality])

  return (
    <primitive
      object={group}
      dispose={null}
    />
  )
}
