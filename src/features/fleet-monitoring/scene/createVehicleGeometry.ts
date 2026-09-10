/**
 * 车辆资源与业务位姿解耦：精修模型保持原始米制比例，程序模型按实际尺寸适配。
 * 车体中心仅在世界位姿函数中应用一次偏移，所有部件共享同一个中心和朝向。
 * 几何和材质属于资源所有者；各批次只拥有实例缓冲，状态颜色进入灯带与地面投光。
 */
import * as THREE from 'three'
import type { WorldTransform } from '@/shared/spatial'
import { industrialBox, joinGeometry, createPalletGeometry, createCartonGeometry } from '@/shared/industrial/geometry'
import { createIndustrialMaterials, createStatusMaterial } from '@/shared/industrial/materials'
import type { VehicleDisplayState, VehicleSnapshot } from '../model/types'
import { GLB_MATERIAL_PARTS, type GlbPartKind, type IndustrialModel } from './industrialVehicleModel'
import { INDUSTRIAL_AGV_MODEL, usesIndustrialModel } from './vehicleModelConfig'
import { createStatusLightGround } from './vehicleStatusLights'
import { SHELF_MATERIAL_PARTS, type ShelfModel, type ShelfPartKind } from '@/shared/industrial/shelfModel'

/**
 * 地面投光作为整车部件共享分配、移动与删除流程。
 * 这样资源恢复或车辆离场时不会留下独立光斑。
 */
export type VehiclePartKind = 'chassis' | 'shell' | 'wedge' | 'platform' | 'pallet' | 'cargo' | 'tape' | 'beacon' | 'wheels' | 'metal' | 'bumper' | 'status' | 'statusGround' | 'shadow' | GlbPartKind | ShelfPartKind
export const VEHICLE_PART_KINDS: readonly VehiclePartKind[] = [
  'chassis', 'shell', 'wedge', 'platform', 'pallet', 'cargo', 'tape', 'beacon', 'wheels', 'metal', 'bumper', 'status', 'statusGround', 'shadow',
  ...Object.values(GLB_MATERIAL_PARTS),
  ...Object.values(SHELF_MATERIAL_PARTS),
]
export const INSTANCE_COLOR_PARTS: ReadonlySet<VehiclePartKind> = new Set(['status', 'glbStatus', 'statusGround', 'beacon'])
/**
 * 满载货架沿用车辆实例槽位与拾取映射，点击架体或料箱仍选中所属车辆。
 * 所有货架部件进入载荷集合，卸货、无效状态与删除均由原帧同步统一清理。
 */
export const PICKABLE_PARTS: ReadonlySet<VehiclePartKind> = new Set(['shell', 'glbPaint', 'glbPlatform', 'cargo', ...Object.values(SHELF_MATERIAL_PARTS)])
export const LOAD_PARTS: ReadonlySet<VehiclePartKind> = new Set(['pallet', 'cargo', 'tape', ...Object.values(SHELF_MATERIAL_PARTS)])
/**
 * 完整载荷按共享材质映射识别，兼容原货架和新托盘货箱的部件名称。
 * 不依赖名称前缀，避免新货箱被当作程序回退而在资源就绪后隐藏。
 */
const SHELF_PARTS: ReadonlySet<VehiclePartKind> = new Set(Object.values(SHELF_MATERIAL_PARTS))
const PROCEDURAL_PARTS = new Set<VehiclePartKind>(['chassis', 'shell', 'wedge', 'platform', 'wheels', 'metal', 'bumper', 'status'])

export interface PartPlacement {
  readonly x: number; readonly y: number; readonly z: number
  readonly sx: number; readonly sy: number; readonly sz: number
}
export type VehiclePartLayout = Record<VehiclePartKind, PartPlacement> & {
  readonly visible: boolean; readonly loaded: boolean; readonly beaconActive: boolean; readonly industrial: boolean; readonly shelfReady: boolean
}
export interface VehicleWorldPose { readonly cx: number; readonly cz: number; readonly rotY: number }
export interface VehicleResources {
  readonly parts: Record<VehiclePartKind, { geometry: THREE.BufferGeometry; material: THREE.Material; lodGeometries?: THREE.BufferGeometry[] }>
  readonly modelReady: boolean
  /**
   * 货架独立于车体模型加载，失败时保留已有托盘纸箱回退。
   * 资源切换后全量刷新槽位，避免新旧载荷重叠。
   */
  readonly shelfReady: boolean
  dispose(): void
}

/**
 * 精修模型不做非等比缩放；对应部件与程序回退互斥显示，载货仅复用一套实例。
 * 平台始终保留，货架脚底直接接触承载面；加载期间仍使用托盘纸箱回退。
 */
export function computeVehiclePartLayout(snapshot: VehicleSnapshot, displayState: VehicleDisplayState, modelReady = true, shelfReady = false): VehiclePartLayout {
  const { length, width, loadLength, loadWidth } = snapshot.dimension
  const industrial = modelReady && usesIndustrialModel(snapshot)
  const at = (x: number, y: number, sx: number, sy: number, sz: number, z = 0): PartPlacement => ({ x, y, z, sx, sy, sz })
  const platformTop = INDUSTRIAL_AGV_MODEL.platformTop
  // 精修模式忽略申报长宽：贴地阴影与故障信标跟随模型档案尺寸，避免异尺寸车辆错位。
  const bodyLength = industrial ? INDUSTRIAL_AGV_MODEL.length : length
  const bodyWidth = industrial ? INDUSTRIAL_AGV_MODEL.width : width
  const palletHeight = 0.10
  const cargoHeight = 0.24
  const glb = Object.fromEntries(Object.values(GLB_MATERIAL_PARTS).map((kind) => [kind, at(0, 0, 1, 1, 1)])) as Record<GlbPartKind, PartPlacement>
  /**
   * 托盘货物原点位于底面中心，保留约一点二米乘一米的真实底座尺寸。
   * 不按接口载荷尺寸拉伸资产；抬升到平台高度并按车型配置向车尾偏移。
   * 箱体、托盘和绑带共用局部偏移，随车辆转向旋转，为前方显示屏立柱留出空间。
   */
  const shelf = Object.fromEntries(Object.values(SHELF_MATERIAL_PARTS).map((kind) => [kind, at(INDUSTRIAL_AGV_MODEL.cargoOffsetX, platformTop, 1, 1, 1)])) as Record<ShelfPartKind, PartPlacement>
  return {
    ...glb,
    ...shelf,
    shelfReady,
    visible: snapshot.positionValid && snapshot.dimensionValid,
    loaded: snapshot.loaded === true,
    beaconActive: displayState.primary === 'FAULT',
    industrial,
    chassis: at(0, 0.13, length * 0.95, 0.16, width * 0.88),
    // 程序外壳为实心近似，顶面需低于独立平台，防止平台被壳体遮住。
    // 精修模型的顶面凹槽已在资产中建好，不使用这组回退矩阵。
    shell: at(0, 0.235, length, 0.19, width),
    /**
     * 车行方向箭头（P2-7）：外壳顶面前段的「➤」薄贴片，俯视即可读出车头
     * 朝向。鼻尖略收在壳体鼻点之内，底面抬高 1mm 避让壳顶面深度冲突，
     * 顶面低于平台顶保持部件层次；精修模式隐藏本部件（资产自带形态）。
     */
    wedge: at(length * 0.455, 0.335, length * 0.08, 0.008, width * 0.40),
    platform: at(0, platformTop - 0.012, length * 0.82, 0.024, width * 0.80),
    pallet: at(0, platformTop + palletHeight / 2, loadLength * 0.8, palletHeight, loadWidth * 0.8),
    cargo: at(0, platformTop + palletHeight + cargoHeight / 2, loadLength * 0.78, cargoHeight, loadWidth * 0.78),
    tape: at(0, platformTop + palletHeight + cargoHeight / 2, loadLength * 0.78, cargoHeight, loadWidth * 0.78),
    beacon: at(-bodyLength * 0.39, platformTop + 0.014, 0.035, 0.028, 0.035),
    wheels: at(0, 0.098, length, 1, width),
    metal: at(0, 0.098, length, 1, width),
    bumper: at(0, 0.16, length, 0.05, width),
    status: at(0, 0.277, length, 0.018, width),
    /**
     * 投光略高于道路导引面，保持深度测试以接受车辆和设施遮挡。
     * 使用真实车体长宽，不随接口申报尺寸拉伸精修模型的照地范围。
     */
    statusGround: at(0, 0.082, bodyLength, 1, bodyWidth),
    shadow: at(0, 0.002, bodyLength * 1.01, 1, bodyWidth * 1.06),
  }
}

export function vehiclePartVisible(kind: VehiclePartKind, layout: VehiclePartLayout): boolean {
  if (!layout.visible) return false
  /**
   * 完整托盘货箱与程序纸箱互斥显示，载荷状态未知或空载时两者都隐藏。
   * 同一判断同时供位姿更新和显示状态更新使用，防止仅切换载货状态时出现重叠。
   */
  if (SHELF_PARTS.has(kind)) return layout.loaded && layout.shelfReady
  if (kind.startsWith('glb')) return layout.industrial
  if (PROCEDURAL_PARTS.has(kind)) return !layout.industrial
  if (LOAD_PARTS.has(kind)) return layout.loaded && !layout.shelfReady
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
 * 车行方向箭头（P2-7）：俯视「➤」轮廓的薄棱柱——鼻尖朝 +x、两翼全宽、
 * 尾部中央凹口。几何归一化到 [-0.5,0.5]³，实例矩阵按车体尺寸非等比缩放，
 * 与其他部件槽位共享同一中心与朝向口径。
 */
function createDirectionArrowGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape([
    new THREE.Vector2(0.5, 0),
    new THREE.Vector2(-0.5, 0.5),
    new THREE.Vector2(-0.15, 0),
    new THREE.Vector2(-0.5, -0.5),
  ])
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false })
  geometry.translate(0, 0, -0.5)
  geometry.rotateX(-Math.PI / 2)
  return geometry
}

/**
 * 程序回退采用实际几何圆角及分离轮毂、防撞条、传感器窗口，资源供整队复用。
 * 轮胎高度固定，水平轮距随尺寸变化；所有轮胎最低点始终为零米。
 */
export function createVehicleResources(model?: IndustrialModel, shelf?: ShelfModel): VehicleResources {
  const materials = createIndustrialMaterials()
  const statusMaterial = createStatusMaterial()
  const parts = {} as VehicleResources['parts']
  const add = (kind: VehiclePartKind, geometry: THREE.BufferGeometry, material: THREE.Material) => { parts[kind] = { geometry, material } }
  add('chassis', industrialBox(1, 1, 1, 0.035, 1), materials.chassis)
  add('shell', industrialBox(1, 1, 1, 0.075, 1), materials.paint)
  add('wedge', createDirectionArrowGeometry(), materials.rubber)
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
  /**
   * 地面光斑与模型资源一同创建和释放，整队只持有一份几何与材质。
   * 无外部纹理依赖，加载占位和上下文恢复阶段也能显示状态照地。
   */
  parts.statusGround = createStatusLightGround()
  const shadow = new THREE.CircleGeometry(0.5, 32)
  shadow.rotateX(-Math.PI / 2)
  add('shadow', shadow, new THREE.MeshBasicMaterial({ color: '#111820', transparent: true, opacity: 0.12, depthWrite: false }))
  for (const kind of Object.values(GLB_MATERIAL_PARTS)) {
    parts[kind] = model?.parts[kind] ?? { geometry: new THREE.BufferGeometry(), material: materials.paint }
  }
  /**
   * 整队共用一份托盘货物几何和原材质，每辆车仅增加实例矩阵。
   * 车载货物沿用绕竖直轴九十度的摆放，近中远景同步烘焙，保持底面高度不变。
   * 此处只调整车队独立持有的几何，地面货架继续使用原始朝向。
   * 未就绪时建立空部件以保持槽位结构稳定，内嵌标签贴图随资源统一回收。
   */
  for (const kind of Object.values(SHELF_MATERIAL_PARTS)) {
    parts[kind] = shelf?.parts[kind] ?? { geometry: new THREE.BufferGeometry(), material: materials.paint }
    parts[kind].geometry.rotateY(Math.PI / 2)
    for (const geometry of parts[kind].lodGeometries ?? []) geometry.rotateY(Math.PI / 2)
  }
  return {
    parts,
    modelReady: model !== undefined,
    shelfReady: shelf !== undefined,
    dispose() {
      /**
       * 精修与中远景几何都由整队资源所有者释放，批次只释放自身拷贝。
       * 材质由各档共享，集合去重避免重复清理。
       */
      const geometries = new Set(Object.values(parts).flatMap((part) => [part.geometry, ...(part.lodGeometries ?? [])]))
      const ownedMaterials = new Set([...Object.values(materials), ...Object.values(parts).map((part) => part.material)])
      const textures = new Set<THREE.Texture>()
      for (const material of ownedMaterials) for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value)
      }
      for (const geometry of geometries) geometry.dispose()
      for (const material of ownedMaterials) material.dispose()
      for (const texture of textures) texture.dispose()
    },
  }
}
