/**
 * 语义图层补丁材质（SPEC §2.3、§5.1、§6.5；TASK-005）。
 *
 * 职责：为名称四边形与充电呼吸灯提供两个基于 MeshBasicMaterial 的材质工厂，
 *       通过 onBeforeCompile 注入最小 GLSL：
 *       - createNameFadeMaterial：按「片元世界坐标到相机距离」平滑淡出名称
 *         （近于 near 全显、远于 far 全隐），实现独占区/仓库名称的远近显隐，
 *         全程 GPU 侧完成，无逐帧 CPU 写入；
 *       - createPulseMaterial：呼吸灯亮度按时间正弦脉动，uPulseEnabled=0 时
 *         恒定全亮——装饰动画能力开关（可被 TASK-014 质量控制关闭）。
 * 边界：只封装材质与注入 uniforms；几何、实例与释放责任归图层组件。注入点
 *       为 three r185 meshbasic 着色器的 <common>/<worldpos_vertex>/
 *       <opaque_fragment> chunk，cameraPosition 由 three 内建 uniform 提供。
 * 关键不变量：
 * 1. uniforms 对象在材质创建时即存在并挂在 material.userData.uniforms：调用方
 *    （useFrame/测试）可在着色器首次编译前后随时读写，不需要感知编译状态；
 * 2. 两种材质各自设置 customProgramCacheKey，避免不同注入共享同一编译缓存；
 * 3. 名称材质透明但不写深度（depthWrite=false），淡出只作用于 alpha，不产生
 *    深度残留；呼吸灯只调制 rgb 亮度，alpha 恒为 1。
 */
import * as THREE from 'three'

/** 名称淡出材质注入的 uniforms（userData.uniforms 中可读写） */
export interface NameFadeUniforms {
  readonly uFadeNear: { value: number }
  readonly uFadeFar: { value: number }
}

/**
 * 名称四边形材质：图集纹理 + 距离淡出。
 * nearM/farM 为显隐过渡区间（米）：距离 < near 完全可见，> far 完全隐藏。
 */
export function createNameFadeMaterial(
  texture: THREE.Texture,
  nearM: number,
  farM: number,
): THREE.MeshBasicMaterial {
  const uniforms: NameFadeUniforms = {
    uFadeNear: { value: nearM },
    uFadeFar: { value: farM },
  }
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  material.name = 'map-name-fade'
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFadeNear = uniforms.uFadeNear
    shader.uniforms.uFadeFar = uniforms.uFadeFar
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNameWorldPos;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvNameWorldPos = (modelMatrix * vec4( transformed, 1.0 )).xyz;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vNameWorldPos;\nuniform float uFadeNear;\nuniform float uFadeFar;',
      )
      .replace(
        '#include <opaque_fragment>',
        [
          '#include <opaque_fragment>',
          'float nameFade = 1.0 - smoothstep( uFadeNear, uFadeFar, length( vNameWorldPos - cameraPosition ) );',
          'if ( nameFade <= 0.003 ) discard;',
          'gl_FragColor.a *= nameFade;',
        ].join('\n'),
      )
  }
  // 注入内容是固定的：以稳定 key 声明程序缓存身份，避免与其他补丁材质互串
  material.customProgramCacheKey = () => 'map-name-fade'
  material.userData.uniforms = uniforms
  return material
}

/** 呼吸灯材质注入的 uniforms（userData.uniforms 中可读写） */
export interface PulseUniforms {
  /** 单调累计秒（useFrame 写入）；仅影响脉动相位 */
  readonly uTime: { value: number }
  /** 1 = 呼吸启用；0 = 恒定全亮（装饰动画关闭） */
  readonly uPulseEnabled: { value: number }
  readonly uPulsePeriod: { value: number }
  readonly uPulseMin: { value: number }
}

/** 呼吸灯材质：恒定色相、正弦亮度脉动；返回材质与可写 uniforms */
export function createPulseMaterial(color: string): {
  material: THREE.MeshBasicMaterial
  uniforms: PulseUniforms
} {
  const uniforms: PulseUniforms = {
    uTime: { value: 0 },
    uPulseEnabled: { value: 1 },
    uPulsePeriod: { value: 1 },
    uPulseMin: { value: 0 },
  }
  const material = new THREE.MeshBasicMaterial({ color })
  material.name = 'map-charge-pulse'
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime
    shader.uniforms.uPulseEnabled = uniforms.uPulseEnabled
    shader.uniforms.uPulsePeriod = uniforms.uPulsePeriod
    shader.uniforms.uPulseMin = uniforms.uPulseMin
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform float uTime;',
          'uniform float uPulseEnabled;',
          'uniform float uPulsePeriod;',
          'uniform float uPulseMin;',
        ].join('\n'),
      )
      .replace(
        '#include <opaque_fragment>',
        [
          '#include <opaque_fragment>',
          'float pulseWave = 0.5 + 0.5 * sin( uTime * 6.28318530718 / max( uPulsePeriod, 0.001 ) );',
          'float pulseBrightness = mix( 1.0, uPulseMin + ( 1.0 - uPulseMin ) * pulseWave, uPulseEnabled );',
          'gl_FragColor.rgb *= pulseBrightness;',
        ].join('\n'),
      )
  }
  material.customProgramCacheKey = () => 'map-charge-pulse'
  material.userData.uniforms = uniforms
  return { material, uniforms }
}
