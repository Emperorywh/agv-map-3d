/**
 * 车辆标签 billboard 材质与实例属性几何（SPEC §5.1、§6.4、§7.2；TASK-011）。
 *
 * 职责：
 * 1. createLabelQuadGeometry：按属性清单构建带 InstancedBufferAttribute 的
 *    单位四边形几何——每个标签批次独享几何实例（实例属性不能挂在跨批次
 *    共享的几何上），属性初值统一填充；
 * 2. createLabelTextMaterial：名称层 ShaderMaterial——顶点侧做视空间 billboard
 *    对齐（永远朝相机）并从实例属性取图集 UV，片元侧采样名称图集；
 * 3. createLabelBackgroundMaterial：背景层 ShaderMaterial——状态底色、L1/L2
 *    告警边框、选中边框、电量条与状态芯片全部由实例属性 + shader 绘制，
 *    电量/选中/告警变化绝不重绘名称纹理（SPEC §6.4）。
 * 边界：只创建材质与几何（由批次所有者释放，本模块不持有）；不创建
 *       InstancedMesh、不写实例缓冲（帧同步层职责）；不采样 DOM/CSS。
 * 关键不变量：
 * 1. billboard 在视空间展开：顶点先取实例中心（含零缩放矩阵的退化），再按
 *    实例矩阵的 x/y 轴长度在视空间展开四边形——矩阵零缩放即标签整体隐藏，
 *    四边形恒垂直于视线，任何轨道角度下文字不镜像；
 * 2. 每批次恒为背景 + 名称两层网格 = 2 个 Draw Call（SPEC §6.4 上限）；
 * 3. 内容档位 aLevel 在 shader 内裁剪：电量条与状态芯片仅在档位 ≥2 绘制，
 *    名称在 ≥1 档始终绘制；隐藏档由矩阵零缩放表达（与车体同口径）；
 * 4. 颜色常量经 defines 注入（线性空间），与场景共用 tone mapping 和输出
 *    色彩空间转换，标签与车体色一致；L1/L2 边框色与 fleetAppearance 同源。
 */
import * as THREE from 'three'
import {
  LABEL_BORDER_L1_COLOR,
  LABEL_BORDER_L2_COLOR,
  LABEL_BORDER_SELECTED_COLOR,
  LABEL_BATTERY_CRITICAL_COLOR,
  LABEL_BATTERY_LOW_COLOR,
  LABEL_BATTERY_OK_COLOR,
} from './fleetAppearance'
import {
  BATTERY_NORMAL_THRESHOLD,
  LOW_BATTERY_THRESHOLD,
} from '../model/deriveVehicleState'

/** 背景层实例属性名（数组序即批次内属性索引，帧同步层按索引写脏标记） */
export const LABEL_BG_ATTRIBUTE_NAMES = [
  'aStateColor',
  'aCharge',
  'aOverlay',
  'aChipUv',
  'aLevel',
] as const

/** 背景层属性索引（帧同步层写值时使用，避免魔法数字） */
export const LABEL_BG_ATTR = {
  stateColor: 0,
  charge: 1,
  overlay: 2,
  chipUv: 3,
  level: 4,
} as const

/** 名称层实例属性名 */
export const LABEL_TEXT_ATTRIBUTE_NAME = 'aNameUv'

/** 背景层属性初值（与 LABEL_BG_ATTRIBUTE_NAMES 一一对应；实例级重复填充） */
const LABEL_BG_ATTRIBUTE_INIT: ReadonlyArray<readonly number[]> = [
  [1, 1, 1], // aStateColor：白（隐藏态由矩阵表达）
  [-1], // aCharge：负值 = 电量未知，不绘制电量条
  [0, 0], // aOverlay：未选中、无告警
  [0, 0, 0, 0], // aChipUv：零矩形 = 无芯片
  [1], // aLevel：默认仅名称档
]

/**
 * 创建带实例属性的单位四边形几何（PlaneGeometry 1×1，中心原点）。
 * capacity 为实例容量；init 数组按实例逐个重复填充。
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
      for (let c = 0; c < itemSize; c += 1) {
        array[instance * itemSize + c] = init[c]
      }
    }
    const attribute = new THREE.InstancedBufferAttribute(array, itemSize)
    attribute.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute(attributeNames[i], attribute)
  }
  return geometry
}

/** 背景层几何：五组实例属性 + 容量（每批次独享） */
export function createLabelBackgroundGeometry(capacity: number): THREE.PlaneGeometry {
  const itemSizes = LABEL_BG_ATTRIBUTE_NAMES.map(
    (name) => ({ aStateColor: 3, aCharge: 1, aOverlay: 2, aChipUv: 4, aLevel: 1 })[name],
  )
  return createLabelQuadGeometry(
    LABEL_BG_ATTRIBUTE_NAMES,
    itemSizes,
    LABEL_BG_ATTRIBUTE_INIT,
    capacity,
  )
}

/** 名称层几何：图集 UV 矩形（u0,v0,u1,v1）单属性（每批次独享） */
export function createLabelTextGeometry(capacity: number): THREE.PlaneGeometry {
  return createLabelQuadGeometry([LABEL_TEXT_ATTRIBUTE_NAME], [4], [[0, 0, 0, 0]], capacity)
}

/**
 * 视空间 billboard 顶点着色（两层网格共用形态）：
 * 实例中心经 modelViewMatrix 变换后，把四边形角点按实例矩阵 x/y 轴长度在
 * 视空间展开——四边形恒平行于像平面（永远朝相机），文字绝不随轨道镜像；
 * 实例旋转分量被有意忽略，矩阵仅提供位置与尺寸。零缩放矩阵给出 sx=sy=0，
 * 全部顶点坍缩到中心点即不可见（隐藏口径与车体一致）。
 */
function billboardBody(extraAttributes: string, extraVaryings: string, extraAssign: string): string {
  return `
${extraAttributes}
varying vec2 vUv;
${extraVaryings}
void main() {
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
}
`
}

/** 名称层顶点：uv 从实例属性图集矩形插值 */
const LABEL_TEXT_VERTEX = billboardBody(
  'attribute vec4 aNameUv;',
  '',
  '  vUv = vec2(mix(aNameUv.x, aNameUv.z, uv.x), mix(aNameUv.y, aNameUv.w, uv.y));',
)

/** 背景层顶点：全部实例属性透传片元 */
const LABEL_BACKGROUND_VERTEX = billboardBody(
  `
attribute float aLevel;
attribute vec3 aStateColor;
attribute float aCharge;
attribute vec2 aOverlay;
attribute vec4 aChipUv;
`,
  `
varying float vLevel;
varying vec3 vStateColor;
varying float vCharge;
varying vec2 vOverlay;
varying vec4 vChipUv;
`,
  `
  vUv = uv;
  vLevel = aLevel;
  vStateColor = aStateColor;
  vCharge = aCharge;
  vOverlay = aOverlay;
  vChipUv = aChipUv;
`,
)

/** 名称层片元：采样名称图集，透明处丢弃 */
const LABEL_TEXT_FRAGMENT = `
uniform sampler2D uNameMap;
varying vec2 vUv;
void main() {
  vec4 texel = texture2D(uNameMap, vUv);
  if (texel.a < 0.02) discard;
  gl_FragColor = vec4(texel.rgb, texel.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/** 把 hex 颜色转为 shader vec3 字面量（线性工作空间，与场景色彩管线一致） */
function colorDefineVec3(hex: string): string {
  const color = new THREE.Color(hex)
  return `vec3(${color.r.toFixed(6)}, ${color.g.toFixed(6)}, ${color.b.toFixed(6)})`
}

/** 背景层片元：圆角底板 + 告警/选中边框 + 电量条 + 状态芯片（全部实例属性驱动） */
const LABEL_BACKGROUND_FRAGMENT = `
uniform sampler2D uBadgeMap;
varying vec2 vUv;
varying float vLevel;
varying vec3 vStateColor;
varying float vCharge;
varying vec2 vOverlay;
varying vec4 vChipUv;
void main() {
  vec2 p = vUv;
  // 圆角矩形 SDF：sdf>0 在底板外，直接丢弃
  float radius = 0.09;
  vec2 corner = abs(p - 0.5) - vec2(0.5 - radius);
  float sdf = length(max(corner, vec2(0.0))) + min(max(corner.x, corner.y), 0.0) - radius;
  if (sdf > 0.0) discard;

  // 底色：状态色加深，保证白色名称与芯片的可读对比
  vec3 color = vStateColor * 0.72;

  // 告警边框（最外圈）：L2 红 / L1 黄，与 SPEC §7.3 告警级一致
  float band = 0.055;
  if (vOverlay.y > 1.5) {
    if (sdf > -band) color = L2_BORDER_COLOR;
  } else if (vOverlay.y > 0.5) {
    if (sdf > -band) color = L1_BORDER_COLOR;
  }
  // 选中边框：告警边框内侧的白圈，可与告警边框同时存在
  if (vOverlay.x > 0.5 && sdf > -band * 2.0 && sdf <= -band) {
    color = SELECTED_BORDER_COLOR;
  }

  // 电量条：仅完整档位（vLevel>=2）且电量已知（vCharge>=0）；填充色按
  // 与告警同口径的阈值取色（<15% 红、[15%,30%) 黄、其余绿）
  if (vLevel > 1.5 && vCharge >= 0.0) {
    vec2 barMin = vec2(0.05, 0.10);
    vec2 barMax = vec2(0.60, 0.235);
    if (p.x > barMin.x && p.x < barMax.x && p.y > barMin.y && p.y < barMax.y) {
      float fill = clamp(vCharge, 0.0, 1.0);
      float fx = (p.x - barMin.x) / (barMax.x - barMin.x);
      if (fx > fill) {
        color = vec3(0.05, 0.06, 0.075);
      } else if (fill < BATTERY_CRITICAL_FILL) {
        color = BATTERY_CRITICAL_COLOR;
      } else if (fill < BATTERY_LOW_FILL) {
        color = BATTERY_LOW_COLOR;
      } else {
        color = BATTERY_OK_COLOR;
      }
    }
  }

  // 状态芯片：仅完整档位且芯片 UV 非退化（零矩形 = 无芯片/隐藏）
  if (vLevel > 1.5 && vChipUv.z > vChipUv.x) {
    vec2 chipMin = vec2(0.635, 0.30);
    vec2 chipMax = vec2(0.95, 0.70);
    if (p.x > chipMin.x && p.x < chipMax.x && p.y > chipMin.y && p.y < chipMax.y) {
      vec2 cuv = (p - chipMin) / (chipMax - chipMin);
      vec4 chip = texture2D(uBadgeMap, mix(vChipUv.xy, vChipUv.zw, cuv));
      color = mix(color, chip.rgb, chip.a);
    }
  }

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/** 名称层材质：引用批次名称图集；透明、不写深度（透明队列按 renderOrder 排序） */
export function createLabelTextMaterial(atlasTexture: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uNameMap: { value: atlasTexture } },
    vertexShader: LABEL_TEXT_VERTEX,
    fragmentShader: LABEL_TEXT_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}

/**
 * 背景层材质：引用共享状态芯片图集；颜色与电量阈值经 defines 注入，
 * 保证与 fleetAppearance / deriveVehicleState 单一事实源一致。
 */
export function createLabelBackgroundMaterial(badgeTexture: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uBadgeMap: { value: badgeTexture } },
    vertexShader: LABEL_BACKGROUND_VERTEX,
    fragmentShader: LABEL_BACKGROUND_FRAGMENT,
    defines: {
      SELECTED_BORDER_COLOR: colorDefineVec3(LABEL_BORDER_SELECTED_COLOR),
      L1_BORDER_COLOR: colorDefineVec3(LABEL_BORDER_L1_COLOR),
      L2_BORDER_COLOR: colorDefineVec3(LABEL_BORDER_L2_COLOR),
      BATTERY_OK_COLOR: colorDefineVec3(LABEL_BATTERY_OK_COLOR),
      BATTERY_LOW_COLOR: colorDefineVec3(LABEL_BATTERY_LOW_COLOR),
      BATTERY_CRITICAL_COLOR: colorDefineVec3(LABEL_BATTERY_CRITICAL_COLOR),
      BATTERY_CRITICAL_FILL: (LOW_BATTERY_THRESHOLD / 100).toFixed(4),
      BATTERY_LOW_FILL: (BATTERY_NORMAL_THRESHOLD / 100).toFixed(4),
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}
