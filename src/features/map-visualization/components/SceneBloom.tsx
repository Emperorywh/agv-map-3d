/**
 * 为 GLB 自发光补充屏幕空间光晕，在线性高动态范围画面上合成后统一色调映射。
 * 主画面、透射采样及光晕首层使用完整绘制尺寸，资源随上下文代重新创建。
 */
import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

export function SceneBloom({ generation }: { generation: number }) {
  const { gl, scene, camera } = useThree()
  const pipeline = useRef<{
    composer: EffectComposer
    bloom: UnrealBloomPass
    width: number
    height: number
  } | null>(null)
  const drawingSize = useRef(new THREE.Vector2())

  useEffect(() => {
    /**
     * 半浮点颜色保留大于一的发光能量，抗锯齿采用设备支持的最高多重采样数。
     * 输出通道独占最终色调映射，避免先压平高光再提取光晕造成白色装甲泛光。
     */
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: gl.capabilities.maxSamples,
    })
    const composer = new EffectComposer(gl, target)
    composer.setPixelRatio(1)
    const render = new RenderPass(scene, camera)
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.35, 1.2)
    /**
     * 蓝色发光在亮度加权后数值偏低，按最强颜色通道提取超出显示范围的能量。
     * 无需提高模型原始发光强度，也能保留蓝色内芯和细灯带的光晕。
     */
    bloom.materialHighPassFilter.fragmentShader = bloom.materialHighPassFilter.fragmentShader.replace(
      'float v = luminance( texel.xyz );',
      'float v = max( texel.r, max( texel.g, texel.b ) );',
    )
    const output = new OutputPass()
    composer.addPass(render)
    composer.addPass(bloom)
    composer.addPass(output)
    const previousTransmissionScale = gl.transmissionResolutionScale
    gl.transmissionResolutionScale = 1
    pipeline.current = { composer, bloom, width: 0, height: 0 }
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
      composer.dispose()
    }
  }, [gl, scene, camera, generation])

  /**
   * 接管主画面渲染，所有普通帧回调完成后才采集；反射仍由原地坪钩子逐帧生成。
   * 使用实际绘制缓冲尺寸响应窗口和像素比变化，不进行帧率采样或动态画质降级。
   */
  useFrame((_, delta) => {
    const current = pipeline.current
    if (current === null) { gl.render(scene, camera); return }
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
       * 内置光晕将输入尺寸减半作为第一层，因此传入双倍尺寸保留完整首层细节。
       * 后续层级只用于不同半径的柔光卷积，主体画面始终保持原始像素分辨率。
       */
      current.bloom.setSize(width * 2, height * 2)
      current.width = width
      current.height = height
    }
    current.composer.render(delta)
  }, 1)
  return null
}
