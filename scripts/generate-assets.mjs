/**
 * glTF 点缀资产生成脚本（SPEC §5.4）：生成 public/assets/ 下两个极简模型——
 *   charging-pile.gltf       充电桩造型
 *   roller-door-frame.gltf   卷帘门门框
 *
 * 资产统一约定：+Z 为正面、米制、原点在底部中心。
 * 尺寸与 src/config/constants.ts 的 CHARGING_PILE_* / ROLLER_DOOR_* 常量保持一致
 * （脚本为独立 .mjs，无法 import TS，修改常量后需同步重跑本脚本）。
 *
 * 输出为 JSON glTF（.gltf，buffer 内嵌 base64 data URI），手写装配不依赖导出器；
 * 生成后用 three 的 GLTFLoader 回读校验（包围盒 / 原点约定 / 图元数）。
 *
 * 用法：node scripts/generate-assets.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// GLTFLoader 在 Node 环境缺 ProgressEvent（浏览器全局），仅脚本内补齐
if (typeof globalThis.ProgressEvent === 'undefined') {
  globalThis.ProgressEvent = class ProgressEvent {
    constructor(type, init = {}) {
      this.type = type
      this.lengthComputable = init.lengthComputable ?? false
      this.loaded = init.loaded ?? 0
      this.total = init.total ?? 0
    }
  }
}
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
const { Box3, Vector3 } = await import('three')

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets')

// ---------------------------------------------------------------------------
// 盒体累积器：按材质分组收集盒体（24 顶点 / 36 索引，平直法线）
// ---------------------------------------------------------------------------

function createBuilder() {
  // materials: [{ name, baseColor:[r,g,b,a], emissive?:[r,g,b], roughness, metallic, positions:[], normals:[], indices:[], vertexBase }]
  const materials = new Map()

  function material(key, def) {
    if (!materials.has(key)) {
      materials.set(key, { ...def, positions: [], normals: [], indices: [] })
    }
    return materials.get(key)
  }

  /** 追加一个轴对齐盒体：[minX,minY,minZ] → [maxX,maxY,maxZ] */
  function box(materialKey, materialDef, min, max) {
    const m = material(materialKey, materialDef)
    const [x0, y0, z0] = min
    const [x1, y1, z1] = max
    // 6 面 × 4 顶点，法线逐面平直；绕序保证外法线（CCW）
    const faces = [
      // +Z 正面
      { n: [0, 0, 1], v: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
      // -Z
      { n: [0, 0, -1], v: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]] },
      // +X
      { n: [1, 0, 0], v: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]] },
      // -X
      { n: [-1, 0, 0], v: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] },
      // +Y 顶面
      { n: [0, 1, 0], v: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]] },
      // -Y 底面
      { n: [0, -1, 0], v: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] },
    ]
    for (const face of faces) {
      for (const v of face.v) {
        m.positions.push(...v)
        m.normals.push(...face.n)
      }
      // 每面 4 顶点 2 三角形
      const faceBase = m.positions.length / 3 - 4
      m.indices.push(faceBase, faceBase + 1, faceBase + 2, faceBase, faceBase + 2, faceBase + 3)
    }
  }

  /** 装配 glTF JSON（buffer 内嵌 data URI），单 mesh 多 primitive（每材质一个） */
  function toGltf(name) {
    const accessors = []
    const bufferViews = []
    const meshPrimitives = []
    const materialDefs = []
    let byteOffset = 0
    const binParts = []

    const pushBufferView = (typedArray, target) => {
      const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength)
      // 4 字节对齐
      const pad = (4 - (byteOffset % 4)) % 4
      if (pad > 0) {
        binParts.push(new Uint8Array(pad))
        byteOffset += pad
      }
      bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.byteLength, target })
      binParts.push(bytes)
      byteOffset += bytes.byteLength
      return bufferViews.length - 1
    }

    for (const m of materials.values()) {
      const positions = new Float32Array(m.positions)
      const normals = new Float32Array(m.normals)
      const indices = new Uint16Array(m.indices)
      const posView = pushBufferView(positions, 34962)
      const norView = pushBufferView(normals, 34962)
      const idxView = pushBufferView(indices, 34963)
      // POSITION accessor 必须携带 min/max
      const min = [Infinity, Infinity, Infinity]
      const max = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < positions.length; i += 3) {
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], positions[i + axis])
          max[axis] = Math.max(max[axis], positions[i + axis])
        }
      }
      accessors.push(
        { bufferView: posView, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max },
        { bufferView: norView, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
        { bufferView: idxView, componentType: 5123, count: indices.length, type: 'SCALAR' },
      )
      const base = accessors.length - 3
      meshPrimitives.push({
        attributes: { POSITION: base, NORMAL: base + 1 },
        indices: base + 2,
        material: materialDefs.length,
      })
      const def = {
        name: m.name,
        pbrMetallicRoughness: {
          baseColorFactor: m.baseColor,
          metallicFactor: m.metallic ?? 0,
          roughnessFactor: m.roughness ?? 0.85,
        },
      }
      if (m.emissive !== undefined) {
        def.emissiveFactor = m.emissive
      }
      materialDefs.push(def)
    }

    const binLength = byteOffset
    const bin = new Uint8Array(binLength)
    {
      let cursor = 0
      for (const part of binParts) {
        bin.set(part, cursor)
        cursor += part.byteLength
      }
    }

    return {
      asset: { version: '2.0', generator: 'agv-map-3d/scripts/generate-assets.mjs' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name }],
      meshes: [{ name, primitives: meshPrimitives }],
      materials: materialDefs,
      accessors,
      bufferViews,
      buffers: [
        {
          byteLength: binLength,
          uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}`,
        },
      ],
    }
  }

  return { box, toGltf }
}

// ---------------------------------------------------------------------------
// 模型定义（+Z 正面、米制、原点底部中心；尺寸对齐 config/constants.ts）
// ---------------------------------------------------------------------------

const PILE_BODY = { name: 'pile-body', baseColor: [0.72, 0.74, 0.76, 1], roughness: 0.8 }
const PILE_SCREEN = {
  name: 'pile-screen',
  baseColor: [0.1, 0.14, 0.18, 1],
  emissive: [0.05, 0.1, 0.14],
  roughness: 0.4,
}
const PILE_ACCENT = {
  name: 'pile-accent',
  baseColor: [0.2, 0.78, 0.88, 1],
  emissive: [0.2, 0.6, 0.7],
  roughness: 0.5,
}
const FRAME_MATERIAL = { name: 'door-frame', baseColor: [0.79, 0.8, 0.83, 1], roughness: 0.75 }

/** 充电桩：底座 + 立柱机身 + 正面屏幕 / 充电指示条（总高 1.33m） */
function buildChargingPile() {
  const b = createBuilder()
  b.box('body', PILE_BODY, [-0.28, 0, -0.22], [0.28, 0.08, 0.22]) // 底座
  b.box('body', PILE_BODY, [-0.22, 0.08, -0.15], [0.22, 1.33, 0.15]) // 机身 0.44×1.25×0.3
  b.box('screen', PILE_SCREEN, [-0.15, 0.88, 0.15], [0.15, 1.24, 0.17]) // 正面屏幕（+Z）
  b.box('accent', PILE_ACCENT, [-0.16, 0.72, 0.15], [0.16, 0.78, 0.165]) // 指示条
  return b.toGltf('charging-pile')
}

/** 卷帘门门框：左右立柱 + 顶部横梁（门洞净宽 3.0m / 净高 3.0m） */
function buildRollerDoorFrame() {
  const b = createBuilder()
  b.box('frame', FRAME_MATERIAL, [-1.7, 0, -0.15], [-1.5, 3.3, 0.15]) // 左柱 0.2 宽
  b.box('frame', FRAME_MATERIAL, [1.5, 0, -0.15], [1.7, 3.3, 0.15]) // 右柱
  b.box('frame', FRAME_MATERIAL, [-1.7, 3.0, -0.15], [1.7, 3.3, 0.15]) // 横梁 0.3 高
  return b.toGltf('roller-door-frame')
}

// ---------------------------------------------------------------------------
// 写出 + GLTFLoader 回读校验
// ---------------------------------------------------------------------------

async function validate(name, gltf, expected) {
  const text = JSON.stringify(gltf)
  const result = await new Promise((resolve, reject) => {
    new GLTFLoader().parse(text, '', resolve, reject)
  })
  const bbox = new Box3().setFromObject(result.scene)
  const center = bbox.getCenter(new Vector3())
  const size = bbox.getSize(new Vector3())
  const problems = []
  if (Math.abs(bbox.min.y) > 1e-4) problems.push(`原点不在底部：min.y=${bbox.min.y}`)
  if (Math.abs(center.x) > 1e-4 || Math.abs(center.z) > 1e-4) {
    problems.push(`原点不在水平中心：center=(${center.x},${center.z})`)
  }
  if (Math.abs(size.y - expected.height) > 1e-3) {
    problems.push(`高度不符：${size.y} ≠ ${expected.height}`)
  }
  let meshCount = 0
  result.scene.traverse((object) => {
    if (object.isMesh) meshCount++
  })
  if (meshCount !== expected.meshes) {
    problems.push(`图元数不符：${meshCount} ≠ ${expected.meshes}`)
  }
  if (problems.length > 0) {
    throw new Error(`${name} 校验失败：\n  ${problems.join('\n  ')}`)
  }
  console.log(
    `  ${name}: meshes=${meshCount} size=${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)}m ` +
      `bytes=${text.length}`,
  )
  return text
}

mkdirSync(ASSETS_DIR, { recursive: true })
const outputs = [
  ['charging-pile.gltf', buildChargingPile(), { height: 1.33, meshes: 3 }],
  ['roller-door-frame.gltf', buildRollerDoorFrame(), { height: 3.3, meshes: 1 }],
]
for (const [fileName, gltf, expected] of outputs) {
  const text = await validate(fileName, gltf, expected)
  writeFileSync(join(ASSETS_DIR, fileName), text)
  console.log(`  已写出 public/assets/${fileName}`)
}
console.log('glTF 点缀资产生成完成（+Z 正面、米制、原点底部中心，GLTFLoader 回读通过）')
