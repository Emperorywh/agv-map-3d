/**
 * 车辆资源与业务位姿解耦：精修模型保持原始米制比例，程序模型按实际尺寸适配。
 * 车体中心仅在世界位姿函数中应用一次偏移，所有部件共享同一个中心和朝向。
 * 几何和材质属于资源所有者；各批次只拥有实例缓冲，状态颜色只进入灯带。
 */
import * as THREE from 'three'
import type { WorldTransform } from '@/shared/spatial'
import { industrialBox, joinGeometry, createPalletGeometry, createCartonGeometry } from '@/shared/industrial/geometry'
import { createIndustrialMaterials, createStatusMaterial } from '@/shared/industrial/materials'
import type { VehicleDisplayState, VehicleSnapshot } from '../model/types'
import { GLB_MATERIAL_PARTS, type GlbPartKind, type IndustrialModel } from './industrialVehicleModel'
import { INDUSTRIAL_AGV_MODEL, usesIndustrialModel } from './vehicleModelConfig'

export type VehiclePartKind = 'chassis' | 'shell' | 'wedge' | 'platform' | 'pallet' | 'cargo' | 'tape' | 'beacon' | 'wheels' | 'metal' | 'bumper' | 'status' | 'shadow' | GlbPartKind
export const VEHICLE_PART_KINDS: readonly VehiclePartKind[] = [
  'chassis', 'shell', 'wedge', 'platform', 'pallet', 'cargo', 'tape', 'beacon', 'wheels', 'metal', 'bumper', 'status', 'shadow',
  ...Object.values(GLB_MATERIAL_PARTS),
]
export const INSTANCE_COLOR_PARTS: ReadonlySet<VehiclePartKind> = new Set(['status', 'glbStatus', 'beacon'])
export const PICKABLE_PARTS: ReadonlySet<VehiclePartKind> = new Set(['shell', 'glbPaint', 'glbPlatform', 'cargo'])
export const LOAD_PARTS: ReadonlySet<VehiclePartKind> = new Set(['pallet', 'cargo', 'tape'])
const PROCEDURAL_PARTS = new Set<VehiclePartKind>(['chassis', 'shell', 'wedge', 'platform', 'wheels', 'metal', 'bumper', 'status'])

export interface PartPlacement {
  readonly x: number; readonly y: number; readonly z: number
  readonly sx: number; readonly sy: number; readonly sz: number
}
export type VehiclePartLayout = Record<VehiclePartKind, PartPlacement> & {
  readonly visible: boolean; readonly loaded: boolean; readonly beaconActive: boolean; readonly industrial: boolean
}
export interface VehicleWorldPose { readonly cx: number; readonly cz: number; readonly rotY: number }
export interface VehicleResources {
  readonly parts: Record<VehiclePartKind, { geometry: THREE.BufferGeometry; material: THREE.Material }>
  readonly modelReady: boolean
  dispose(): void
}

/**
 * 精修模型不做非等比缩放；对应部件与程序回退互斥显示，载货仅复用一套实例。
 * 平台始终保留，托盘底面直接接触平台顶面，纸箱底面直接接触托盘面。
 */
export function computeVehiclePartLayout(snapshot: VehicleSnapshot, displayState: VehicleDisplayState, modelReady = true): VehiclePartLayout {
  const { length, width, loadLength, loadWidth } = snapshot.dimension
  const industrial = modelReady && usesIndustrialModel(snapshot)
  const at = (x: number, y: number, sx: number, sy: number, sz: number, z = 0): PartPlacement => ({ x, y, z, sx, sy, sz })
  const platformTop = INDUSTRIAL_AGV_MODEL.platformTop
  const palletHeight = 0.10
  const cargoHeight = 0.24
  const glb = Object.fromEntries(Object.values(GLB_MATERIAL_PARTS).map((kind) => [kind, at(0, 0, 1, 1, 1)])) as Record<GlbPartKind, PartPlacement>
  return {
    ...glb,
    visible: snapshot.positionValid && snapshot.dimensionValid,
    loaded: snapshot.loaded === true,
    beaconActive: displayState.primary === 'FAULT',
    industrial,
    chassis: at(0, 0.13, length * 0.95, 0.16, width * 0.88),
    // 程序外壳为实心近似，顶面需低于独立平台，防止平台被壳体遮住。
    // 精修模型的顶面凹槽已在资产中建好，不使用这组回退矩阵。
    shell: at(0, 0.235, length, 0.19, width),
    wedge: at(length / 2 + 0.001, 0.25, 0.012, 0.06, width * 0.40),
    platform: at(0, platformTop - 0.012, length * 0.82, 0.024, width * 0.80),
    pallet: at(0, platformTop + palletHeight / 2, loadLength * 0.8, palletHeight, loadWidth * 0.8),
    cargo: at(0, platformTop + palletHeight + cargoHeight / 2, loadLength * 0.78, cargoHeight, loadWidth * 0.78),
    tape: at(0, platformTop + palletHeight + cargoHeight / 2, loadLength * 0.78, cargoHeight, loadWidth * 0.78),
    beacon: at(-length * 0.42, 0.365, 0.035, 0.028, 0.035),
    wheels: at(0, 0.098, length, 1, width),
    metal: at(0, 0.098, length, 1, width),
    bumper: at(0, 0.16, length, 0.05, width),
    status: at(0, 0.277, length, 0.018, width),
    shadow: at(0, 0.002, length * 1.01, 1, width * 1.06),
  }
}

export function vehiclePartVisible(kind: VehiclePartKind, layout: VehiclePartLayout): boolean {
  if (!layout.visible) return false
  if (kind.startsWith('glb')) return layout.industrial
  if (PROCEDURAL_PARTS.has(kind)) return !layout.industrial
  if (LOAD_PARTS.has(kind)) return layout.loaded
  if (kind === 'beacon') return layout.beaconActive
  return true
}

/**
 * 沿地图车头方向平移定位参考点，再经原有世界变换转换位置与朝向。
 * 模型资源没有烘焙定位偏移，跟随相机与实例部件继续复用这一唯一口径。
 */
export function computeVehicleWorldPose(snapshot: VehicleSnapshot, worldTransform: WorldTransform): VehicleWorldPose {
  const { x, y, theta } = snapshot.position
  const offset = snapshot.dimension.centerOffset
  const world = worldTransform.toWorldXZ(x + offset * Math.cos(theta), y + offset * Math.sin(theta))
  return { cx: world.x, cz: world.z, rotY: worldTransform.angleToWorldYRotation(theta) }
}

/**
 * 程序回退采用实际几何圆角及分离轮毂、防撞条、传感器窗口，资源供整队复用。
 * 轮胎高度固定，水平轮距随尺寸变化；所有轮胎最低点始终为零米。
 */
export function createVehicleResources(model?: IndustrialModel): VehicleResources {
  const materials = createIndustrialMaterials()
  const statusMaterial = createStatusMaterial()
  const parts = {} as VehicleResources['parts']
  const add = (kind: VehiclePartKind, geometry: THREE.BufferGeometry, material: THREE.Material) => { parts[kind] = { geometry, material } }
  add('chassis', industrialBox(1, 1, 1, 0.035, 1), materials.chassis)
  add('shell', industrialBox(1, 1, 1, 0.075, 1), materials.paint)
  add('wedge', industrialBox(1, 1, 1, 0.06, 1), materials.rubber)
  add('platform', industrialBox(1, 1, 1, 0.04, 1), materials.platform)
  add('pallet', createPalletGeometry(), materials.wood)
  add('cargo', createCartonGeometry(), materials.cardboard)
  add('tape', createCartonGeometry(true), materials.tape)
  add('beacon', industrialBox(1, 1, 1, 0.2), statusMaterial)
  for (const kind of ['wheels', 'metal'] as const) {
    const wheels: THREE.BufferGeometry[] = []
    for (const x of [-0.30, 0.30]) for (const z of [-0.43, 0.43]) {
      const radius = kind === 'wheels' ? 0.098 : 0.052
      const geometry = new THREE.CylinderGeometry(radius, radius, kind === 'wheels' ? 0.10 : 0.105, 16).toNonIndexed()
      geometry.rotateX(Math.PI / 2)
      geometry.scale(1 / 1.8, 1, 1)
      wheels.push(geometry.translate(x, 0, z))
    }
    add(kind, joinGeometry(wheels), kind === 'wheels' ? materials.rubber : materials.metal)
  }
  add('bumper', joinGeometry([-1, 1].map((side) => industrialBox(0.018, 1, 0.82, 0.004).translate(side * 0.49, 0, 0))), materials.rubber)
  add('status', joinGeometry([-1, 1].flatMap((side) => [-1, 1].map((z) => industrialBox(0.005, 1, 0.15, 0.001).translate(side * 0.5, 0, z * 0.30)))), statusMaterial)
  const shadow = new THREE.CircleGeometry(0.5, 32)
  shadow.rotateX(-Math.PI / 2)
  add('shadow', shadow, new THREE.MeshBasicMaterial({ color: '#111820', transparent: true, opacity: 0.12, depthWrite: false }))
  for (const kind of Object.values(GLB_MATERIAL_PARTS)) {
    parts[kind] = model?.parts[kind] ?? { geometry: new THREE.BufferGeometry(), material: materials.paint }
  }
  return {
    parts,
    modelReady: model !== undefined,
    dispose() {
      const geometries = new Set(Object.values(parts).map((part) => part.geometry))
      const ownedMaterials = new Set([...Object.values(materials), ...Object.values(parts).map((part) => part.material)])
      for (const geometry of geometries) geometry.dispose()
      for (const material of ownedMaterials) material.dispose()
    },
  }
}
