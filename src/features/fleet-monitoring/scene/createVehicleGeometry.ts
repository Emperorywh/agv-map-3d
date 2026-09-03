/**
 * 通用程序化 AGV 几何与部件布局（SPEC §2.5、§5.2、§6.3；TASK-010）。
 *
 * 职责：三件事——
 * 1. 纯函数布局：从已校验快照计算九个部件（底盘/外壳/+x 方向箭头/载荷平台/
 *    托盘/载货纸箱/警示灯/四轮/车底假阴影）在车体本地系的中心与全尺寸，
 *    以及车体中心在世界系的位姿（§2.5 的 centerOffset 位移、rotation.y=+theta
 *    唯一口径，来自 worldTransform 的 Y 翻转映射）；
 * 2. 几何工厂：构建共用单位几何（盒、楔、信标、四轮、纸箱、阴影贴片）与
 *    部件材质，供全部批次共享（单一所有者 + 幂等 dispose）；
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
  CARGO_LENGTH_RATIO,
  CARGO_STACK_HEIGHT_M,
  CARGO_WIDTH_RATIO,
  CHASSIS_CLEARANCE_M,
  CHASSIS_HEIGHT_M,
  CHASSIS_METALNESS,
  CHASSIS_COLOR,
  CHASSIS_ROUGHNESS,
  CARGO_METALNESS,
  CARGO_COLOR,
  CARGO_ROUGHNESS,
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
  WHEEL_METALNESS,
  WHEEL_COLOR,
  WHEEL_OFFSET_X_M,
  WHEEL_OFFSET_Z_M,
  WHEEL_RADIUS_M,
  WHEEL_ROUGHNESS,
  WHEEL_THICKNESS_M,
} from './fleetAppearance'

/**
 * 车体部件种类（与 InstancedMesh 一一对应；每批次 9 个 Draw Call）。
 * P1-6：在七部件基础上新增 wheels（四轮，固定真实尺寸）与 cargo（载货纸
 * 箱，loaded 时显示）——视觉差距分析授权的 +2 部件，恢复 Reference 的
 * 「深色底盘 + 可见车轮 + 车顶载货」形态。
 */
export type VehiclePartKind =
  | 'chassis'
  | 'shell'
  | 'wedge'
  | 'platform'
  | 'pallet'
  | 'cargo'
  | 'beacon'
  | 'wheels'
  | 'shadow'

export const VEHICLE_PART_KINDS: readonly VehiclePartKind[] = [
  'chassis',
  'shell',
  'wedge',
  'platform',
  'pallet',
  'cargo',
  'beacon',
  'wheels',
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
  /** loadState === LOADED：决定平台/托盘/纸箱是真实矩阵还是零缩放 */
  readonly loaded: boolean
  /** 投影主状态为 FAULT：警示灯旋转闪烁；其余（含 OFFLINE/STALE）熄灭 */
  readonly beaconActive: boolean
  readonly chassis: PartPlacement
  readonly shell: PartPlacement
  readonly wedge: PartPlacement
  readonly platform: PartPlacement
  readonly pallet: PartPlacement
  readonly cargo: PartPlacement
  readonly beacon: PartPlacement
  /** 车轮：固定真实尺寸（scale 恒 1:1:1，同信标模式），四轮烘焙在一份几何 */
  readonly wheels: PartPlacement
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
  // 纵向堆叠：离地间隙 → 底盘 → 外壳 → 平台 → 托盘 → 纸箱（自下而上累加）
  const chassisBottom = CHASSIS_CLEARANCE_M
  const shellBottom = chassisBottom + CHASSIS_HEIGHT_M
  const platformBottom = shellBottom + SHELL_HEIGHT_M
  const palletBottom = platformBottom + PLATFORM_THICKNESS_M
  const palletTop = palletBottom + PALLET_HEIGHT_M
  // 平台/托盘/纸箱/信标在车长方向与外壳对中（外壳占据 −L/2 … L/2−楔长）
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
    cargo: placement(
      bodyCenterX,
      palletTop + CARGO_STACK_HEIGHT_M / 2,
      loadLength * CARGO_LENGTH_RATIO,
      CARGO_STACK_HEIGHT_M,
      loadWidth * CARGO_WIDTH_RATIO,
    ),
    beacon: placement(beaconX, beaconY, 1, 1, 1),
    // 车轮：固定真实尺寸的四轮几何，缩放恒 1（同信标的绝对尺寸模式）；
    // 中心高度 = 轮半径，轮底接地（geometry 内轮心位于 y=0）
    wheels: placement(bodyCenterX, WHEEL_RADIUS_M, 1, 1, 1),
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

/** 车辆渲染共用资源：六份几何 + 九份材质；由 Feature 根组件单一持有 */
export interface VehicleResources {
  /** 单位盒：底盘/外壳/平台/托盘共用（尺寸差异全在实例矩阵） */
  readonly box: THREE.BufferGeometry
  /** 方向箭头（P2-7）：细长箭头棱柱，鼻尖指向本地 +x */
  readonly wedge: THREE.BufferGeometry
  /** 警示信标：穹顶 + 扫掠叶片一体几何 */
  readonly beacon: THREE.BufferGeometry
  /** 四只车轮（P1-6）：固定真实尺寸，轮轴沿 z，轮心烘焙在 y=0 */
  readonly wheels: THREE.BufferGeometry
  /** 载货纸箱（P1-6）：单位空间两只不同高度的盒，footprint 随载荷缩放 */
  readonly cargo: THREE.BufferGeometry
  /** 假阴影：水平单位面片 */
  readonly shadow: THREE.BufferGeometry
  readonly chassisMaterial: THREE.MeshStandardMaterial
  /** 外壳材质：基础色为白，实际颜色全部来自实例颜色（主状态色） */
  readonly shellMaterial: THREE.MeshStandardMaterial
  readonly wedgeMaterial: THREE.MeshStandardMaterial
  readonly platformMaterial: THREE.MeshStandardMaterial
  readonly palletMaterial: THREE.MeshStandardMaterial
  readonly cargoMaterial: THREE.MeshStandardMaterial
  /** 信标材质：不受光照（Unlit），闪烁亮度直接经实例颜色表达 */
  readonly beaconMaterial: THREE.MeshBasicMaterial
  readonly wheelMaterial: THREE.MeshStandardMaterial
  readonly shadowMaterial: THREE.MeshBasicMaterial
  /** 幂等释放全部几何与材质（实例缓冲由 InstancedMesh.dispose 释放） */
  dispose(): void
}

/**
 * 构建方向箭头几何（P2-7，替代原方向楔三角棱柱）：单位空间内的细长箭头
 * 棱柱——鼻尖在 +x（0.5, 0）、两翼在尾部全宽（−0.5, ±0.5）、尾部中央凹口
 * （−0.15, 0）形成「➤」轮廓，俯视即可读出车行方向。顶/底面为凹四边形
 * （从鼻尖扇形三角化），四条轮廓边各一块侧面；顶点不共享面 → 平面着色。
 */
function buildWedgeGeometry(): THREE.BufferGeometry {
  // 轮廓顶点（xz 平面，绕行一周；y ∈ [-0.5, 0.5] 挤出）
  const tipX = 0.5
  const wingX = -0.5
  const notchX = -0.15
  const wingZ = 0.5
  const outline: ReadonlyArray<readonly [number, number]> = [
    [tipX, 0],
    [wingX, wingZ],
    [notchX, 0],
    [wingX, -wingZ],
  ]
  const yTop = 0.5
  const yBottom = -0.5

  const positions: number[] = []
  const pushTriangle = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ): void => {
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz)
  }

  // 顶/底面：凹四边形从鼻尖扇形三角化——轮廓序（tip→+z 翼→凹口→−z 翼）下
  // (tip, 后点, 前点) 的叉积朝 +y，底面取反绕序
  for (let i = 1; i < outline.length - 1; i += 1) {
    const [ax, az] = outline[i]
    const [bx, bz] = outline[i + 1]
    pushTriangle(tipX, yTop, 0, bx, yTop, bz, ax, yTop, az)
    pushTriangle(tipX, yBottom, 0, ax, yBottom, az, bx, yBottom, bz)
  }
  // 侧面：每条轮廓边一块竖直四边形（两三角），绕序朝外法线
  for (let i = 0; i < outline.length; i += 1) {
    const [ax, az] = outline[i]
    const [bx, bz] = outline[(i + 1) % outline.length]
    pushTriangle(ax, yTop, az, bx, yTop, bz, bx, yBottom, bz)
    pushTriangle(ax, yTop, az, bx, yBottom, bz, ax, yBottom, az)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
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

/**
 * 构建四只车轮的合并几何（P1-6）：单位圆柱（轴 y）旋转到轮轴 z，缩放到
 * 真实尺寸（半径 WHEEL_RADIUS_M、厚 WHEEL_THICKNESS_M）后平移到四个轮位。
 * 与信标同属「固定真实尺寸」模式——不随车体缩放，布局侧 scale 恒 1:1:1，
 * 轮心烘焙在 y=0（布局给 y = 轮半径即接地）。
 */
function buildWheelsGeometry(): THREE.BufferGeometry {
  const unitWheel = new THREE.CylinderGeometry(0.5, 0.5, 1, 14).toNonIndexed()
  unitWheel.rotateX(Math.PI / 2)
  const parts: THREE.BufferGeometry[] = []
  for (const x of [-WHEEL_OFFSET_X_M, WHEEL_OFFSET_X_M]) {
    for (const z of [-WHEEL_OFFSET_Z_M, WHEEL_OFFSET_Z_M]) {
      const wheel = unitWheel.clone()
      wheel.scale(WHEEL_RADIUS_M * 2, WHEEL_RADIUS_M * 2, WHEEL_THICKNESS_M)
      wheel.translate(x, 0, z)
      parts.push(wheel)
    }
  }
  const merged = mergeGeometries(parts)
  unitWheel.dispose()
  for (const part of parts) {
    part.dispose()
  }
  return merged
}

/**
 * 构建载货纸箱的合并几何（P1-6）：单位空间内两只不同高度的盒（大箱左、
 * 小箱右，均落在单位盒底 y=−0.5 上），footprint 由实例矩阵按载荷尺寸缩放，
 * 堆叠高度 = CARGO_STACK_HEIGHT_M × 单位高度比例。
 */
function buildCargoGeometry(): THREE.BufferGeometry {
  const boxA = new THREE.BoxGeometry(0.76, 0.75, 0.94).toNonIndexed()
  boxA.translate(-0.11, -0.125, 0)
  const boxB = new THREE.BoxGeometry(0.2, 0.5, 0.6).toNonIndexed()
  boxB.translate(0.39, -0.25, -0.12)
  const merged = mergeGeometries([boxA, boxB])
  boxA.dispose()
  boxB.dispose()
  return merged
}

/** 构建全部共用几何与材质（一次调用对应一个所有者；dispose 幂等） */
export function createVehicleResources(): VehicleResources {
  const box = new THREE.BoxGeometry(1, 1, 1)
  const wedge = buildWedgeGeometry()
  const beacon = buildBeaconGeometry()
  const wheels = buildWheelsGeometry()
  const cargo = buildCargoGeometry()
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
  const cargoMaterial = new THREE.MeshStandardMaterial({
    color: CARGO_COLOR,
    metalness: CARGO_METALNESS,
    roughness: CARGO_ROUGHNESS,
  })
  const beaconMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff })
  const wheelMaterial = new THREE.MeshStandardMaterial({
    color: WHEEL_COLOR,
    metalness: WHEEL_METALNESS,
    roughness: WHEEL_ROUGHNESS,
  })
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
    wheels,
    cargo,
    shadow,
    chassisMaterial,
    shellMaterial,
    wedgeMaterial,
    platformMaterial,
    palletMaterial,
    cargoMaterial,
    beaconMaterial,
    wheelMaterial,
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
      wheels.dispose()
      cargo.dispose()
      shadow.dispose()
      chassisMaterial.dispose()
      shellMaterial.dispose()
      wedgeMaterial.dispose()
      platformMaterial.dispose()
      palletMaterial.dispose()
      cargoMaterial.dispose()
      beaconMaterial.dispose()
      wheelMaterial.dispose()
      shadowMaterial.dispose()
    },
  }
}
