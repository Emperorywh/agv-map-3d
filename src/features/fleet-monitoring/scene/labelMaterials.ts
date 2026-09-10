/**
 * 车辆标签采用透明底的编号与状态双行文字，始终在视空间朝向相机。
 * 两层实例网格复用状态和告警属性；选中只显示短下划线，不绘制面板、电量条或边框。
 * 字形由图集提供，状态变化只更新实例属性，不增加逐车材质或绘制调用。
 */
import * as THREE from 'three'
import {
  LABEL_ASPECT,
  LABEL_ALERT_L1_COLOR,
  LABEL_ALERT_L2_COLOR,
  LABEL_SELECTED_COLOR,
} from './fleetAppearance'

/**
 * 属性顺序与帧同步的脏标记索引保持一致。
 * 状态色与告警属性同时挂到名称几何，保证两行文字同步变化。
 */
export const LABEL_BG_ATTRIBUTE_NAMES = ['aStateColor', 'aOverlay', 'aChipUv', 'aLevel'] as const
export const LABEL_BG_ATTR = { stateColor: 0, overlay: 1, chipUv: 2, level: 3 } as const
export const LABEL_TEXT_ATTRIBUTE_NAME = 'aNameUv'
const LABEL_BG_ATTRIBUTE_INIT: ReadonlyArray<readonly number[]> = [
  [1, 1, 1],
  [0, 0],
  [0, 0, 0, 0],
  [1],
]

/**
 * 每个批次独立持有几何与实例缓冲，避免跨批次修改状态。
 * 空槽位的隐藏仍由零缩放实例矩阵控制。
 */
export function createLabelQuadGeometry(
  attributeNames: readonly string[],
  attributeItemSizes: readonly number[],
  attributeInit: readonly (readonly number[])[],
  capacity: number,
): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(1, 1)
  for (let i = 0; i < attributeNames.length; i += 1) {
    const itemSize = attributeItemSizes[i]
    const init = attributeInit[i]
    const array = new Float32Array(capacity * itemSize)
    for (let instance = 0; instance < capacity; instance += 1) {
      for (let c = 0; c < itemSize; c += 1) array[instance * itemSize + c] = init[c]
    }
    const attribute = new THREE.InstancedBufferAttribute(array, itemSize)
    attribute.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute(attributeNames[i], attribute)
  }
  return geometry
}

/**
 * 历史背景层现在只负责状态文字、选中短线与告警符号。
 * 编号层共享该层的状态属性，图集坐标仍按各自槽位独立更新。
 */
export function createLabelBackgroundGeometry(capacity: number): THREE.PlaneGeometry {
  return createLabelQuadGeometry(LABEL_BG_ATTRIBUTE_NAMES, [3, 2, 4, 1], LABEL_BG_ATTRIBUTE_INIT, capacity)
}

export function createLabelTextGeometry(capacity: number): THREE.PlaneGeometry {
  return createLabelQuadGeometry([LABEL_TEXT_ATTRIBUTE_NAME], [4], [[0, 0, 0, 0]], capacity)
}

/**
 * 标签只读取实例矩阵的位置与尺寸，在相机平面展开，旋转视角时不会镜像。
 * 两层统一参与对数深度测试，保持文字与场景实体的遮挡关系。
 */
function billboardBody(extraAttributes: string, extraVaryings: string, extraAssign: string): string {
  return `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aStateColor;
attribute vec2 aOverlay;
varying vec3 vStateColor;
varying vec2 vOverlay;
varying vec2 vUv;
${extraAttributes}
${extraVaryings}
void main() {
  vStateColor = aStateColor;
  vOverlay = aOverlay;
${extraAssign}
  vec4 center;
  float sx;
  float sy;
  #ifdef USE_INSTANCING
  center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  sx = length(instanceMatrix[0].xyz);
  sy = length(instanceMatrix[1].xyz);
  #else
  center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  sx = 1.0;
  sy = 1.0;
  #endif
  center.xy += vec2(position.x * sx, position.y * sy);
  gl_Position = projectionMatrix * center;
  #include <logdepthbuf_vertex>
}
`
}

/**
 * 告警色优先于普通状态色，编号与状态行共用相同决策。
 * 颜色输入均为线性值，输出统一进行显示色彩空间转换。
 */
const LABEL_TINT = `
varying vec3 vStateColor;
varying vec2 vOverlay;
vec3 labelTint() {
  return vOverlay.y > 1.5 ? ALERT_L2_COLOR : vOverlay.y > 0.5 ? ALERT_L1_COLOR : vStateColor;
}
`

const LABEL_TEXT_VERTEX = billboardBody(
  'attribute vec4 aNameUv;',
  '',
  '  vUv = mix(aNameUv.xy, aNameUv.zw, uv);',
)

const LABEL_TEXT_FRAGMENT = `
#include <logdepthbuf_pars_fragment>
uniform sampler2D uNameMap;
varying vec2 vUv;
${LABEL_TINT}
void main() {
  vec4 texel = texture2D(uNameMap, vUv);
  if (texel.a < 0.02) discard;
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(texel.rgb * labelTint(), texel.a);
  #include <colorspace_fragment>
}
`

const LABEL_BACKGROUND_VERTEX = billboardBody(
  'attribute vec4 aChipUv; attribute float aLevel;',
  'varying vec4 vChipUv; varying float vLevel;',
  '  vUv = uv; vChipUv = aChipUv; vLevel = aLevel;',
)

/**
 * 次行和编号保持同一左边距，所有无内容区域完全透明。
 * 短下划线表达选中，小型三角感叹号表达告警，不产生整块悬浮色板。
 */
const LABEL_BACKGROUND_FRAGMENT = `
#include <logdepthbuf_pars_fragment>
uniform sampler2D uBadgeMap;
varying vec2 vUv;
varying vec4 vChipUv;
varying float vLevel;
${LABEL_TINT}
void main() {
  vec3 color = labelTint();
  float opacity = 0.0;
  if (vLevel > 0.5 && vChipUv.z > vChipUv.x && vUv.y > 0.10 && vUv.y < 0.50) {
    vec2 statusUv = vec2(vUv.x, (vUv.y - 0.10) / 0.40);
    vec4 glyph = texture2D(uBadgeMap, mix(vChipUv.xy, vChipUv.zw, statusUv));
    color = glyph.rgb * labelTint();
    opacity = glyph.a * 0.94;
  }
  if (vOverlay.x > 0.5 && vUv.x > 0.04 && vUv.x < 0.17) {
    float edge = max(fwidth(vUv.y), 0.003);
    float line = 1.0 - smoothstep(0.008, 0.008 + edge, abs(vUv.y - 0.045));
    if (line > opacity) { color = SELECTED_COLOR; opacity = line * 0.72; }
  }
  if (vOverlay.y > 0.5) {
    vec2 q = vec2((vUv.x - 0.94) * float(LABEL_ASPECT), vUv.y - 0.69);
    float triangle = max(abs(q.x) * 0.866025 + q.y * 0.5 - 0.065, -q.y - 0.065);
    float edge = max(fwidth(triangle), 0.003);
    float icon = 1.0 - smoothstep(-edge, edge, triangle);
    if (icon > 0.0) {
      float stem = (1.0 - smoothstep(0.008, 0.014, abs(q.x))) * step(-0.01, q.y) * step(q.y, 0.055);
      float dot = 1.0 - smoothstep(0.008, 0.014, length(q - vec2(0.0, -0.038)));
      color = mix(labelTint(), vec3(0.006, 0.012, 0.022), max(stem, dot));
      opacity = icon;
    }
  }
  if (opacity < 0.02) discard;
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(color, opacity);
  #include <colorspace_fragment>
}
`

/**
 * 色值从共享外观常量转换为线性着色器常量，避免手工重复伽马转换。
 * 标签不受场景曝光染色，但保留正常透明混合与深度测试。
 */
function colorDefineVec3(hex: string): string {
  const color = new THREE.Color(hex)
  return `vec3(${color.r.toFixed(6)}, ${color.g.toFixed(6)}, ${color.b.toFixed(6)})`
}

function labelDefines() {
  return {
    ALERT_L1_COLOR: colorDefineVec3(LABEL_ALERT_L1_COLOR),
    ALERT_L2_COLOR: colorDefineVec3(LABEL_ALERT_L2_COLOR),
    SELECTED_COLOR: colorDefineVec3(LABEL_SELECTED_COLOR),
    LABEL_ASPECT: String(LABEL_ASPECT),
  }
}

/**
 * 编号层只采样自己的名称图集，状态层只采样共享状态图集。
 * 两层不写深度，仍保持原有批次释放与渲染排序约定。
 */
export function createLabelTextMaterial(atlasTexture: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    toneMapped: false,
    uniforms: { uNameMap: { value: atlasTexture } },
    vertexShader: LABEL_TEXT_VERTEX,
    fragmentShader: LABEL_TEXT_FRAGMENT,
    defines: labelDefines(),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}

export function createLabelBackgroundMaterial(badgeTexture: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    toneMapped: false,
    uniforms: { uBadgeMap: { value: badgeTexture } },
    vertexShader: LABEL_BACKGROUND_VERTEX,
    fragmentShader: LABEL_BACKGROUND_FRAGMENT,
    defines: labelDefines(),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}
