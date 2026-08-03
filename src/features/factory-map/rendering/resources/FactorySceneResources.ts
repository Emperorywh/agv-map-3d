/**
 * FactorySceneResources：厂房环境资源唯一 owner（SPEC §10.3、§6）。
 *
 * 资源分两级管理：
 * - 共享级：程序地坪纹理（CanvasTexture）与 7 个 MeshStandardMaterial——首次 setup
 *   惰性创建，dispose（FactoryCanvas 卸载）时释放；
 * - bounds 级：8 份 BufferGeometry（地坪/分缝/实墙/玻璃/墙柱/主梁/檩条/室外地坪）
 *   与 3 份实例矩阵 InstancedBufferAttribute——bounds 变化时先释放旧 geometry 再重建；
 *   bounds 未变时 setup 幂等返回同一快照（React StrictMode 重复挂载/重复调用不产生
 *   重复 WebGL 资源）；dispose 幂等。
 *
 * 快照直接持有 8 个 Mesh/InstancedMesh（材质共享、几何独占），scene 子层以
 * <primitive> 挂载、不得释放借用的 material/geometry；labelOccluders 暴露不透明
 * 遮挡 mesh 引用集合（实墙/墙柱/主梁/檩条，不含玻璃——玻璃不遮挡），供 §9.3
 * 标签遮挡检测的内部 Raycaster 使用（TASK-012 消费）。
 *
 * 几何/纹理像素构建全部委托 rendering/scene 子目录的纯函数模块；
 * 本模块只做资源装配与生命周期，不含几何算法。
 */

import {
  CanvasTexture,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three'

import type { FactoryBoundsDto } from '../../application/factorySceneModel'
import { ENV_MAP_INTENSITY, GLASS_ENV_MAP_INTENSITY } from '../../config/qualityProfile'
import { FLOOR_TEXTURE_SEED } from '../../config/sceneMetrics'
import {
  FLOOR_JOINT_COLOR,
  OUTDOOR_GROUND_COLOR,
  TRUSS_STEEL_COLOR,
  WALL_COLUMN_COLOR,
  WALL_PANEL_COLOR,
  WINDOW_GLASS_COLOR,
} from '../../config/visualTheme'
import { buildWallColumnInstances, buildWallGeometries } from '../scene/building/buildingGeometry'
import type { InstanceGeometryBatch } from '../scene/building/buildingGeometry'
import { buildRoofBeamInstances, buildRoofPurlinInstances } from '../scene/building/roofFrameGeometry'
import { buildOutdoorGroundGeometry } from '../scene/exterior/exteriorGeometry'
import { buildFloorGeometry, buildFloorJointGeometry } from '../scene/floor/floorGeometry'
import {
  FLOOR_TEXTURE_ANISOTROPY_CAP,
  FLOOR_TEXTURE_SIZE,
  generateFloorTexturePixels,
} from '../scene/floor/floorTexture'

// ---------------------------------------------------------------------------
// §6.2/§6.5/§4.3 固定材质参数与 v1 观感取值（SPEC 未固定的粗糙度/金属度）
// ---------------------------------------------------------------------------

/** 地坪 roughness（§6.2：0.95） */
const FLOOR_ROUGHNESS = 0.95
/** 室外地坪 roughness（§6.5：1） */
const OUTDOOR_GROUND_ROUGHNESS = 1
/** 分缝层 polygonOffsetUnits（§4.3：-1；统一写法 factor -1） */
const FLOOR_JOINT_POLYGON_OFFSET_UNITS = -1
/** 玻璃 renderOrder（§6.3：10，晚于不透明物体渲染） */
const GLASS_RENDER_ORDER = 10
/** 玻璃 opacity（§6.3：0.35） */
const GLASS_OPACITY = 0.35
/** v1 观感取值（SPEC 未固定）：墙板/墙柱/分缝哑光 */
const MATTE_ROUGHNESS = 0.9
/** v1 观感取值（SPEC 未固定）：玻璃低粗糙度产生窗面反射 */
const GLASS_ROUGHNESS = 0.12
/** v1 观感取值（SPEC 未固定）：桁架钢半金属 */
const TRUSS_STEEL_ROUGHNESS = 0.6
const TRUSS_STEEL_METALNESS = 0.2

// ---------------------------------------------------------------------------
// 公开契约
// ---------------------------------------------------------------------------

/** 创建 Canvas 的工厂（默认 document.createElement；测试注入桩件以脱离 DOM） */
export type CreateCanvas = (width: number, height: number) => HTMLCanvasElement

export interface FactorySceneResourcesOptions {
  readonly createCanvas?: CreateCanvas
}

/** 厂房环境快照：8 个 mesh（§6.7 主 pass 9 批次中的 8 个；第 9 个为 drei Sky） */
export interface FactorySceneSnapshot {
  readonly bounds: FactoryBoundsDto
  readonly floorMesh: Mesh
  readonly floorJointMesh: Mesh
  readonly solidWallMesh: Mesh
  readonly glassWallMesh: Mesh
  readonly wallColumnMesh: InstancedMesh
  readonly roofBeamMesh: InstancedMesh
  readonly roofPurlinMesh: InstancedMesh
  readonly outdoorGroundMesh: Mesh
  /** §9.3 标签遮挡检测专用：不透明遮挡 mesh（实墙/墙柱/主梁/檩条；玻璃不遮挡） */
  readonly labelOccluders: readonly Mesh[]
}

export interface FactorySceneResources {
  /**
   * 按 bounds 建立/更新快照：bounds 未变幂等返回同一快照；bounds 变化先释放旧
   * geometry 再重建（共享纹理/material 保留）；maxAnisotropy 变化时只更新纹理各向异性。
   */
  setup(bounds: FactoryBoundsDto, maxAnisotropy: number): FactorySceneSnapshot
  /** 卸载：释放全部 geometry 与共享纹理/material；幂等；之后可重新 setup */
  dispose(): void
  /** 当前快照（未 setup 或已 dispose 时为 null） */
  readonly current: FactorySceneSnapshot | null
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

interface Disposable {
  dispose(): void
}

/** 共享级资源：程序地坪纹理 + 全部材质（唯一 owner，dispose 时释放） */
interface SharedFactoryAssets {
  readonly floorTexture: CanvasTexture
  readonly floorMaterial: MeshStandardMaterial
  readonly floorJointMaterial: MeshStandardMaterial
  readonly wallPanelMaterial: MeshStandardMaterial
  readonly glassMaterial: MeshStandardMaterial
  readonly wallColumnMaterial: MeshStandardMaterial
  readonly trussSteelMaterial: MeshStandardMaterial
  readonly outdoorGroundMaterial: MeshStandardMaterial
  readonly disposables: readonly Disposable[]
}

const defaultCreateCanvas: CreateCanvas = (width, height) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function targetAnisotropy(maxAnisotropy: number): number {
  // §6.2：anisotropy = min(8, renderer.capabilities.getMaxAnisotropy())
  return Math.min(FLOOR_TEXTURE_ANISOTROPY_CAP, maxAnisotropy)
}

/** 创建共享级资源：确定性程序纹理（§6.2）+ 7 个材质（颜色全部来自 visualTheme） */
function createSharedAssets(createCanvas: CreateCanvas, maxAnisotropy: number): SharedFactoryAssets {
  const pixels = generateFloorTexturePixels(FLOOR_TEXTURE_SEED, FLOOR_TEXTURE_SIZE)
  const canvas = createCanvas(FLOOR_TEXTURE_SIZE, FLOOR_TEXTURE_SIZE)
  const context = canvas.getContext('2d')
  if (context === null) {
    throw new Error('厂房地坪纹理：无法创建 Canvas 2D 上下文')
  }
  const imageData = context.createImageData(FLOOR_TEXTURE_SIZE, FLOOR_TEXTURE_SIZE)
  imageData.data.set(pixels)
  context.putImageData(imageData, 0, 0)

  const floorTexture = new CanvasTexture(canvas)
  floorTexture.colorSpace = SRGBColorSpace
  floorTexture.wrapS = RepeatWrapping
  floorTexture.wrapT = RepeatWrapping
  floorTexture.anisotropy = targetAnisotropy(maxAnisotropy)

  // 地坪材质 color 保持默认白：混凝土基色 #A9A6A0 与噪声已由 map 像素承载，
  // color×map 相乘，白色即恒等（§6.2 的中灰混凝土观感来自贴图本身）
  const floorMaterial = new MeshStandardMaterial({
    map: floorTexture,
    roughness: FLOOR_ROUGHNESS,
    envMapIntensity: ENV_MAP_INTENSITY,
  })
  const floorJointMaterial = new MeshStandardMaterial({
    color: FLOOR_JOINT_COLOR,
    roughness: FLOOR_ROUGHNESS,
    envMapIntensity: ENV_MAP_INTENSITY,
    // §4.3 双保险第二道：分缝 polygonOffset factor -1 / units -1
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: FLOOR_JOINT_POLYGON_OFFSET_UNITS,
  })
  const wallPanelMaterial = new MeshStandardMaterial({
    color: WALL_PANEL_COLOR,
    roughness: MATTE_ROUGHNESS,
    envMapIntensity: ENV_MAP_INTENSITY,
  })
  // §6.3 玻璃五参数：transparent / opacity 0.35 / depthWrite=false / DoubleSide /
  // renderOrder=10（renderOrder 是 Object3D 属性，在 mesh 上设置）
  const glassMaterial = new MeshStandardMaterial({
    color: WINDOW_GLASS_COLOR,
    transparent: true,
    opacity: GLASS_OPACITY,
    depthWrite: false,
    side: DoubleSide,
    roughness: GLASS_ROUGHNESS,
    envMapIntensity: GLASS_ENV_MAP_INTENSITY,
  })
  const wallColumnMaterial = new MeshStandardMaterial({
    color: WALL_COLUMN_COLOR,
    roughness: MATTE_ROUGHNESS,
    envMapIntensity: ENV_MAP_INTENSITY,
  })
  const trussSteelMaterial = new MeshStandardMaterial({
    color: TRUSS_STEEL_COLOR,
    roughness: TRUSS_STEEL_ROUGHNESS,
    metalness: TRUSS_STEEL_METALNESS,
    envMapIntensity: ENV_MAP_INTENSITY,
  })
  const outdoorGroundMaterial = new MeshStandardMaterial({
    color: OUTDOOR_GROUND_COLOR,
    roughness: OUTDOOR_GROUND_ROUGHNESS,
    envMapIntensity: ENV_MAP_INTENSITY,
  })

  return {
    floorTexture,
    floorMaterial,
    floorJointMaterial,
    wallPanelMaterial,
    glassMaterial,
    wallColumnMaterial,
    trussSteelMaterial,
    outdoorGroundMaterial,
    disposables: [
      floorTexture,
      floorMaterial,
      floorJointMaterial,
      wallPanelMaterial,
      glassMaterial,
      wallColumnMaterial,
      trussSteelMaterial,
      outdoorGroundMaterial,
    ],
  }
}

function sameBounds(a: FactoryBoundsDto, b: FactoryBoundsDto): boolean {
  return (
    a.innerMinX === b.innerMinX
    && a.innerMaxX === b.innerMaxX
    && a.innerMinZ === b.innerMinZ
    && a.innerMaxZ === b.innerMaxZ
    && a.centerX === b.centerX
    && a.centerZ === b.centerZ
  )
}

/** InstancedMesh 装配：零拷贝接管纯函数构建的实例矩阵 buffer */
function assembleInstancedMesh(
  batch: InstanceGeometryBatch,
  material: MeshStandardMaterial,
  disposables: Disposable[],
): InstancedMesh {
  const mesh = new InstancedMesh(batch.geometry, material, batch.count)
  const instanceMatrix = new InstancedBufferAttribute(batch.matrices, 16)
  mesh.instanceMatrix = instanceMatrix
  disposables.push(batch.geometry, instanceMatrix)
  return mesh
}

/** 按 bounds 重建快照：几何全部来自 scene 纯函数模块，mesh 阴影/渲染次序按 §6.3/§6.6 设置 */
function assembleSnapshot(
  bounds: FactoryBoundsDto,
  shared: SharedFactoryAssets,
  disposables: Disposable[],
): FactorySceneSnapshot {
  // 地坪（§6.6：地坪 receiveShadow=true，castShadow=false）
  const floorGeometry = buildFloorGeometry(bounds)
  const floorMesh = new Mesh(floorGeometry, shared.floorMaterial)
  floorMesh.receiveShadow = true
  disposables.push(floorGeometry)

  // 分缝（贴地元素，不投影不接收阴影）
  const floorJointGeometry = buildFloorJointGeometry(bounds)
  const floorJointMesh = new Mesh(floorJointGeometry, shared.floorJointMaterial)
  disposables.push(floorJointGeometry)

  // 围墙三段（§6.6：实墙 castShadow；§6.3：玻璃不投射阴影、renderOrder=10）
  const walls = buildWallGeometries(bounds)
  const solidWallMesh = new Mesh(walls.solid, shared.wallPanelMaterial)
  solidWallMesh.castShadow = true
  const glassWallMesh = new Mesh(walls.glass, shared.glassMaterial)
  glassWallMesh.castShadow = false
  glassWallMesh.renderOrder = GLASS_RENDER_ORDER
  disposables.push(walls.solid, walls.glass)

  // 墙柱 / 主梁 / 檩条（§6.6：castShadow）
  const wallColumnMesh = assembleInstancedMesh(
    buildWallColumnInstances(bounds),
    shared.wallColumnMaterial,
    disposables,
  )
  wallColumnMesh.castShadow = true
  const roofBeamMesh = assembleInstancedMesh(
    buildRoofBeamInstances(bounds),
    shared.trussSteelMaterial,
    disposables,
  )
  roofBeamMesh.castShadow = true
  const roofPurlinMesh = assembleInstancedMesh(
    buildRoofPurlinInstances(bounds),
    shared.trussSteelMaterial,
    disposables,
  )
  roofPurlinMesh.castShadow = true

  // 室外地坪（§6.6：castShadow=false）
  const outdoorGroundGeometry = buildOutdoorGroundGeometry(bounds)
  const outdoorGroundMesh = new Mesh(outdoorGroundGeometry, shared.outdoorGroundMaterial)
  disposables.push(outdoorGroundGeometry)

  return {
    bounds,
    floorMesh,
    floorJointMesh,
    solidWallMesh,
    glassWallMesh,
    wallColumnMesh,
    roofBeamMesh,
    roofPurlinMesh,
    outdoorGroundMesh,
    // §9.3：不透明遮挡集合 = 实墙/墙柱/主梁/檩条（不含玻璃）
    labelOccluders: Object.freeze([solidWallMesh, wallColumnMesh, roofBeamMesh, roofPurlinMesh]),
  }
}

/** 创建厂房环境资源 owner（§10.3：setup/cleanup 幂等，StrictMode 重复挂载安全） */
export function createFactorySceneResources(
  options: FactorySceneResourcesOptions = {},
): FactorySceneResources {
  const createCanvas = options.createCanvas ?? defaultCreateCanvas

  let shared: SharedFactoryAssets | null = null
  let snapshot: FactorySceneSnapshot | null = null
  let perBoundsDisposables: Disposable[] = []

  /** 释放 bounds 级资源（geometry + 实例矩阵 attribute）；幂等 */
  const releasePerBounds = (): void => {
    for (const disposable of perBoundsDisposables) disposable.dispose()
    perBoundsDisposables = []
    snapshot = null
  }

  return {
    setup(bounds: FactoryBoundsDto, maxAnisotropy: number): FactorySceneSnapshot {
      shared ??= createSharedAssets(createCanvas, maxAnisotropy)
      const anisotropy = targetAnisotropy(maxAnisotropy)
      if (shared.floorTexture.anisotropy !== anisotropy) {
        shared.floorTexture.anisotropy = anisotropy
        shared.floorTexture.needsUpdate = true
      }
      if (snapshot !== null && sameBounds(snapshot.bounds, bounds)) {
        return snapshot
      }
      releasePerBounds()
      perBoundsDisposables = []
      snapshot = assembleSnapshot(bounds, shared, perBoundsDisposables)
      return snapshot
    },

    dispose(): void {
      releasePerBounds()
      if (shared !== null) {
        for (const disposable of shared.disposables) disposable.dispose()
        shared = null
      }
    },

    get current(): FactorySceneSnapshot | null {
      return snapshot
    },
  }
}
