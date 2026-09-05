/**
 * 语义图层补丁材质（SPEC §2.3、§5.1、§6.5；TASK-005；P2-1 充电 LOD）。
 *
 * 职责：为名称四边形与节点实例层提供基于 MeshBasicMaterial 的材质工厂，并
 *       提供可注入既有材质的最小 GLSL 补丁助手，全部经 onBeforeCompile 完成：
 *       - createNameFadeMaterial：按「片元世界坐标到相机距离」平滑淡出名称
 *         （近于 near 全显、远于 far 全隐），实现地标名称的远近显隐，
 *         全程 GPU 侧完成，无逐帧 CPU 写入；
 *       - createNodeLodMaterial：节点盘按投影尺寸淡出（P1-5 shader LOD），
 *         总览回归路网骨架，近景不受影响；
 *       - createScreenSizeFadeUniforms / injectScreenSizeFade（P2-1）：充电柜
 *         与柜面闪电标识的投影尺寸淡出——工业充电柜的受光材质由设施工厂创建，
 *         淡出以注入方式补充，不复制材质；
 *       - injectBrightnessPulse（P2-1）：亮度按时间正弦脉动，uPulseEnabled=0
 *         时恒定全亮——装饰动画能力开关（可被 TASK-014 质量控制关闭）。
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
import { NODE_SYMBOL_COLOR } from './mapAppearance'

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
  /** 场景细节等级（P0-5.1）：由场景控制器共享写入，与角色最低等级比较 */
  readonly uSceneLevel: { value: number }
}

/**
 * 节点屏幕尺寸 LOD 淡出材质（视觉差距分析 P1-5/2.3）：顶点着色器按「世界
 * 半径 × 投影矩阵 × 视口高 ÷ 视深」推导投影直径（像素），片元在
 * [uFadeEndPx, uFadeStartPx] 区间内平滑淡出 alpha——总览距离下 4291 个
 * 节点盘（投影 < 4px）渐隐、路网骨架回归可读，近景完全不受影响。
 * 纯 GPU 实现：不写实例缓冲，不破坏 NodesLayer 的静态上载不变量。
 * 底座和轮廓使用顶点色乘数 × 实例色，图标掩码单独保留白色笔画。
 * 图标与顶面共用同一实例和淡出，暗色顶面保证符号不被类型色吞没。
 * 场景等级门控（P0-5.4/5.1）：实例属性 aMinLevel（角色 → 最低可见场景等
 * 级）与共享 uniform uSceneLevel 比较，step 结果乘入淡出系数——总览隐藏
 * 普通节点、近景才显示纯导航控制点与单个库位，全程 GPU 侧完成。
 * depthWrite=true：立体圆台的层间与实例间遮挡由深度测试保证，与
 * 绘制顺序无关；淡出中间态的深度残留仅出现在投影 ≤3.5px 的节点上，完全
 * 淡出（≤0.003）由 discard 兜底，不产生不可见深度遮挡。
 */
export function createNodeLodMaterial(options: {
  /** 共享的场景等级 uniform；缺省时自建（值为 0，等同总览） */
  sceneLevelUniform?: { value: number }
} = {}): {
  material: THREE.MeshBasicMaterial
  uniforms: NodeLodUniforms
} {
  const uniforms: NodeLodUniforms = {
    uNodeRadiusM: { value: 0.25 },
    uViewportHeightPx: { value: 0 },
    uFadeStartPx: { value: 3.5 },
    uFadeEndPx: { value: 1.5 },
    uSceneLevel: options.sceneLevelUniform ?? { value: 0 },
  }
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    depthWrite: true,
    vertexColors: true,
  })
  material.name = 'map-node-lod'
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNodeRadiusM = uniforms.uNodeRadiusM
    shader.uniforms.uViewportHeightPx = uniforms.uViewportHeightPx
    shader.uniforms.uFadeStartPx = uniforms.uFadeStartPx
    shader.uniforms.uFadeEndPx = uniforms.uFadeEndPx
    shader.uniforms.uSceneLevel = uniforms.uSceneLevel
    /**
     * 符号颜色在色彩空间转换前写入，与常规顶点色使用相同的线性空间。
     * 六种几何共享该材质，只额外提供一个静态符号掩码属性。
     */
    shader.uniforms.uNodeSymbolColor = { value: new THREE.Color(NODE_SYMBOL_COLOR) }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform float uNodeRadiusM;',
          'uniform float uViewportHeightPx;',
          'uniform float uSceneLevel;',
          'attribute float aMinLevel;',
          'attribute float aNodeSymbol;',
          'varying float vNodeSymbol;',
          'varying float vNodeFadePx;',
          'varying float vRoleVisible;',
        ].join('\n'),
      )
      .replace(
        '#include <project_vertex>',
        [
          '#include <project_vertex>',
          'vNodeSymbol = aNodeSymbol;',
          '/**',
          ' * 密集节点的水平缩放来自实例矩阵，淡出必须使用实际显示半径。',
          ' * 裁剪坐标 w 在正交投影中为 1，在透视投影中为视深，统一两种口径。',
          ' */',
          'float nodeScale = max( length( instanceMatrix[0].xyz ), length( instanceMatrix[2].xyz ) );',
          'float nodeDepth = max( gl_Position.w, 0.0001 );',
          'vNodeFadePx = 2.0 * uNodeRadiusM * nodeScale * projectionMatrix[1].y * uViewportHeightPx * 0.5 / nodeDepth;',
          '// 场景等级门控：实例最低可见等级 ≤ 当前等级才可见（P0-5.4/5.1）',
          'vRoleVisible = step( aMinLevel, uSceneLevel );',
        ].join('\n'),
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform float uFadeStartPx;',
          'uniform float uFadeEndPx;',
          'uniform vec3 uNodeSymbolColor;',
          'varying float vNodeSymbol;',
          'varying float vNodeFadePx;',
          'varying float vRoleVisible;',
        ].join('\n'),
      )
      .replace(
        '#include <color_fragment>',
        [
          '#include <color_fragment>',
          '/**',
          ' * 符号使用独立浅色，底座保留按实例类别计算的颜色与层次。',
          ' * 掩码来自几何顶点，不增加图标贴图或逐节点绘制调用。',
          ' */',
          'diffuseColor.rgb = mix( diffuseColor.rgb, uNodeSymbolColor, vNodeSymbol );',
        ].join('\n'),
      )
      .replace(
        '#include <opaque_fragment>',
        [
          '#include <opaque_fragment>',
          'float nodeFade = smoothstep( uFadeEndPx, uFadeStartPx, vNodeFadePx ) * vRoleVisible;',
          'if ( nodeFade <= 0.003 ) discard;',
          'gl_FragColor.a *= nodeFade;',
        ].join('\n'),
      )
  }
  /**
   * 实例缩放参与投影后使用独立程序标识，防止旧的固定半径着色器被缓存复用。
   * 几何矩阵与淡出阈值始终使用同一份节点显示尺度。
   */
  material.customProgramCacheKey = () => 'map-node-lod-semantic-symbols-v2'
  material.userData.uniforms = uniforms
  return { material, uniforms }
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
 * 向既有材质注入屏幕尺寸 LOD 淡出（P2-1/8.4）：与节点 LOD
 * （createNodeLodMaterial）同款投影推导，但以「世界尺寸」直推投影像素。
 * 工业充电柜的受光材质由设施工厂创建，淡出以注入方式补充、不复制材质；
 * 柜体与柜面闪电标识共享同一 uniforms 对象，59 处充电元素在总览同步渐隐、
 * 中近景完整呈现，避免成排设施抢戏。
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
 * uPulseMin、最亮 1；uPulseEnabled=0 时恒定全亮（装饰动画能力开关）。
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
  material.customProgramCacheKey = () => cacheKey
  material.userData.uniforms = {
    ...(material.userData.uniforms as Record<string, unknown> | undefined),
    ...uniforms,
  }
}
