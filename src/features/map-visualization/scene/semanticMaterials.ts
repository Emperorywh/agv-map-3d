/**
 * 语义图层补丁材质（SPEC §2.3、§5.1、§6.5；TASK-005；P2-1 充电 LOD）。
 *
 * 职责：为名称四边形、充电呼吸灯与节点实例层提供基于 MeshBasicMaterial
 *       的材质工厂，通过 onBeforeCompile 注入最小 GLSL：
 *       - createNameFadeMaterial：按「片元世界坐标到相机距离」平滑淡出名称
 *         （近于 near 全显、远于 far 全隐），实现独占区/仓库名称的远近显隐，
 *         全程 GPU 侧完成，无逐帧 CPU 写入；
 *       - createPulseMaterial：呼吸灯亮度按时间正弦脉动，uPulseEnabled=0 时
 *         恒定全亮——装饰动画能力开关（可被 TASK-014 质量控制关闭）；
 *       - createNodeLodMaterial：节点盘按投影尺寸淡出（P1-5 shader LOD），
 *         总览回归路网骨架，近景不受影响；
 *       - createChargeFadeMaterial / createChargeFadePulseMaterial（P2-1）：
 *         充电立柱/光环/闪电贴花的投影尺寸淡出（与节点同思路、以世界尺寸
 *         直推投影），底环版复合亮度脉冲。
 * 边界：只封装材质与注入 uniforms；几何、实例与释放责任归图层组件。注入点
 *       为 three r185 meshbasic 着色器的 <common>/<project_vertex>/
 *       <worldpos_vertex>/<opaque_fragment> chunk，cameraPosition 由 three
 *       内建 uniform 提供。
 * 关键不变量：
 * 1. uniforms 对象在材质创建时即存在并挂在 material.userData.uniforms：调用方
 *    （useFrame/测试）可在着色器首次编译前后随时读写，不需要感知编译状态；
 * 2. 各材质设置 customProgramCacheKey，避免不同注入共享同一编译缓存；
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

/** 节点屏幕尺寸 LOD 淡出材质注入的 uniforms（userData.uniforms 中可读写） */
export interface NodeLodUniforms {
  /** 节点圆盘世界半径（米，来自 NODE_RADIUS_M） */
  readonly uNodeRadiusM: { value: number }
  /** 视口高度（像素；NodesLayer 逐帧按当前尺寸写入，变化才有实际影响） */
  readonly uViewportHeightPx: { value: number }
  /** 淡出区间（投影直径像素）：≥ start 全显、≤ end 全隐 */
  readonly uFadeStartPx: { value: number }
  readonly uFadeEndPx: { value: number }
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

/**
 * 节点屏幕尺寸 LOD 淡出材质（视觉差距分析 P1-5/2.3）：顶点着色器按「世界
 * 半径 × 投影矩阵 × 视口高 ÷ 视深」推导投影直径（像素），片元在
 * [uFadeEndPx, uFadeStartPx] 区间内平滑淡出 alpha——总览距离下 4291 个
 * 节点盘（投影 < 4px）渐隐、路网骨架回归可读，近景完全不受影响。
 * 纯 GPU 实现：不写实例缓冲，不破坏 NodesLayer 的静态上载不变量。
 * vertexColors（P2-3）：最终色 = 顶点色（盘 1 / 描边 0.22）× 实例色，
 * 暗描边内环由此随节点色相表达，无需额外 Draw Call。
 */
export function createNodeLodMaterial(): {
  material: THREE.MeshBasicMaterial
  uniforms: NodeLodUniforms
} {
  const uniforms: NodeLodUniforms = {
    uNodeRadiusM: { value: 0.25 },
    uViewportHeightPx: { value: 0 },
    uFadeStartPx: { value: 3.5 },
    uFadeEndPx: { value: 1.5 },
  }
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    vertexColors: true,
  })
  material.name = 'map-node-lod'
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNodeRadiusM = uniforms.uNodeRadiusM
    shader.uniforms.uViewportHeightPx = uniforms.uViewportHeightPx
    shader.uniforms.uFadeStartPx = uniforms.uFadeStartPx
    shader.uniforms.uFadeEndPx = uniforms.uFadeEndPx
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform float uNodeRadiusM;',
          'uniform float uViewportHeightPx;',
          'varying float vNodeFadePx;',
        ].join('\n'),
      )
      .replace(
        '#include <project_vertex>',
        [
          '#include <project_vertex>',
          '// 投影直径(px) = 2r · f · H/2 / (−z_view)，f = projectionMatrix[1].y = 1/tan(fov/2)',
          'float nodeDepth = max( -mvPosition.z, 0.0001 );',
          'vNodeFadePx = 2.0 * uNodeRadiusM * projectionMatrix[1].y * uViewportHeightPx * 0.5 / nodeDepth;',
        ].join('\n'),
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform float uFadeStartPx;',
          'uniform float uFadeEndPx;',
          'varying float vNodeFadePx;',
        ].join('\n'),
      )
      .replace(
        '#include <opaque_fragment>',
        [
          '#include <opaque_fragment>',
          'float nodeFade = smoothstep( uFadeEndPx, uFadeStartPx, vNodeFadePx );',
          'if ( nodeFade <= 0.003 ) discard;',
          'gl_FragColor.a *= nodeFade;',
        ].join('\n'),
      )
  }
  material.customProgramCacheKey = () => 'map-node-lod'
  material.userData.uniforms = uniforms
  return { material, uniforms }
}

/** 充电元素屏幕尺寸 LOD 淡出注入的 uniforms（userData.uniforms 中可读写） */
export interface ScreenSizeFadeUniforms {
  /** 参与淡出判定的世界尺寸（米；充电组取立柱高度，组内同步隐现） */
  readonly uWorldSizeM: { value: number }
  /** 视口高度（像素；LandmarksLayer 逐帧写入共享的同一 uniforms 对象） */
  readonly uViewportHeightPx: { value: number }
  readonly uFadeStartPx: { value: number }
  readonly uFadeEndPx: { value: number }
}

export interface ChargeFadeMaterialOptions {
  /** 基础色（与 map 互斥使用；默认白） */
  readonly color?: string
  /** 图集纹理（闪电贴花等）；null/省略 = 纯色 */
  readonly map?: THREE.Texture | null
  /** 基础透明度（默认 1） */
  readonly opacity?: number
}

/**
 * 充电元素 LOD 淡出材质（P2-1/8.4）：与节点 LOD（createNodeLodMaterial）
 * 同款 shader 淡出，但以「世界尺寸」直接参与投影推导——立柱/光环/闪电贴花
 * 传入同一 uWorldSizeM（立柱高度）与共享 uniforms 对象，59 处充电元素在
 * 总览同步渐隐、中近景完整呈现，避免成排发光体抢戏。
 */
export function createChargeFadeMaterial(
  options: ChargeFadeMaterialOptions = {},
): {
  material: THREE.MeshBasicMaterial
  uniforms: ScreenSizeFadeUniforms
} {
  const uniforms: ScreenSizeFadeUniforms = {
    uWorldSizeM: { value: 1 },
    uViewportHeightPx: { value: 0 },
    uFadeStartPx: { value: 7 },
    uFadeEndPx: { value: 2.5 },
  }
  const material = new THREE.MeshBasicMaterial({
    color: options.color ?? '#ffffff',
    map: options.map ?? null,
    transparent: true,
    opacity: options.opacity ?? 1,
    depthWrite: false,
  })
  material.name = 'map-charge-fade'
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWorldSizeM = uniforms.uWorldSizeM
    shader.uniforms.uViewportHeightPx = uniforms.uViewportHeightPx
    shader.uniforms.uFadeStartPx = uniforms.uFadeStartPx
    shader.uniforms.uFadeEndPx = uniforms.uFadeEndPx
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform float uWorldSizeM;',
          'uniform float uViewportHeightPx;',
          'varying float vChargeFadePx;',
        ].join('\n'),
      )
      .replace(
        '#include <project_vertex>',
        [
          '#include <project_vertex>',
          '// 投影尺寸(px) = 世界尺寸 · f · H/2 / (−z_view)，f = projectionMatrix[1].y',
          'float chargeDepth = max( -mvPosition.z, 0.0001 );',
          'vChargeFadePx = uWorldSizeM * projectionMatrix[1].y * uViewportHeightPx * 0.5 / chargeDepth;',
        ].join('\n'),
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform float uFadeStartPx;',
          'uniform float uFadeEndPx;',
          'varying float vChargeFadePx;',
        ].join('\n'),
      )
      .replace(
        '#include <opaque_fragment>',
        [
          '#include <opaque_fragment>',
          'float chargeFade = smoothstep( uFadeEndPx, uFadeStartPx, vChargeFadePx );',
          'if ( chargeFade <= 0.003 ) discard;',
          'gl_FragColor.a *= chargeFade;',
        ].join('\n'),
      )
  }
  material.customProgramCacheKey = () => 'map-charge-fade'
  material.userData.uniforms = uniforms
  return { material, uniforms }
}

/** 充电淡出 + 脉冲复合材质的 uniforms（两套注入共用一个对象） */
export type ChargeFadePulseUniforms = ScreenSizeFadeUniforms & PulseUniforms

/**
 * 充电底环材质（P2-1）：LOD 淡出 + 正弦亮度脉冲复合注入——底环随呼吸灯同
 * 周期脉动（uTime/uPulseEnabled 由图层逐帧写入），总览与立柱同步淡出。
 */
export function createChargeFadePulseMaterial(
  color: string,
  pulsePeriodS: number,
  pulseMinBrightness: number,
): {
  material: THREE.MeshBasicMaterial
  uniforms: ChargeFadePulseUniforms
} {
  const fade = createChargeFadeMaterial({ color })
  const pulseUniforms: PulseUniforms = {
    uTime: { value: 0 },
    uPulseEnabled: { value: 1 },
    uPulsePeriod: { value: pulsePeriodS },
    uPulseMin: { value: pulseMinBrightness },
  }
  const material = fade.material
  material.name = 'map-charge-fade-pulse'
  material.side = THREE.DoubleSide
  const injectFade = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    injectFade(shader, renderer)
    shader.uniforms.uTime = pulseUniforms.uTime
    shader.uniforms.uPulseEnabled = pulseUniforms.uPulseEnabled
    shader.uniforms.uPulsePeriod = pulseUniforms.uPulsePeriod
    shader.uniforms.uPulseMin = pulseUniforms.uPulseMin
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
          'float ringPulseWave = 0.5 + 0.5 * sin( uTime * 6.28318530718 / max( uPulsePeriod, 0.001 ) );',
          'float ringPulseBrightness = mix( 1.0, uPulseMin + ( 1.0 - uPulseMin ) * ringPulseWave, uPulseEnabled );',
          'gl_FragColor.rgb *= ringPulseBrightness;',
        ].join('\n'),
      )
  }
  material.customProgramCacheKey = () => 'map-charge-fade-pulse'
  material.userData.uniforms = { ...fade.uniforms, ...pulseUniforms }
  return { material, uniforms: material.userData.uniforms as ChargeFadePulseUniforms }
}
