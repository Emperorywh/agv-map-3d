/**
 * 使用项目已安装的 Three.js 加载最终模型，并输出交付检查报告。
 * 这是模型资产检查工具，不依赖浏览器、测试框架、外部纹理或解码器。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const source = new URL('../../public/models/agv_industrial.glb', import.meta.url)
const bytes = await readFile(source)
const jsonLength = bytes.readUInt32LE(12)
const gltfJson = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'))
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
const loaded = await new GLTFLoader().parseAsync(buffer, '')
loaded.scene.updateMatrixWorld(true)
const root = loaded.scene.getObjectByName('AGV_Industrial')
const bounds = new THREE.Box3().setFromObject(loaded.scene, true)
const dimensions = bounds.getSize(new THREE.Vector3())
const center = bounds.getCenter(new THREE.Vector3())
const checks = []

/**
 * 将每个检查结果明确写入报告，失败时停止交付。
 * 公差以米计量，允许浮点导出误差，但不允许尺寸或原点偏差。
 */
function requireResult(name, condition, detail) {
  checks.push({ name, passed: Boolean(condition), detail })
}

requireResult('GLB 2.0 文件头和长度', bytes.readUInt32LE(0) === 0x46546c67
  && bytes.readUInt32LE(4) === 2 && bytes.readUInt32LE(8) === bytes.length, bytes.length)
requireResult('长宽高为 1.8 × 0.7 × 0.35 米', Math.abs(dimensions.x - 1.8) < 1e-5
  && Math.abs(dimensions.z - 0.7) < 1e-5 && Math.abs(dimensions.y - 0.35) < 1e-5, dimensions.toArray())
requireResult('水平几何中心对齐原点', Math.abs(center.x) < 1e-5 && Math.abs(center.z) < 1e-5, center.toArray())
requireResult('根节点为单位变换', root && root.matrixWorld.equals(new THREE.Matrix4()), root?.matrixWorld.toArray())
requireResult('模型没有低于地面的几何', Math.abs(bounds.min.y) < 1e-5, bounds.min.y)
requireResult('不包含相机和光源', !(gltfJson.cameras?.length)
  && !gltfJson.extensions?.KHR_lights_punctual, gltfJson.extensionsUsed ?? [])
requireResult('无外部文件和纹理依赖', (gltfJson.buffers ?? []).every(item => !item.uri)
  && !(gltfJson.images?.length) && !(gltfJson.textures?.length), gltfJson.buffers)
requireResult('不需要附加解码器', !(gltfJson.extensionsRequired?.length), gltfJson.extensionsRequired ?? [])

/**
 * 检查真实加载后的部件位置和车轮最低点。
 * 多材质车轮会被加载为组，包围盒包含其全部子网格。
 */
const wheelNames = ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR']
const wheels = wheelNames.map(name => loaded.scene.getObjectByName(name))
for (let index = 0; index < wheels.length; index += 1) {
  const wheel = wheels[index]
  const wheelBounds = wheel ? new THREE.Box3().setFromObject(wheel, true) : null
  requireResult(`${wheelNames[index]} 轮胎落在 Y=0`, wheelBounds && Math.abs(wheelBounds.min.y) < 1e-5,
    wheelBounds ? { min: wheelBounds.min.toArray(), max: wheelBounds.max.toArray(), pivot: wheel.getWorldPosition(new THREE.Vector3()).toArray() } : null)
}
const wheelMeshIds = gltfJson.nodes.filter(node => wheelNames.includes(node.name)).map(node => node.mesh)
requireResult('四个车轮共享网格', wheelMeshIds.length === 4 && new Set(wheelMeshIds).size === 1, wheelMeshIds)
const frontSensor = loaded.scene.getObjectByName('Sensor_Lidar_Front')
const rearPanel = loaded.scene.getObjectByName('Interface_Panel_Rear')
requireResult('车头朝向 +X', frontSensor?.getWorldPosition(new THREE.Vector3()).x > 0.8
  && rearPanel?.getWorldPosition(new THREE.Vector3()).x < -0.8, {
    sensor: frontSensor?.getWorldPosition(new THREE.Vector3()).toArray(),
    rear: rearPanel?.getWorldPosition(new THREE.Vector3()).toArray(),
  })
const lights = []
const materials = new Set()
const geometries = new Set()
let triangles = 0
let vertices = 0
let meshCount = 0
let finite = true
loaded.scene.traverse(object => {
  if (!object.isMesh) return
  meshCount += 1
  const geometry = object.geometry
  const position = geometry.getAttribute('position')
  const normal = geometry.getAttribute('normal')
  vertices += position.count
  triangles += (geometry.index?.count ?? position.count) / 3
  geometries.add(geometry)
  for (const value of position.array) finite = finite && Number.isFinite(value)
  for (const value of normal?.array ?? []) finite = finite && Number.isFinite(value)
  for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material)
  if (object.name.startsWith('StatusLight_')) lights.push(object)
})
requireResult('顶点与法线均为有限数值', finite, { vertices, triangles })
requireResult('四条灯带独立且共享专用发光材质', lights.length === 4
  && new Set(lights.map(light => light.material)).size === 1
  && lights.every(light => light.material.name === 'Status_Emission' && light.material.emissive.g > 0.1), lights.map(light => light.name))
requireResult('主要部件可以通过名称查找', ['Body_Shell', 'Chassis', 'Top_Platform', 'Emergency_Stop', 'Bumper_Front', 'Bumper_Rear']
  .every(name => loaded.scene.getObjectByName(name)), gltfJson.nodes.map(node => node.name))

/**
 * 报告同时区分实例化后的整车三角形数和文件中共享的网格数量。
 * 绘制调用是普通网格的基础值；阴影通道以及场景的其他对象会额外增加调用。
 */
const report = {
  passed: checks.every(check => check.passed),
  source: fileURLToPath(source),
  sha256: createHash('sha256').update(bytes).digest('hex'),
  loader: `Three.js r${THREE.REVISION} GLTFLoader.parseAsync`,
  fileBytes: bytes.length,
  dimensions: { length: dimensions.x, width: dimensions.z, height: dimensions.y },
  bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
  trianglesPerVehicle: triangles,
  verticesPerVehicle: vertices,
  gltfMeshDefinitions: gltfJson.meshes.length,
  gltfNodes: gltfJson.nodes.length,
  threeMeshCount: meshCount,
  uniqueGeometryCount: geometries.size,
  materialCount: materials.size,
  materials: [...materials].map(mat => ({ name: mat.name, roughness: mat.roughness, metalness: mat.metalness, emissive: mat.emissive?.getHexString() })),
  baselineDrawCallsPerVehicle: meshCount,
  checks,
}
await writeFile(new URL('./three_validation.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ passed: report.passed, fileBytes: report.fileBytes, trianglesPerVehicle: triangles,
  materials: materials.size, baselineDrawCalls: meshCount, failed: checks.filter(check => !check.passed) }, null, 2))
if (!report.passed) throw new Error('GLB 资产检查失败，详见 three_validation.json')
