/**
 * 语义图层补丁材质（SPEC §2.3、§5.1、§6.5；TASK-005；P2-1 充电 LOD）。
 *
 * 职责：为名称四边形提供基于 MeshBasicMaterial 的材质工厂，并提供可注入既
 *       有材质的最小 GLSL 补丁助手，全部经 onBeforeCompile 完成：
 *       - createNameFadeMaterial：按「片元世界坐标到相机距离」平滑淡出名称
 *         （近于 near 全显、远于 far 全隐），实现地标名称的远近显隐，
 *         全程 GPU 侧完成，无逐帧 CPU 写入；
 *       - createScreenSizeFadeUniforms / injectScreenSizeFade（P2-1）：充电柜
 *         与柜面闪电标识的投影尺寸淡出——工业充电柜的受光材质由设施工厂创建，
 *         淡出以注入方式补充，不复制材质；
 *       - injectBrightnessPulse（P2-1）：亮度始终按时间正弦脉动，
 *         动画不受设备性能影响，也不提供画质关闭开关。
 * 边界：只封装材质与注入 uniforms；几何、实例与释放责任归图层组件。注入点
 *       为 three r185 meshbasic / meshstandard 着色器共有的 <common>/
 *       <project_vertex>/<worldpos_vertex>/<opaque_fragment> chunk，
 *       cameraPosition 由 three 内建 uniform 提供。
 * 关键不变量：
 * 1. uniforms 对象在材质创建/注入时即存在并挂在 material.userData.uniforms：
 *    调用方（useFrame）可在着色器首次编译前后随时读写，不需要感知编译状态；
 * 2. 各材质设置 customProgramCacheKey，避免不同注入共享同一编译缓存；注入
 *    助手链式保留既有 onBeforeCompile，同一材质可复合多套注入；
 * 3. 名称材质透明但不写深度（depthWrite=false），淡出只作用于 alpha，不产生
 *    深度残留；脉冲只调制 rgb 亮度，alpha 恒为 1。
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

/** 亮度脉冲注入的 uniforms（userData.uniforms 中可读写） */
export interface PulseUniforms {
  /** 单调累计秒（useFrame 写入）；仅影响脉动相位 */
  readonly uTime: { value: number }
  readonly uPulsePeriod: { value: number }
  readonly uPulseMin: { value: number }
}

/** 屏幕尺寸 LOD 淡出注入的 uniforms（userData.uniforms 中可读写） */
export interface ScreenSizeFadeUniforms {
  /** 参与淡出判定的世界尺寸（米；充电组取柜体高度，组内同步隐现） */
  readonly uWorldSizeM: { value: number }
  /** 视口高度（像素；LandmarksLayer 逐帧写入共享的同一 uniforms 对象） */
  readonly uViewportHeightPx: { value: number }
  readonly uFadeStartPx: { value: number }
  readonly uFadeEndPx: { value: number }
}

/** 创建一组屏幕尺寸淡出 uniforms（世界尺寸 = 充电元素的世界高度，米） */
export function createScreenSizeFadeUniforms(
  worldSizeM: number,
): ScreenSizeFadeUniforms {
  return {
    uWorldSizeM: { value: worldSizeM },
    uViewportHeightPx: { value: 0 },
    uFadeStartPx: { value: 7 },
    uFadeEndPx: { value: 2.5 },
  }
}

/**
 * 向既有材质注入屏幕尺寸 LOD 淡出（P2-1/8.4）：按「世界尺寸」直推投影像素
 * （顶点着色器推导，纯 GPU 完成）。工业充电柜的受光材质由设施工厂创建，
 * 淡出以注入方式补充、不复制材质；柜体与柜面闪电标识共享同一 uniforms 对象，
 * 59 处充电元素在总览同步渐隐、中近景完整呈现，避免成排设施抢戏。
 * 注入链式保留材质既有的 onBeforeCompile（先淡出后脉冲的复合顺序由此保证）；
 * MeshBasic 与 MeshStandard 着色器都具备 <project_vertex>/<opaque_fragment>
 * chunk，同一助手可服务 Unlit 贴花与受光柜体。
 */
export function injectScreenSizeFade(
  material: THREE.Material,
  uniforms: ScreenSizeFadeUniforms,
  cacheKey: string,
): void {
  const injectPrevious = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    injectPrevious.call(material, shader, renderer)
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
  material.customProgramCacheKey = () => cacheKey
  material.userData.uniforms = {
    ...(material.userData.uniforms as Record<string, unknown> | undefined),
    ...uniforms,
  }
}

/**
 * 向既有材质注入正弦亮度脉冲（P2-1）：gl_FragColor.rgb 按时间调制，最暗
 * uPulseMin、最亮 1；每次绘制均使用当前相位，不设置关闭呼吸的分支。
 * 只作用于 rgb，alpha 恒为 1——与淡出注入（作用于 alpha）互不干扰，可复合。
 */
export function injectBrightnessPulse(
  material: THREE.Material,
  uniforms: PulseUniforms,
  cacheKey: string,
): void {
  const injectPrevious = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    injectPrevious.call(material, shader, renderer)
    shader.uniforms.uTime = uniforms.uTime
    shader.uniforms.uPulsePeriod = uniforms.uPulsePeriod
    shader.uniforms.uPulseMin = uniforms.uPulseMin
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform float uTime;',
          'uniform float uPulsePeriod;',
          'uniform float uPulseMin;',
        ].join('\n'),
      )
      .replace(
        '#include <opaque_fragment>',
        [
          '#include <opaque_fragment>',
          'float pulseWave = 0.5 + 0.5 * sin( uTime * 6.28318530718 / max( uPulsePeriod, 0.001 ) );',
          'float pulseBrightness = uPulseMin + ( 1.0 - uPulseMin ) * pulseWave;',
          'gl_FragColor.rgb *= pulseBrightness;',
        ].join('\n'),
      )
  }
  material.customProgramCacheKey = () => cacheKey
  material.userData.uniforms = {
    ...(material.userData.uniforms as Record<string, unknown> | undefined),
    ...uniforms,
  }
}
