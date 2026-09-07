/**
 * 发布产物完整性校验（SPEC §10.2 / E5；TASK-002）。
 *
 * 职责：校验 dist 包含可运行应用、公开配置模板与地图资源，且资源引用为
 *       相对路径（同一产物支持根路径与子路径部署）。
 * 边界：只做产物级静态检查，不启动服务器（冒烟见 scripts/smokeDist.mjs）、
 *       不解析地图业务字段。
 * 关键不变量：
 * 1. dist/index.html、dist/config.json、dist/json/map.json 缺一即失败；
 * 2. index.html 的脚本与样式引用不得以 / 开头（绝对根路径引用会破坏子路径部署）；
 * 3. config.json 顶层字段必须落在运行时配置白名单内且不含疑似凭据字段。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')

const failures = []
function check(condition, message) {
  if (condition) {
    console.log(`[verify-dist] 通过：${message}`)
  } else {
    failures.push(message)
    console.error(`[verify-dist] 失败：${message}`)
  }
}

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

// 1. 应用入口
const indexPath = path.join(DIST, 'index.html')
check(await exists(indexPath), 'dist/index.html 存在')
let indexHtml = ''
if (await exists(indexPath)) {
  indexHtml = await readFile(indexPath, 'utf8')
  check(indexHtml.includes('id="root"'), 'index.html 含 #root 挂载点')
  check(/<script[^>]+src=/.test(indexHtml), 'index.html 引用了打包脚本')
}

// 2. 资源引用必须是相对路径（子路径部署前提，SPEC E5）
const absoluteRefs = indexHtml.match(/(?:src|href)="\/[^/"]*"/g) ?? []
check(
  absoluteRefs.length === 0,
  absoluteRefs.length === 0
    ? 'index.html 资源引用全部为相对路径'
    : `index.html 存在绝对根路径引用：${absoluteRefs.join(', ')}`,
)

// 3. 运行时配置模板
const configPath = path.join(DIST, 'config.json')
check(await exists(configPath), 'dist/config.json 存在')
if (await exists(configPath)) {
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    // 白名单必须与 src/app/bootstrap/loadRuntimeConfig.ts 保持一致
    const allowedKeys = new Set([
      'dataSource',
      'mapUrl',
      'wsUrl',
      'maxVehicles',
      'staleAfterMs',
      'renderer',
      'coordinateTransform',
    ])
    const unknownKeys = Object.keys(config).filter((key) => !allowedKeys.has(key))
    check(unknownKeys.length === 0, `config.json 顶层字段在白名单内（未知字段：${unknownKeys.join(', ') || '无'}）`)
    check(
      config.dataSource === 'mock' || config.dataSource === 'ws',
      `config.json dataSource 合法（当前：${String(config.dataSource)}）`,
    )
    const credentialPattern = /(token|secret|password|apikey|api_key|credential)/i
    check(!credentialPattern.test(JSON.stringify(config)), 'config.json 不含疑似凭据字段')
  } catch (error) {
    check(false, `config.json 可解析（错误：${error.message}）`)
  }
}

// 静态车辆快照是断连展示所需的运行资源，发布时校验存在性与数组结构。
// 避免生产包遗漏该文件，直到 WebSocket 不可用时才暴露问题。
const vehicleListPath = path.join(DIST, 'json', 'vehicleList.json')
check(await exists(vehicleListPath), 'dist/json/vehicleList.json 存在')
if (await exists(vehicleListPath)) {
  try {
    const vehicles = JSON.parse(await readFile(vehicleListPath, 'utf8'))
    check(Array.isArray(vehicles) && vehicles.length > 0, 'vehicleList.json 是非空车辆数组')
  } catch (error) {
    check(false, `vehicleList.json 可解析（错误：${error.message}）`)
  }
}

// 4. 地图资源
const mapPath = path.join(DIST, 'json', 'map.json')
check(await exists(mapPath), 'dist/json/map.json 存在')
if (await exists(mapPath)) {
  const { size } = await stat(mapPath)
  check(size > 0, `map.json 非空（${size} 字节）`)
  try {
    const map = JSON.parse(await readFile(mapPath, 'utf8'))
    check(map !== null && typeof map === 'object', 'map.json 是合法 JSON 对象')
  } catch (error) {
    check(false, `map.json 可解析（错误：${error.message}）`)
  }
}

/**
 * 车辆派生资产属于发布必需资源，构建时用生产同版加载器核对交付内容。
 * 同时核对材质分区、有限顶点、米制包围盒及减面数量，防止导出错误静默进入运行时。
 */
let sourceMaterials = null
let sourceBounds = null
let sourceTriangles = 0
for (const name of ['AGV_FUTURE.glb', 'AGV_FUTURE_LOD1.glb', 'AGV_FUTURE_LOD2.glb']) {
  try {
    const buffer = await readFile(path.join(DIST, 'models', name))
    const model = await new GLTFLoader().parseAsync(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '')
    const materials = new Set()
    const geometries = new Set()
    let triangles = 0
    let finite = true
    model.scene.updateMatrixWorld(true)
    model.scene.traverse((object) => {
      if (!object.isMesh) return
      geometries.add(object.geometry)
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material)
      const position = object.geometry.getAttribute('position')
      triangles += (object.geometry.index?.count ?? position.count) / 3
      for (const attribute of Object.values(object.geometry.attributes)) {
        for (const value of attribute.array) if (!Number.isFinite(value)) finite = false
      }
    })
    const bounds = new THREE.Box3().setFromObject(model.scene)
    const names = [...materials].map((material) => material.name).filter((value, index, all) => all.indexOf(value) === index).sort().join('|')
    if (sourceBounds === null) {
      sourceBounds = bounds
      sourceMaterials = names
      sourceTriangles = triangles
    }
    check(finite && triangles > 0, `${name} 顶点属性有效，共 ${triangles} 三角形`)
    check(names === sourceMaterials, `${name} 保留完整材质分区`)
    check(bounds.min.distanceTo(sourceBounds.min) < 0.03 && bounds.max.distanceTo(sourceBounds.max) < 0.03, `${name} 定位和包围盒与原资产一致（容差 3cm）`)
    if (name.includes('LOD')) check(triangles < sourceTriangles * 0.35, `${name} 三角形少于原资产的 35%`)
    for (const geometry of geometries) geometry.dispose()
    for (const material of materials) material.dispose()
  } catch (error) {
    check(false, `${name} 可用（${error.message}）`)
  }
}

/**
 * 设施三档通过 Vite 静态导入发布，核对带哈希的实际产物和运行时材质分组合同。
 * 构建环境只解析纹理元数据，图像字节范围另行检查，不把占位纹理当成像素解码验证。
 */
const assetFiles = await readdir(path.join(DIST, 'assets'))
for (const stem of ['agv_charge_tower', 'shelf_empty', 'shelf_loaded']) {
  let original = null
  for (const suffix of ['', '_LOD1', '_LOD2']) {
    const name = `${stem}${suffix}`
    const geometries = new Set()
    const materials = new Set()
    const textures = new Set()
    try {
      const file = assetFiles.find((entry) => entry.startsWith(`${name}-`) && entry.endsWith('.glb'))
      if (file === undefined) throw new Error('构建产物缺少模型文件')
      const buffer = await readFile(path.join(DIST, 'assets', file))
      const document = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString('utf8'))
      const binSize = buffer.readUInt32LE(20 + buffer.readUInt32LE(12))
      check((document.images ?? []).every((image) => {
        const view = document.bufferViews?.[image.bufferView]
        return view && view.byteLength > 0 && (view.byteOffset ?? 0) + view.byteLength <= binSize
      }), `${name} 内嵌贴图字节范围有效`)
      const loader = new GLTFLoader().register(() => ({
        name: 'BUILD_TEXTURE_METADATA',
        loadTexture() { const texture = new THREE.Texture(); textures.add(texture); return Promise.resolve(texture) },
      }))
      const model = await loader.parseAsync(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '')
      let triangles = 0
      let finite = true
      const layouts = new Set()
      model.scene.updateMatrixWorld(true)
      model.scene.traverse((object) => {
        if (!object.isMesh) return
        const geometry = object.geometry
        geometries.add(geometry)
        const attributes = Object.entries(geometry.attributes).sort(([a], [b]) => a.localeCompare(b))
          .map(([name, attribute]) => `${name}:${attribute.itemSize}:${attribute.normalized}`).join('|')
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          materials.add(material)
          layouts.add(`${material.name}:${geometry.index !== null}:${attributes}`)
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value)
        }
        triangles += (geometry.index?.count ?? geometry.getAttribute('position').count) / 3
        for (const attribute of Object.values(geometry.attributes)) for (const value of attribute.array) if (!Number.isFinite(value)) finite = false
      })
      const bounds = new THREE.Box3().setFromObject(model.scene)
      const materialNames = [...new Set([...materials].map((material) => material.name))].sort().join('|')
      if (original === null) original = { bounds, triangles, layouts, materialNames }
      check(finite && triangles > 0, `${name} 顶点属性有效，共 ${triangles} 三角形`)
      check(materialNames === original.materialNames, `${name} 保留完整材质分区`)
      check([...original.layouts].every((layout) => layouts.has(layout)), `${name} 顶点布局兼容运行时合批`)
      check(bounds.min.distanceTo(original.bounds.min) < 0.03 && bounds.max.distanceTo(original.bounds.max) < 0.03, `${name} 包围盒与原模型一致（容差 3cm）`)
      if (suffix !== '') check(triangles < original.triangles * 0.35, `${name} 三角形少于原资产的 35%`)
    } catch (error) {
      check(false, `${name} 可用（${error.message}）`)
    } finally {
      for (const geometry of geometries) geometry.dispose()
      for (const material of materials) material.dispose()
      for (const texture of textures) texture.dispose()
    }
  }
}

if (failures.length > 0) {
  console.error(`[verify-dist] 共 ${failures.length} 项检查失败`)
  process.exit(1)
}
console.log('[verify-dist] 发布产物完整性校验全部通过')
