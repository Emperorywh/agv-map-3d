/**
 * 通用程序化 AGV 几何与部件布局（SPEC §2.5、§5.2、§6.3；TASK-010）。
 *
 * 职责：三件事——
 * 1. 纯函数布局：从已校验快照计算七个部件（底盘/外壳/+x 方向楔/载荷平台/
 *    托盘/警示灯/车底假阴影）在车体本地系的中心与全尺寸，以及车体中心在
 *    世界系的位姿（§2.5 的 centerOffset 位移、rotation.y=-theta 唯一口径）；
 * 2. 几何工厂：构建共用单位几何（盒、楔、信标、阴影贴片）与部件材质，
 *    供全部批次共享（单一所有者 + 幂等 dispose）；
 * 3. 资源合同：声明哪些部件走实例颜色（外壳/楔/信标），哪些走固定材质色。
 * 边界：不创建 InstancedMesh、不写实例缓冲（帧同步层职责）；不感知 React
 *       与数据源；车型 rawType 不参与建模——未知车型统一通用 AGV，不猜测
 *       变体（SPEC §2.4/R2）。
 * 关键不变量：
 * 1. 车体几何中心 = 参考点沿车头轴平移 centerOffset（在地图平面坐标先合成
 *    再经 worldTransform 变换，SPEC §2.5），全部部件中心由该世界位姿旋转
 *    本地偏移得到——任何部件不得单独再叠加 centerOffset；
 * 2. 部件 x/z 尺寸来自每车 agvDimension（length/width/loadLength/loadWidth
 *    分别进入矩阵），固定高度只进入 y 分量——不允许只用统一样例尺寸；
 * 3. visible = positionValid && dimensionValid：false 时整车零缩放不渲染
 *    （非法坐标不放置车体，SPEC §11.8），信标激活当且仅当投影主状态为
 *    FAULT（即 FRESH + ONLINE 的故障车，OFFLINE/STALE 熄灭）；
 * 4. 几何全部以自身包围盒中心为原点（阴影贴片为水平面），矩阵 scale 即
 *    全尺寸，position 即部件中心——写矩阵时不再做几何内偏移换算。
 */
import * as THREE from 'three'
import type { WorldTransform } from '@/shared/spatial'
import type { VehicleDisplayState, VehicleSnapshot } from '../model/types'
import {
  BEACON_BLADE_LENGTH_M,
  BEACON_BLADE_THICKNESS_M,
  BEACON_DOME_HEIGHT_M,
  BEACON_DOME_RADIUS_M,
  BEACON_MOUNT_CLEARANCE_M,
  CHASSIS_CLEARANCE_M,
  CHASSIS_HEIGHT_M,
  CHASSIS_METALNESS,
  CHASSIS_COLOR,
  CHASSIS_ROUGHNESS,
  PALLET_COLOR,
  PALLET_HEIGHT_M,
  PALLET_LENGTH_RATIO,
  PALLET_WIDTH_RATIO,
  PLATFORM_COLOR,
  PLATFORM_THICKNESS_M,
  SHELL_HEIGHT_M,
  SHELL_METALNESS,
  SHELL_ROUGHNESS,
  SHELL_WIDTH_RATIO,
  VEHICLE_SHADOW_COLOR,
  VEHICLE_SHADOW_LENGTH_RATIO,
  VEHICLE_SHADOW_OPACITY,
  VEHICLE_SHADOW_WIDTH_RATIO,
  VEHICLE_SHADOW_Y,
  WEDGE_LENGTH_RATIO,
  WEDGE_MAX_LENGTH_M,
  WEDGE_MIN_LENGTH_M,
} from './fleetAppearance'

/** 车体部件种类（与 InstancedMesh 一一对应；每批次 7 个 Draw Call） */
export type VehiclePartKind =
  | 'chassis'
  | 'shell'
  | 'wedge'
  | 'platform'
  | 'pallet'
  | 'beacon'
  | 'shadow'

export const VEHICLE_PART_KINDS: readonly VehiclePartKind[] = [
  'chassis',
  'shell',
  'wedge',
  'platform',
  'pallet',
  'beacon',
  'shadow',
]

/** 部件在车体本地系的放置：中心位置 + 全尺寸（矩阵 scale 分量） */
export interface PartPlacement {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly sx: number
  readonly sy: number
  readonly sz: number
}

/** 一次快照的整车布局（本地系；beacon 只含定位，旋转由动画层每帧写入） */
export interface VehiclePartLayout {
  /** positionValid && dimensionValid；false 时整车不得放置（零缩放） */
  readonly visible: boolean
  /** loadState === LOADED：决定平台/托盘是真实矩阵还是零缩放 */
  readonly loaded: boolean
  /** 投影主状态为 FAULT：警示灯旋转闪烁；其余（含 OFFLINE/STALE）熄灭 */
  readonly beaconActive: boolean
  readonly chassis: PartPlacement
  readonly shell: PartPlacement
  readonly wedge: PartPlacement
  readonly platform: PartPlacement
  readonly pallet: PartPlacement
  readonly beacon: PartPlacement
  readonly shadow: PartPlacement
}

/** 车体中心的世界位姿（世界系）；rotY 已含 worldTransform 的角度换算 */
export interface VehicleWorldPose {
  readonly cx: number
  readonly cz: number
  readonly rotY: number
}

/** 方向楔长度：按车长比例并钳制到绝对范围（避免超长/微缩车畸形） */
export function wedgeLengthOf(vehicleLength: number): number {
  return Math.min(
    WEDGE_MAX_LENGTH_M,
    Math.max(WEDGE_MIN_LENGTH_M, WEDGE_LENGTH_RATIO * vehicleLength),
  )
}

/**
 * 从快照与投影显示状态计算整车本地布局（纯函数）。
 * 平台/托盘的「占位矩阵」始终按载荷尺寸计算；是否零缩放由 loaded 决定
 * （帧同步层读取），保持布局计算与可见性表达解耦。
 * 信标激活取投影主状态 === FAULT：投影已内含「FRESH + ONLINE」前提，
 * STALE/断连车的主状态不可能为 FAULT，警示灯随之熄灭（SPEC §5.2）。
 */
export function computeVehiclePartLayout(
  snapshot: VehicleSnapshot,
  displayState: VehicleDisplayState,
): VehiclePartLayout {
  const { length, width, loadLength, loadWidth } = snapshot.dimension
  const wedgeLen = wedgeLengthOf(length)
  const shellLen = length - wedgeLen
  const shellWidth = width * SHELL_WIDTH_RATIO
  // 纵向堆叠：离地间隙 → 底盘 → 外壳 → 平台 → 托盘（自下而上累加）
  const chassisBottom = CHASSIS_CLEARANCE_M
  const shellBottom = chassisBottom + CHASSIS_HEIGHT_M
  const platformBottom = shellBottom + SHELL_HEIGHT_M
  const palletBottom = platformBottom + PLATFORM_THICKNESS_M
  // 平台/托盘/信标在车长方向与外壳对中（外壳占据 −L/2 … L/2−楔长）
  const bodyCenterX = -wedgeLen / 2
  // 信标挂在车尾后方独立支架上：与载荷平台互不穿插，任何载荷形态都可见
  const beaconX = -length / 2 - BEACON_MOUNT_CLEARANCE_M
  const beaconY =
    platformBottom + Math.max(BEACON_DOME_HEIGHT_M, PLATFORM_THICKNESS_M + PALLET_HEIGHT_M) / 2

  const placement = (
    x: number,
    y: number,
    sx: number,
    sy: number,
    sz: number,
  ): PartPlacement => ({ x, y, z: 0, sx, sy, sz })

  return {
    visible: snapshot.positionValid && snapshot.dimensionValid,
    loaded: snapshot.loaded === true,
    beaconActive: displayState.primary === 'FAULT',
    chassis: placement(bodyCenterX, chassisBottom + CHASSIS_HEIGHT_M / 2, length, CHASSIS_HEIGHT_M, width),
    shell: placement(bodyCenterX, shellBottom + SHELL_HEIGHT_M / 2, shellLen, SHELL_HEIGHT_M, shellWidth),
    wedge: placement(
      length / 2 - wedgeLen / 2,
      shellBottom + SHELL_HEIGHT_M / 2,
      wedgeLen,
      SHELL_HEIGHT_M,
      shellWidth,
    ),
    platform: placement(
      bodyCenterX,
      platformBottom + PLATFORM_THICKNESS_M / 2,
      loadLength,
      PLATFORM_THICKNESS_M,
      loadWidth,
    ),
    pallet: placement(
      bodyCenterX,
      palletBottom + PALLET_HEIGHT_M / 2,
      loadLength * PALLET_LENGTH_RATIO,
      PALLET_HEIGHT_M,
      loadWidth * PALLET_WIDTH_RATIO,
    ),
    beacon: placement(beaconX, beaconY, 1, 1, 1),
    shadow: placement(
      bodyCenterX,
      VEHICLE_SHADOW_Y,
      length * VEHICLE_SHADOW_LENGTH_RATIO,
      1,
      width * VEHICLE_SHADOW_WIDTH_RATIO,
    ),
  }
}

/**
 * 车体中心的世界位姿（SPEC §2.5 唯一口径）：
 * 先在地图平面坐标合成 centerOffset 位移，再经 worldTransform 得世界坐标；
 * 旋转取 worldTransform 的角度换算（含仿射与符号翻转）。
 */
export function computeVehicleWorldPose(
  snapshot: VehicleSnapshot,
  worldTransform: WorldTransform,
): VehicleWorldPose {
  const { x, y, theta } = snapshot.position
  const offset = snapshot.dimension.centerOffset
  const centerX = x + offset * Math.cos(theta)
  const centerY = y + offset * Math.sin(theta)
  const world = worldTransform.toWorldXZ(centerX, centerY)
  return {
    cx: world.x,
    cz: world.z,
    rotY: worldTransform.angleToWorldYRotation(theta),
  }
}

/* ==================== 几何与材质工厂（批次间共享，单一所有者） ==================== */

/** 走实例颜色的部件（逐车差异色）；其余部件用固定材质色 */
export const INSTANCE_COLOR_PARTS: ReadonlySet<VehiclePartKind> = new Set([
  'shell',
  'wedge',
  'beacon',
])

/** 车辆渲染共用资源：四个几何 + 七份材质；由 Feature 根组件单一持有 */
export interface VehicleResources {
  /** 单位盒：底盘/外壳/平台/托盘共用（尺寸差异全在实例矩阵） */
  readonly box: THREE.BufferGeometry
  /** 方向楔：三角棱柱，鼻尖指向本地 +x */
  readonly wedge: THREE.BufferGeometry
  /** 警示信标：穹顶 + 扫掠叶片一体几何 */
  readonly beacon: THREE.BufferGeometry
  /** 假阴影：水平单位面片 */
  readonly shadow: THREE.BufferGeometry
  readonly chassisMaterial: THREE.MeshStandardMaterial
  /** 外壳材质：基础色为白，实际颜色全部来自实例颜色（主状态色） */
  readonly shellMaterial: THREE.MeshStandardMaterial
  readonly wedgeMaterial: THREE.MeshStandardMaterial
  readonly platformMaterial: THREE.MeshStandardMaterial
  readonly palletMaterial: THREE.MeshStandardMaterial
  /** 信标材质：不受光照（Unlit），闪烁亮度直接经实例颜色表达 */
  readonly beaconMaterial: THREE.MeshBasicMaterial
  readonly shadowMaterial: THREE.MeshBasicMaterial
  /** 幂等释放全部几何与材质（实例缓冲由 InstancedMesh.dispose 释放） */
  dispose(): void
}

/** 构建方向楔几何：单位三角棱柱（鼻尖 +0.5，尾部全宽），平面梯形侧面 */
function buildWedgeGeometry(): THREE.BufferGeometry {
  // 顶点（y ∈ [-0.5, 0.5]，底面/顶面为斜面，鼻尖在 +x）
  const nTop: [number, number, number] = [0.5, 0.5, 0]
  const nBot: [number, number, number] = [0.5, -0.5, 0]
  const aTop: [number, number, number] = [-0.5, 0.5, -0.5]
  const aBot: [number, number, number] = [-0.5, -0.5, -0.5]
  const bTop: [number, number, number] = [-0.5, 0.5, 0.5]
  const bBot: [number, number, number] = [-0.5, -0.5, 0.5]
  // 三角形按外法线右手定则绕序（见各面注释）
  const triangles: [number, number, number][][] = [
    [nTop, aTop, bTop], // 顶斜面 +y
    [nBot, bBot, aBot], // 底斜面 -y
    [aTop, aBot, bBot], // 尾面 -x（四边形 → 两三角）
    [aTop, bBot, bTop],
    [nTop, aBot, aTop], // z=-0.5 侧斜面
    [nTop, nBot, aBot],
    [nTop, bTop, bBot], // z=+0.5 侧斜面
    [nTop, bBot, nBot],
  ]
  const positions = new Float32Array(triangles.length * 9)
  let o = 0
  for (const tri of triangles) {
    for (const v of tri) {
      positions[o] = v[0]
      positions[o + 1] = v[1]
      positions[o + 2] = v[2]
      o += 3
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
}

/** 合并若干非索引几何的 position/normal/uv（信标穹顶 + 叶片用） */
function mergeGeometries(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = new THREE.BufferGeometry()
  for (const attribute of ['position', 'normal', 'uv'] as const) {
    const total = parts.reduce(
      (sum, part) => sum + (part.getAttribute(attribute)?.count ?? 0),
      0,
    )
    const itemSize = parts[0]?.getAttribute(attribute)?.itemSize ?? 3
    const array = new Float32Array(total * itemSize)
    let offset = 0
    for (const part of parts) {
      const source = part.getAttribute(attribute)
      if (source === undefined) {
        continue
      }
      array.set(source.array as Float32Array, offset)
      offset += source.array.length
    }
    merged.setAttribute(attribute, new THREE.BufferAttribute(array, itemSize))
  }
  return merged
}

/** 构建警示信标几何：中央穹顶（圆柱）+ 抬起的 +x 扫掠叶片（盒） */
function buildBeaconGeometry(): THREE.BufferGeometry {
  const dome = new THREE.CylinderGeometry(
    BEACON_DOME_RADIUS_M,
    BEACON_DOME_RADIUS_M,
    BEACON_DOME_HEIGHT_M,
    10,
  ).toNonIndexed()
  const tilt = 0.42
  const blade = new THREE.BoxGeometry(
    BEACON_BLADE_LENGTH_M,
    BEACON_BLADE_THICKNESS_M * 1.5,
    BEACON_BLADE_THICKNESS_M,
  )
  // 叶片绕 z 轴抬起后平移到穹顶外沿：绕扫掠轴留出可见的旋转力臂
  blade.rotateZ(tilt)
  blade.translate(
    BEACON_DOME_RADIUS_M + (BEACON_BLADE_LENGTH_M / 2) * Math.cos(tilt) - 0.01,
    (BEACON_BLADE_LENGTH_M / 2) * Math.sin(tilt),
    0,
  )
  const bladeNonIndexed = blade.toNonIndexed()
  const merged = mergeGeometries([dome, bladeNonIndexed])
  dome.dispose()
  blade.dispose()
  bladeNonIndexed.dispose()
  return merged
}

/** 构建全部共用几何与材质（一次调用对应一个所有者；dispose 幂等） */
export function createVehicleResources(): VehicleResources {
  const box = new THREE.BoxGeometry(1, 1, 1)
  const wedge = buildWedgeGeometry()
  const beacon = buildBeaconGeometry()
  const shadow = new THREE.PlaneGeometry(1, 1)
  shadow.rotateX(-Math.PI / 2)

  const chassisMaterial = new THREE.MeshStandardMaterial({
    color: CHASSIS_COLOR,
    metalness: CHASSIS_METALNESS,
    roughness: CHASSIS_ROUGHNESS,
  })
  // 基础色为白：最终颜色完全由实例颜色（主状态色）决定
  const shellMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    metalness: SHELL_METALNESS,
    roughness: SHELL_ROUGHNESS,
  })
  const wedgeMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    metalness: SHELL_METALNESS,
    roughness: SHELL_ROUGHNESS,
  })
  const platformMaterial = new THREE.MeshStandardMaterial({ color: PLATFORM_COLOR })
  const palletMaterial = new THREE.MeshStandardMaterial({ color: PALLET_COLOR })
  const beaconMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff })
  const shadowMaterial = new THREE.MeshBasicMaterial({
    color: VEHICLE_SHADOW_COLOR,
    transparent: true,
    opacity: VEHICLE_SHADOW_OPACITY,
    depthWrite: false,
  })

  let disposed = false
  return {
    box,
    wedge,
    beacon,
    shadow,
    chassisMaterial,
    shellMaterial,
    wedgeMaterial,
    platformMaterial,
    palletMaterial,
    beaconMaterial,
    shadowMaterial,
    dispose() {
      // 幂等：StrictMode 重复清理与地图恢复路径都安全
      if (disposed) {
        return
      }
      disposed = true
      box.dispose()
      wedge.dispose()
      beacon.dispose()
      shadow.dispose()
      chassisMaterial.dispose()
      shellMaterial.dispose()
      wedgeMaterial.dispose()
      platformMaterial.dispose()
      palletMaterial.dispose()
      beaconMaterial.dispose()
      shadowMaterial.dispose()
    },
  }
}
