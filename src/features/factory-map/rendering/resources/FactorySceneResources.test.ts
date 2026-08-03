/**
 * FactorySceneResources 单元测试（SPEC §10.3、§6.3、§6.6、§9.3）。
 *
 * 经注入的 Canvas 桩件在 node 环境验证资源装配与生命周期：
 * - 快照结构：8 个 mesh（+ drei Sky = §6.7 主 pass 9 批次）；labelOccluders 只含
 *   实墙/墙柱/主梁/檩条（不含玻璃）；
 * - 程序纹理：CanvasTexture SRGB/Repeat/anisotropy=min(8, 设备上限)，
 *   像素与确定性纯函数逐字节一致；
 * - 玻璃五参数、阴影标记、颜色全部来自 visualTheme；
 * - bounds 未变 setup 幂等（同一快照）；bounds 变化释放旧 geometry、保留共享
 *   纹理/material；dispose 幂等且释放全部资源。
 */

import {
  CanvasTexture,
  DoubleSide,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three'
import type { Material, Mesh } from 'three'
import { describe, expect, it } from 'vitest'

import type { FactoryBoundsDto } from '../../application/factorySceneModel'
import { ENV_MAP_INTENSITY, GLASS_ENV_MAP_INTENSITY } from '../../config/qualityProfile'
import { FLOOR_TEXTURE_SEED } from '../../config/sceneMetrics'
import type { CreateCanvas, FactorySceneSnapshot } from './FactorySceneResources'
import { createFactorySceneResources } from './FactorySceneResources'
import { FLOOR_TEXTURE_SIZE, generateFloorTexturePixels } from '../scene/floor/floorTexture'

const BOUNDS_A: FactoryBoundsDto = {
  innerMinX: -50,
  innerMaxX: 50,
  innerMinZ: -30,
  innerMaxZ: 30,
  centerX: 0,
  centerZ: 0,
}

const BOUNDS_B: FactoryBoundsDto = {
  innerMinX: -30,
  innerMaxX: 30,
  innerMinZ: -20,
  innerMaxZ: 20,
  centerX: 0,
  centerZ: 0,
}

interface PutImageDataCall {
  readonly data: Uint8ClampedArray
  readonly width: number
  readonly height: number
}

/** Canvas 桩件：记录 putImageData 的像素，脱离 DOM 验证纹理管线 */
function createCanvasRecorder(): { createCanvas: CreateCanvas; calls: PutImageDataCall[] } {
  const calls: PutImageDataCall[] = []
  const createCanvas: CreateCanvas = (width, height) => {
    const context2d = {
      createImageData: (w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
      putImageData: (
        imageData: { data: Uint8ClampedArray; width: number; height: number },
        _dx: number,
        _dy: number,
      ) => {
        calls.push({ data: imageData.data, width: imageData.width, height: imageData.height })
      },
    }
    return {
      width,
      height,
      getContext: (kind: string) => (kind === '2d' ? context2d : null),
    } as unknown as HTMLCanvasElement
  }
  return { createCanvas, calls }
}

/** 读取单材质（本模块 mesh 均为单材质，不做多材质数组防御） */
function materialOf(mesh: Mesh): Material {
  return mesh.material as Material
}

/** 包装 dispose 计数（bounds 级/共享级释放验证） */
function trackDispose(target: { dispose(): void }, tracker: { count: number }): void {
  const original = target.dispose.bind(target)
  target.dispose = () => {
    tracker.count += 1
    original()
  }
}

/** 快照的 bounds 级可释放资源：8 份 geometry + 3 份实例矩阵 attribute */
function perBoundsDisposables(snapshot: FactorySceneSnapshot): { dispose(): void }[] {
  return [
    snapshot.floorMesh.geometry,
    snapshot.floorJointMesh.geometry,
    snapshot.solidWallMesh.geometry,
    snapshot.glassWallMesh.geometry,
    snapshot.wallColumnMesh.geometry,
    snapshot.wallColumnMesh.instanceMatrix,
    snapshot.roofBeamMesh.geometry,
    snapshot.roofBeamMesh.instanceMatrix,
    snapshot.roofPurlinMesh.geometry,
    snapshot.roofPurlinMesh.instanceMatrix,
    snapshot.outdoorGroundMesh.geometry,
  ]
}

function floorTextureOf(snapshot: FactorySceneSnapshot): CanvasTexture {
  return (snapshot.floorMesh.material as MeshStandardMaterial).map as CanvasTexture
}

describe('FactorySceneResources 快照结构（§6.7、§9.3）', () => {
  const { createCanvas } = createCanvasRecorder()
  const resources = createFactorySceneResources({ createCanvas })
  const snapshot = resources.setup(BOUNDS_A, 16)

  it('快照含 8 个互不相同的 mesh（+ drei Sky = 主 pass 9 批次）', () => {
    const meshes = [
      snapshot.floorMesh,
      snapshot.floorJointMesh,
      snapshot.solidWallMesh,
      snapshot.glassWallMesh,
      snapshot.wallColumnMesh,
      snapshot.roofBeamMesh,
      snapshot.roofPurlinMesh,
      snapshot.outdoorGroundMesh,
    ]
    expect(new Set(meshes).size).toBe(8)
    expect(resources.current).toBe(snapshot)
  })

  it('labelOccluders = 实墙/墙柱/主梁/檩条（不含玻璃与地坪）', () => {
    expect(snapshot.labelOccluders).toHaveLength(4)
    expect(snapshot.labelOccluders).toContain(snapshot.solidWallMesh)
    expect(snapshot.labelOccluders).toContain(snapshot.wallColumnMesh)
    expect(snapshot.labelOccluders).toContain(snapshot.roofBeamMesh)
    expect(snapshot.labelOccluders).toContain(snapshot.roofPurlinMesh)
    expect(snapshot.labelOccluders).not.toContain(snapshot.glassWallMesh)
    expect(snapshot.labelOccluders).not.toContain(snapshot.floorMesh)
  })

  it('阴影标记：实墙/墙柱/主梁/檩条 castShadow；地坪 receiveShadow；玻璃不投影', () => {
    expect(snapshot.solidWallMesh.castShadow).toBe(true)
    expect(snapshot.wallColumnMesh.castShadow).toBe(true)
    expect(snapshot.roofBeamMesh.castShadow).toBe(true)
    expect(snapshot.roofPurlinMesh.castShadow).toBe(true)
    expect(snapshot.floorMesh.receiveShadow).toBe(true)
    expect(snapshot.floorMesh.castShadow).toBe(false)
    expect(snapshot.glassWallMesh.castShadow).toBe(false)
    expect(snapshot.outdoorGroundMesh.castShadow).toBe(false)
  })
})

describe('FactorySceneResources 材质与纹理（§6.2、§6.3、§6.6、§6.8）', () => {
  const { createCanvas, calls } = createCanvasRecorder()
  const resources = createFactorySceneResources({ createCanvas })
  const snapshot = resources.setup(BOUNDS_A, 16)

  it('程序纹理像素与确定性纯函数逐字节一致（seed 0x4D415033）', () => {
    expect(calls).toHaveLength(1)
    expect(calls[0].width).toBe(FLOOR_TEXTURE_SIZE)
    expect(calls[0].height).toBe(FLOOR_TEXTURE_SIZE)
    expect(calls[0].data).toEqual(generateFloorTexturePixels(FLOOR_TEXTURE_SEED, FLOOR_TEXTURE_SIZE))
  })

  it('CanvasTexture：SRGBColorSpace、RepeatWrapping×2、anisotropy=min(8, 设备上限)', () => {
    const texture = floorTextureOf(snapshot)
    expect(texture).toBeInstanceOf(CanvasTexture)
    expect(texture.colorSpace).toBe(SRGBColorSpace)
    expect(texture.wrapS).toBe(RepeatWrapping)
    expect(texture.wrapT).toBe(RepeatWrapping)
    expect(texture.anisotropy).toBe(8)
  })

  it('玻璃五参数与 renderOrder=10（§6.3）', () => {
    const glass = snapshot.glassWallMesh.material as MeshStandardMaterial
    expect(glass.transparent).toBe(true)
    expect(glass.opacity).toBe(0.35)
    expect(glass.depthWrite).toBe(false)
    expect(glass.side).toBe(DoubleSide)
    expect(snapshot.glassWallMesh.renderOrder).toBe(10)
  })

  it('颜色全部来自 visualTheme（§6.8 逐项）', () => {
    const colorOf = (mesh: { material: unknown }): string =>
      (mesh.material as MeshStandardMaterial).color.getHexString()
    expect(colorOf(snapshot.floorJointMesh)).toBe('7f7c76')
    expect(colorOf(snapshot.solidWallMesh)).toBe('e9e7e2')
    expect(colorOf(snapshot.wallColumnMesh)).toBe('8a94a0')
    expect(colorOf(snapshot.glassWallMesh)).toBe('a8cce8')
    expect(colorOf(snapshot.roofBeamMesh)).toBe('5d6873')
    expect(colorOf(snapshot.roofPurlinMesh)).toBe('5d6873')
    expect(colorOf(snapshot.outdoorGroundMesh)).toBe('aca79b')
  })

  it('roughness：地坪 0.95、室外地坪 1；envMapIntensity：0.5 / 玻璃 0.6', () => {
    expect((snapshot.floorMesh.material as MeshStandardMaterial).roughness).toBe(0.95)
    expect((snapshot.outdoorGroundMesh.material as MeshStandardMaterial).roughness).toBe(1)
    expect((snapshot.floorMesh.material as MeshStandardMaterial).envMapIntensity).toBe(ENV_MAP_INTENSITY)
    expect((snapshot.glassWallMesh.material as MeshStandardMaterial).envMapIntensity).toBe(GLASS_ENV_MAP_INTENSITY)
  })

  it('分缝材质 polygonOffset：factor -1 / units -1（§4.3 双保险第二道）', () => {
    const joints = snapshot.floorJointMesh.material as MeshStandardMaterial
    expect(joints.polygonOffset).toBe(true)
    expect(joints.polygonOffsetFactor).toBe(-1)
    expect(joints.polygonOffsetUnits).toBe(-1)
  })
})

describe('FactorySceneResources 生命周期（§10.3）', () => {
  it('bounds 未变时 setup 幂等：返回同一快照，不重建 geometry', () => {
    const { createCanvas } = createCanvasRecorder()
    const resources = createFactorySceneResources({ createCanvas })
    const first = resources.setup(BOUNDS_A, 16)
    const second = resources.setup(BOUNDS_A, 16)
    expect(second).toBe(first)
    expect(second.floorMesh.geometry).toBe(first.floorMesh.geometry)
  })

  it('maxAnisotropy 变化时只更新纹理各向异性（min(8, 上限)），不重建快照', () => {
    const { createCanvas } = createCanvasRecorder()
    const resources = createFactorySceneResources({ createCanvas })
    const first = resources.setup(BOUNDS_A, 4)
    expect(floorTextureOf(first).anisotropy).toBe(4)
    const second = resources.setup(BOUNDS_A, 16)
    expect(second).toBe(first)
    expect(floorTextureOf(second).anisotropy).toBe(8)
  })

  it('bounds 变化：释放旧 geometry 与实例矩阵，保留共享纹理/material', () => {
    const { createCanvas } = createCanvasRecorder()
    const resources = createFactorySceneResources({ createCanvas })
    const first = resources.setup(BOUNDS_A, 16)
    const texture = floorTextureOf(first)
    const sharedMaterials = new Set([
      materialOf(first.floorMesh),
      materialOf(first.floorJointMesh),
      materialOf(first.solidWallMesh),
      materialOf(first.glassWallMesh),
      materialOf(first.wallColumnMesh),
      materialOf(first.roofBeamMesh),
      materialOf(first.roofPurlinMesh),
      materialOf(first.outdoorGroundMesh),
    ])
    // 主梁/檩条共享桁架钢材质 → 7 个共享材质
    expect(sharedMaterials.size).toBe(7)

    const perBounds = { count: 0 }
    for (const disposable of perBoundsDisposables(first)) trackDispose(disposable, perBounds)
    const shared = { count: 0 }
    trackDispose(texture, shared)
    for (const material of sharedMaterials) trackDispose(material, shared)

    const second = resources.setup(BOUNDS_B, 16)
    expect(second).not.toBe(first)
    expect(perBounds.count).toBe(11)
    expect(shared.count).toBe(0)
    // 共享材质保留：新快照复用同一批 material
    expect(second.floorMesh.material).toBe(first.floorMesh.material)
    expect(floorTextureOf(second)).toBe(texture)
    expect(second.solidWallMesh.geometry).not.toBe(first.solidWallMesh.geometry)
  })

  it('dispose：释放全部 bounds 级与共享级资源；幂等；之后可重新 setup', () => {
    const { createCanvas } = createCanvasRecorder()
    const resources = createFactorySceneResources({ createCanvas })
    const snapshot = resources.setup(BOUNDS_A, 16)
    const texture = floorTextureOf(snapshot)
    const materials = new Set([
      materialOf(snapshot.floorMesh),
      materialOf(snapshot.floorJointMesh),
      materialOf(snapshot.solidWallMesh),
      materialOf(snapshot.glassWallMesh),
      materialOf(snapshot.wallColumnMesh),
      materialOf(snapshot.roofBeamMesh),
      materialOf(snapshot.outdoorGroundMesh),
    ])

    const perBounds = { count: 0 }
    for (const disposable of perBoundsDisposables(snapshot)) trackDispose(disposable, perBounds)
    const shared = { count: 0 }
    trackDispose(texture, shared)
    for (const material of materials) trackDispose(material, shared)

    resources.dispose()
    expect(perBounds.count).toBe(11)
    expect(shared.count).toBe(8) // 1 纹理 + 7 材质
    expect(resources.current).toBeNull()

    // 幂等：第二次 dispose 不产生额外释放
    resources.dispose()
    expect(perBounds.count).toBe(11)
    expect(shared.count).toBe(8)

    // dispose 后可重新 setup（StrictMode 重挂载语义）
    const again = resources.setup(BOUNDS_A, 16)
    expect(again).not.toBe(snapshot)
    expect(resources.current).toBe(again)
    resources.dispose()
  })

  it('Canvas 2D 上下文不可用时 setup 失败且不产生快照', () => {
    const noContext = (() => ({
      width: 0,
      height: 0,
      getContext: () => null,
    })) as unknown as CreateCanvas
    const resources = createFactorySceneResources({ createCanvas: noContext })
    expect(() => resources.setup(BOUNDS_A, 16)).toThrowError(/Canvas 2D/)
    expect(resources.current).toBeNull()
  })
})
