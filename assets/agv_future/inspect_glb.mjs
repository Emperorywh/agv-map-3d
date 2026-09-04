/**
 * 使用项目现有 Three.js 加载器直接解析交付资产并记录检查结果。
 * 本文件是模型导出检查工具，不引入单元测试、浏览器依赖或解码器。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const source = new URL('../../public/models/AGV_FUTURE.glb', import.meta.url)
const data = await readFile(source)
const document = JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString('utf8'))
const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
const gltf = await new GLTFLoader().parseAsync(arrayBuffer, '')
gltf.scene.updateMatrixWorld(true)
const checks = []

/**
 * 记录实际加载结果，便于交付后核对是否使用同一版本模型。
 * 检查范围限于资产的坐标、网格、材质和可控节点。
 */
function record(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), detail })
}

const root = gltf.scene.getObjectByName('AGV_ROOT')
const bounds = new THREE.Box3().setFromObject(gltf.scene, true)
const dimensions = bounds.getSize(new THREE.Vector3())
let triangles = 0
let meshObjects = 0
let normalsValid = true
let finite = true
const materials = new Set()
gltf.scene.traverse(object => {
  if (!object.isMesh) return
  meshObjects += 1
  const geometry = object.geometry
  triangles += (geometry.index?.count ?? geometry.attributes.position.count) / 3
  for (const value of geometry.attributes.position.array) finite &&= Number.isFinite(value)
  const normal = geometry.attributes.normal
  normalsValid &&= Boolean(normal)
  if (normal) {
    for (let i = 0; i < normal.count; i += 1) {
      const length = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i))
      normalsValid &&= Number.isFinite(length) && Math.abs(length - 1) < 0.001
    }
  }
  for (const mat of Array.isArray(object.material) ? object.material : [object.material]) materials.add(mat)
})
record('GLB 2.0 文件头及字节长度', data.readUInt32LE(0) === 0x46546c67
  && data.readUInt32LE(4) === 2 && data.readUInt32LE(8) === data.length, data.length)
record('原点及根节点单位变换', root?.matrixWorld.equals(new THREE.Matrix4()), root?.matrixWorld.toArray())
record('地面为 Y=0', Math.abs(bounds.min.y) < 1e-6, bounds.min.toArray())
record('面数为两万至六万', triangles >= 20000 && triangles <= 60000, triangles)
record('顶点及单位法线有效', finite && normalsValid, { finite, normalsValid })
record('所有节点缩放均为一', document.nodes.every(node => !node.scale || node.scale.every(s => Math.abs(s - 1) < 1e-6)), document.nodes.length)
record('不含相机、灯光、动画及外部依赖', !document.cameras?.length && !document.animations?.length
  && !document.extensions?.KHR_lights_punctual && !document.images?.length
  && document.buffers.every(buffer => !buffer.uri), document.extensionsUsed ?? [])
record('无需专用解码器', !(document.extensionsRequired?.length), document.extensionsRequired ?? [])

/**
 * 四轮的本地横轴穿过真实轮心，前后轮分别独立控制并共享几何数据。
 * 采用导出后的正 Z 判定前方，同时核对轮子着地点。
 */
for (const name of ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR']) {
  const wheel = gltf.scene.getObjectByName(name)
  const pivot = wheel?.getWorldPosition(new THREE.Vector3())
  const wheelBounds = wheel ? new THREE.Box3().setFromObject(wheel, true) : null
  record(`${name} 独立轮轴和着地点`, wheel && Math.abs(pivot.y - 0.147) < 1e-6
    && Math.abs(wheelBounds.min.y) < 1e-6 && Math.abs(Math.abs(pivot.z) - 0.766) < 1e-6,
  { pivot: pivot?.toArray(), boundsMin: wheelBounds?.min.toArray() })
}
const front = gltf.scene.getObjectByName('Sensor_Camera_Front')
const rear = gltf.scene.getObjectByName('Sensor_Camera_Rear')
record('Three.js 中正 Z 为车头', front?.getWorldPosition(new THREE.Vector3()).z > 1.2
  && rear?.getWorldPosition(new THREE.Vector3()).z < -1.2,
{ front: front?.getWorldPosition(new THREE.Vector3()).toArray(), rear: rear?.getWorldPosition(new THREE.Vector3()).toArray() })

/**
 * 状态灯必须是独立 Mesh，并且仅通过 PBR 自发光参数产生亮度。
 * 雷达状态灯作为雷达子节点，旋转时保持机械连接关系。
 */
const lights = [
  ['Light_Front_Main', 'Cyan_Emissive'],
  ['Light_Front_Wrap_L', 'Cyan_Emissive'],
  ['Light_Front_Wrap_R', 'Cyan_Emissive'],
  ['Light_Front_Lower', 'Cyan_Emissive'],
  ['Light_Side_L', 'Cyan_Emissive'],
  ['Light_Side_R', 'Cyan_Emissive'],
  ['Light_Rear_Wrap_L', 'Red_Emissive'],
  ['Light_Rear_Wrap_R', 'Red_Emissive'],
  ['Light_LiDAR_Ring', 'LiDAR_Blue_Emissive'],
  ['Light_LiDAR_Front', 'LiDAR_Blue_Emissive'],
  ['Light_Rear_Localization', 'LiDAR_Blue_Emissive'],
]
for (const [name, expected] of lights) {
  const light = gltf.scene.getObjectByName(name)
  record(`${name} 独立发光 Mesh`, light?.isMesh && light.material.name === expected
    && light.material.emissiveIntensity === 4 && light.material.emissive.toArray().some(v => v > 0),
  { material: light?.material?.name, intensity: light?.material?.emissiveIntensity })
}
record('LiDAR 独立且灯环随动', gltf.scene.getObjectByName('LiDAR_Top')
  && gltf.scene.getObjectByName('Light_LiDAR_Ring')?.parent.name === 'LiDAR_Top',
gltf.scene.getObjectByName('Light_LiDAR_Ring')?.parent.name)
record('仅使用标准 PBR 材质', [...materials].every(mat => mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial), materials.size)

const report = {
  passed: checks.every(check => check.passed),
  loader: `Three.js r${THREE.REVISION} GLTFLoader`,
  sha256: createHash('sha256').update(data).digest('hex'),
  bytes: data.length,
  triangles,
  materials: materials.size,
  gltfNodesIncludingRoot: document.nodes.length,
  gltfMeshNodes: document.nodes.filter(node => node.mesh !== undefined).length,
  threeMeshObjects: meshObjects,
  baseDrawCalls: meshObjects,
  dimensionsMeters: { length: dimensions.z, width: dimensions.x, height: dimensions.y },
  forwardAxis: '+Z',
  upAxis: '+Y',
  extensionsUsed: document.extensionsUsed ?? [],
  materialsDetails: [...materials].map(mat => ({ name: mat.name, metallic: mat.metalness,
    roughness: mat.roughness, emissive: mat.emissive.toArray(), emissiveIntensity: mat.emissiveIntensity })),
  checks,
}
await writeFile(new URL('./three_validation.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ ...report, checks: checks.filter(check => !check.passed), materialsDetails: undefined }, null, 2))
if (!report.passed) throw new Error('GLB 资产检查失败，请查看 three_validation.json')
