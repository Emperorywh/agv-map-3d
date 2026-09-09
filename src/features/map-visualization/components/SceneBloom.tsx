/**
 * 低强度屏幕光晕同时服务导航带与既有自发光，避免覆盖地坪与墙板细节。
 * 为 GLB 自发光补充屏幕空间光晕，在线性高动态范围画面上合成后统一色调映射。
 * 主画面保持画布尺寸，透射、抗锯齿及光晕遵守显式画质预算。
 * 资源随上下文代重新创建，不根据瞬时帧率重建渲染目标。
 */
import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js'
import { NAVIGATION_STYLE } from '../scene/navigationAppearance'
import { useRenderQuality } from '@/shared/rendering/renderQuality'
import { createFrameDiagnostics } from '@/shared/rendering/frameDiagnostics'

export function SceneBloom({ generation }: { generation: number }) {
  const { gl, scene, camera } = useThree()
  const quality = useRenderQuality()
  const pipeline = useRef<{
    composer: EffectComposer
    bloom: UnrealBloomPass
    antialias: ShaderPass | null
    width: number
    height: number
  } | null>(null)
  const drawingSize = useRef(new THREE.Vector2())
  /**
   * 性能统计覆盖整个外层帧，包含镜像嵌套渲染和后处理的绘制调用。
   * 每秒发布一次面板快照，逐帧数据留在采样器内部。
   */
  const diagnostics = useRef<ReturnType<typeof createFrameDiagnostics>>(null)
  useEffect(() => {
    const current = createFrameDiagnostics(gl)
    diagnostics.current = current
    return () => { diagnostics.current = null; current?.dispose() }
  }, [gl, generation])
  useFrame(() => diagnostics.current?.begin(), -100)

  useEffect(() => {
    /**
     * 半浮点颜色保留大于一的发光能量，后处理目标固定为单采样。
     * 抗锯齿由最终 FXAA 通道负责，中间颜色保留 HDR 范围供光晕使用。
     * 输出通道独占最终色调映射，避免先压平高光再提取光晕造成白色装甲泛光。
     */
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 0,
    })
    const composer = new EffectComposer(gl, target)
    composer.setPixelRatio(1)
    const render = new RenderPass(scene, camera)
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), NAVIGATION_STYLE.bloomStrength, NAVIGATION_STYLE.bloomRadius, NAVIGATION_STYLE.bloomThreshold)
    /**
     * 蓝色发光在亮度加权后数值偏低，按最强颜色通道提取超出显示范围的能量。
     * 无需提高模型原始发光强度，也能保留蓝色内芯和细灯带的光晕。
     */
    bloom.materialHighPassFilter.fragmentShader = bloom.materialHighPassFilter.fragmentShader.replace(
      'float v = luminance( texel.xyz );',
      `
      // 先隔离无效源像素，再计算亮度和阈值，不能用乘零或 clamp 清理 NaN。
      // 否则一次异常会沿五级横纵卷积传播，让局部错误扩大成矩形黑屏。
      if (any(isnan(texel)) || any(isinf(texel))) {
        gl_FragColor = vec4(0.0);
        return;
      }
      float v = max( texel.r, max( texel.g, texel.b ) );`,
    )
    const output = new OutputPass()
    composer.addPass(render)
    composer.addPass(bloom)
    composer.addPass(output)
    /**
     * 抗锯齿放在色调映射和颜色空间转换之后，按最终显示亮度识别边缘。
     * 均衡与高画质使用 FXAA，避免重新引入多重采样目标；性能档不增加通道。
     */
    const antialias = quality.antialias ? new ShaderPass(FXAAShader) : null
    if (antialias !== null) {
      antialias.material.depthTest = false
      antialias.material.depthWrite = false
      antialias.material.toneMapped = false
      composer.addPass(antialias)
    }
    const previousTransmissionScale = gl.transmissionResolutionScale
    gl.transmissionResolutionScale = quality.transmissionScale
    pipeline.current = { composer, bloom, antialias, width: 0, height: 0 }
    return () => {
      pipeline.current = null
      gl.transmissionResolutionScale = previousTransmissionScale
      render.dispose()
      bloom.dispose()
      /**
       * 当前版本光晕释放器未回收亮区提取材质，在所有者这里补齐清理。
       * 上下文反复重建时不会遗留这一独立着色器资源。
       */
      bloom.materialHighPassFilter.dispose()
      output.dispose()
      antialias?.dispose()
      composer.dispose()
    }
  }, [gl, scene, camera, generation, quality])

  /**
   * 接管主画面渲染，所有普通帧回调完成后才采集；反射在场景绘制前完成。
   * 使用实际绘制缓冲尺寸响应窗口和像素比变化，不进行帧率采样或动态画质降级。
   */
  useFrame((_, delta) => {
    const current = pipeline.current
    if (current === null) { gl.render(scene, camera); diagnostics.current?.end(delta); return }
    gl.getDrawingBufferSize(drawingSize.current)
    const { x: width, y: height } = drawingSize.current
    /**
     * 布局临时收起时不创建零尺寸渲染目标，避免无效帧缓冲。
     * 重新获得可见尺寸后立即按完整尺寸恢复绘制。
     */
    if (width === 0 || height === 0) return
    if (current.width !== width || current.height !== height) {
      current.composer.setSize(width, height)
      /**
       * FXAA 的纹素步长使用真实绘制尺寸，覆盖 Retina、浏览器缩放与窗口变化。
       * 与合成器同帧更新，避免像素比变化后仍采样旧的邻域尺寸。
       */
      current.antialias?.uniforms.resolution.value.set(1 / width, 1 / height)
      /**
       * 均衡档恢复内置半分辨率首层，性能档进一步降低柔光卷积的像素数量。
       * 主体画面和最终输出保持画布分辨率，高画质档保留原完整首层。
       */
      current.bloom.setSize(Math.max(1, width * quality.bloomScale), Math.max(1, height * quality.bloomScale))
      current.width = width
      current.height = height
    }
    current.composer.render(delta)
    diagnostics.current?.end(delta)
  }, 1)
  return null
}
