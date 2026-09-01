/// <reference types="node" />
/*
 * 当前车辆在真实地图上的场景对齐集成测试（TASK-010 / A4、§2.3、§2.5）。
 *
 * 职责：从当前输入 json/map.json 与 json/vehicle.json 重新计算，验证当前
 *       单车经车辆几何路径（校验 → 派生 → 投影 → 世界位姿/部件布局）后与
 *       节点「1644」及上报朝向对齐；输入发生合法变化时直接更新本文件期望。
 * 边界：fleet-monitoring 与 map-visualization 互相禁止导入（核心 Feature
 *       互禁规则），跨两者的事实验证只能放在 app 组合层——本文件是
 *       TASK-010 「当前车辆与节点 1644 及方向对齐」验收项的落点。
 * 关键不变量（当前输入）：
 * 1. 车辆参考点与节点「1644」相距小于 1mm（当前输入约 0.000042m）；
 * 2. 车体中心 = 参考点沿车头方向平移 centerOffset=0.25（世界距离恒等）；
 * 3. 朝向 θ≈π：车体中心位于参考点世界 -x 侧（车头指向），rotation.y = -θ；
 * 4. 投影主状态 TRAFFIC_WAIT（FRESH）：车体可见、载货、信标熄灭；
 *    方向楔在本地 +x 侧，每车尺寸（1.8 × 0.7）进入部件矩阵。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createMapModel,
  validateMap,
  type MapModel,
} from '@/features/map-visualization'
import {
  computeVehiclePartLayout,
  computeVehicleWorldPose,
  deriveVehicleState,
  projectDisplayState,
  validateVehicle,
  type VehicleSnapshot,
} from '@/features/fleet-monitoring'

const MAP_JSON_PATH = path.resolve(process.cwd(), 'json/map.json')
const VEHICLE_JSON_PATH = path.resolve(process.cwd(), 'json/vehicle.json')

// 全文件共享同一份建模与校验结果（14.94MB 地图只解析一次）
const MODEL = createMapModel(validateMap(JSON.parse(readFileSync(MAP_JSON_PATH, 'utf8'))))
const RAW_VEHICLE: unknown = JSON.parse(readFileSync(VEHICLE_JSON_PATH, 'utf-8'))

/** 按名称查找节点（找不到即失败，不静默跳过） */
function nodeByName(mapModel: MapModel, name: string) {
  const node = mapModel.nodeList.find((candidate) => candidate.name === name)
  if (!node) {
    throw new Error(`地图中不存在名为「${name}」的节点`)
  }
  return node
}

/** 世界坐标距离 */
function distance(
  a: { x: number; z: number },
  b: { x: number; z: number },
): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

describe('当前车辆与地图场景对齐（json/vehicle.json × json/map.json，TASK-010）', () => {
  const { mapModel, worldTransform } = MODEL
  const node1644 = nodeByName(mapModel, '1644')

  // 当前单车：校验 → 派生 → FRESH 投影（组合层与 VehicleInstances 同一路径）
  const validated = validateVehicle(RAW_VEHICLE, mapModel.mapId)
  if (!validated.ok) {
    throw new Error('当前车辆夹具必须通过校验')
  }
  const snapshot: VehicleSnapshot = validated.snapshot
  const displayState = projectDisplayState(deriveVehicleState(snapshot), 'FRESH')
  const pose = computeVehicleWorldPose(snapshot, worldTransform)
  const layout = computeVehiclePartLayout(snapshot, displayState)

  it('车辆参考点与节点「1644」对齐：世界距离小于 1mm（当前输入约 0.000042m）', () => {
    expect(node1644.category).toBe('work')
    const nodeWorld = worldTransform.toWorldXZ(node1644.x, node1644.y)
    const referenceWorld = worldTransform.toWorldXZ(
      snapshot.position.x,
      snapshot.position.y,
    )
    expect(distance(referenceWorld, nodeWorld)).toBeLessThan(0.001)
  })

  it('车体中心 = 参考点沿车头方向平移 centerOffset=0.25，且 rotation.y = -θ', () => {
    const referenceWorld = worldTransform.toWorldXZ(
      snapshot.position.x,
      snapshot.position.y,
    )
    // centerOffset 沿车头轴：车体中心与参考点的世界距离恒等于偏移量
    expect(distance({ x: pose.cx, z: pose.cz }, referenceWorld)).toBeCloseTo(
      snapshot.dimension.centerOffset,
      9,
    )
    // 朝向符号唯一换算点：世界 rotation.y = -平面角（恒等仿射下）
    expect(pose.rotY).toBeCloseTo(
      worldTransform.angleToWorldYRotation(snapshot.position.theta),
      12,
    )
    // θ≈π（车头指向地图 -x）：车体中心必须在参考点的 -x 侧
    expect(snapshot.position.theta).toBeGreaterThan(Math.PI / 2)
    expect(pose.cx).toBeLessThan(referenceWorld.x)
  })

  it('FRESH 投影下部件布局语义：可见、载货、信标熄灭、方向楔在 +x 侧', () => {
    expect(displayState.primary).toBe('TRAFFIC_WAIT')
    expect(layout.visible).toBe(true)
    expect(layout.loaded).toBe(true)
    // TRAFFIC_WAIT 非 FAULT：警示灯熄灭（旋转闪烁仅故障车，SPEC §5.2）
    expect(layout.beaconActive).toBe(false)
    // 方向楔占据本地 +x 侧（车头），外壳在其后
    expect(layout.wedge.x).toBeGreaterThan(0)
    expect(layout.shell.x).toBeLessThan(layout.wedge.x)
  })

  it('每车尺寸进入部件矩阵：底盘/平台按 1.8 × 0.7，托盘按比例缩小', () => {
    expect(layout.chassis.sx).toBeCloseTo(snapshot.dimension.length, 12)
    expect(layout.chassis.sz).toBeCloseTo(snapshot.dimension.width, 12)
    expect(layout.platform.sx).toBeCloseTo(snapshot.dimension.loadLength, 12)
    expect(layout.platform.sz).toBeCloseTo(snapshot.dimension.loadWidth, 12)
    expect(layout.pallet.sx).toBeLessThan(layout.platform.sx)
    expect(layout.pallet.sz).toBeLessThan(layout.platform.sz)
  })
})
