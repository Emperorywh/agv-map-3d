/**
 * 路权能量场的两套着色器：地面负责扫描波，边缘负责流光和低矮光幕。
 * 动画只读取共享时间，不依赖额外纹理、实时灯光或新增后处理通道。
 */
import * as THREE from 'three'

/**
 * 红色申请区使用较鲜明的扩散脉冲，绿色已锁定区使用较平稳的能量流动。
 * 保留业务基色，只有窄边和波峰输出高动态范围亮度，交给已有光晕通道处理。
 */
export const TRAFFIC_REGION_STYLES = {
  locked: { color: '#48BB78', highlight: '#8CFFC0', height: 0.084, wallHeight: 0.16, fillOrder: 6, edgeOrder: 8 },
  applying: { color: '#D50000', highlight: '#FF584C', height: 0.088, wallHeight: 0.22, fillOrder: 7, edgeOrder: 9 },
} as const
export type TrafficRegionKind = keyof typeof TRAFFIC_REGION_STYLES
export interface TrafficAnimationUniforms {
  readonly time: { value: number }
}

/**
 * 自定义材质必须使用场景相同的对数深度计算，否则近地贴花会穿透车辆或消失。
 * 平面和边界分别传递实际米制坐标与沿轮廓坐标，波动不会随相机旋转而转向。
 */
const FIELD_VERTEX_SHADER = `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec2 regionOrigin;
varying vec2 vPlane;
varying vec2 vLocal;
void main() {
  vPlane = position.xz;
  vLocal = position.xz - regionOrigin;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`

/**
 * 波峰通过导数控制远景混叠；细网格在不足像素时淡出，避免总览出现摩尔纹。
 * 申请区的同心波与已锁定区的交错波仅表达状态活跃，不代表车辆行驶方向。
 */
const FIELD_FRAGMENT_SHADER = `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uApplying;
uniform vec3 uColor;
uniform vec3 uHighlight;
varying vec2 vPlane;
varying vec2 vLocal;
void main() {
  #include <logdepthbuf_fragment>
  float tau = 6.28318530718;
  float radial = length(vLocal) * 0.72 - uTime * 0.72;
  float flowing = dot(vPlane, vec2(0.34, 0.26)) - uTime * 0.42;
  float phase = mix(flowing, radial, uApplying);
  float footprint = max(fwidth(phase), 0.0001);
  float waveFade = 1.0 - smoothstep(0.12, 0.48, footprint);
  float wave = pow(0.5 + 0.5 * cos(phase * tau), mix(9.0, 18.0, uApplying)) * waveFade;
  float echo = pow(0.5 + 0.5 * cos((phase + 0.16) * tau), 5.0) * waveFade;
  float interference = 0.5 + 0.5 * sin(dot(vPlane, vec2(-1.3, 1.7)) + uTime * 0.9);
  float breath = 0.5 + 0.5 * sin(uTime * mix(1.5, 3.0, uApplying));

  // 以米制网格补充能量场细节，远处仅保留低频波动。
  // 网格的抗锯齿宽度来自屏幕导数，不随像素比产生高频闪烁。
  vec2 gridPoint = vPlane * 4.0;
  vec2 gridWidth = max(fwidth(gridPoint), vec2(0.0001));
  vec2 gridDistance = abs(fract(gridPoint - 0.5) - 0.5) / gridWidth;
  float grid = (1.0 - smoothstep(0.0, 0.85, min(gridDistance.x, gridDistance.y)))
    * (1.0 - smoothstep(0.18, 0.6, max(gridWidth.x, gridWidth.y)));
  float energy = wave * mix(0.72 + 0.28 * interference, 1.0, uApplying);
  float alpha = 0.075 + 0.025 * breath + 0.025 * grid + 0.045 * echo + 0.21 * energy;
  vec3 color = mix(uColor * 0.78, uHighlight * 2.25, energy * 0.8);
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/**
 * 光带和光幕共用一个边缘网格，通过顶点标记区分平面与立面。
 * 光幕顶部只有厘米级起伏，底部始终锚定真实路权边界，不改变占用范围。
 */
const EDGE_VERTEX_SHADER = `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uTime;
uniform float uApplying;
attribute float surfaceKind;
attribute float flowCycles;
varying vec2 vEdgeUv;
varying float vSurfaceKind;
varying float vFlowCycles;
void main() {
  vEdgeUv = uv;
  vSurfaceKind = surfaceKind;
  vFlowCycles = flowCycles;
  vec3 transformed = position;
  float flutter = sin(uv.x * flowCycles * 6.28318530718 - uTime * 2.0);
  transformed.y += surfaceKind * uv.y * flutter * mix(0.009, 0.016, uApplying);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  #include <logdepthbuf_vertex>
}
`

/**
 * 轮廓保持常亮细芯，流动亮点沿闭环周期无缝行进；光幕向上衰减至透明。
 * 使用正常透明混合保留明亮地坪上的红绿色，窄芯额外亮度产生局部光晕。
 */
const EDGE_FRAGMENT_SHADER = `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uApplying;
uniform vec3 uColor;
uniform vec3 uHighlight;
varying vec2 vEdgeUv;
varying float vSurfaceKind;
varying float vFlowCycles;
void main() {
  #include <logdepthbuf_fragment>
  float tau = 6.28318530718;
  float phase = vEdgeUv.x * vFlowCycles - uTime * mix(0.48, 0.68, uApplying);
  float phaseFade = 1.0 - smoothstep(0.15, 0.55, fwidth(phase));
  float packet = pow(0.5 + 0.5 * cos(phase * tau), 12.0) * phaseFade;
  float breath = mix(0.9, 0.72, uApplying)
    + mix(0.1, 0.28, uApplying) * (0.5 + 0.5 * sin(uTime * mix(1.5, 3.0, uApplying)));
  float alpha;
  vec3 color;
  if (vSurfaceKind < 0.5) {
    float across = abs(vEdgeUv.y - 0.5) * 2.0;
    float aa = max(fwidth(across), 0.015);
    float core = 1.0 - smoothstep(max(0.0, 0.16 - aa), 0.16 + aa, across);
    float halo = pow(max(0.0, 1.0 - across), 2.0);
    alpha = (core * 0.88 + halo * 0.16) * breath;
    color = uColor * 1.5 + uHighlight * core * (1.6 + 2.0 * packet);
  } else {
    float height = vEdgeUv.y;
    float fade = pow(1.0 - height, 2.2);
    float risingPhase = height * 1.6 - uTime * mix(0.65, 0.9, uApplying);
    float rising = pow(0.5 + 0.5 * cos(risingPhase * tau), 10.0);
    alpha = fade * (0.16 + packet * 0.18 + rising * 0.08) * breath;
    color = mix(uColor * 1.1, uHighlight * 2.6, packet * 0.65 + rising * 0.2);
  }
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(color, min(alpha, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/**
 * 每个材质引用同一个时间容器，逐帧只写一次数值即可推进所有车辆的能量效果。
 * 双面单次绘制兼顾俯视和斜视，保留深度遮挡并关闭拾取相关的深度写入。
 */
export function createTrafficRegionMaterial(
  kind: TrafficRegionKind,
  surface: 'field' | 'edge',
  animation: TrafficAnimationUniforms,
): THREE.ShaderMaterial {
  const style = TRAFFIC_REGION_STYLES[kind]
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: animation.time,
      uApplying: { value: kind === 'applying' ? 1 : 0 },
      uColor: { value: new THREE.Color(style.color) },
      uHighlight: { value: new THREE.Color(style.highlight) },
    },
    vertexShader: surface === 'field' ? FIELD_VERTEX_SHADER : EDGE_VERTEX_SHADER,
    fragmentShader: surface === 'field' ? FIELD_FRAGMENT_SHADER : EDGE_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    toneMapped: false,
    fog: false,
  })
  material.name = `traffic-${kind}-${surface}-energy`
  return material
}
