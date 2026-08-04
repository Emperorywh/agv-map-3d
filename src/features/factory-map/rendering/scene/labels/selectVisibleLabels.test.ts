/**
 * selectVisibleLabels 单元测试（SPEC §15.1 selectVisibleLabels 行、§8.3、§9.3、§10.1）。
 *
 * 覆盖：三类迟滞进出阈值、视锥过滤（迟滞状态与视锥无关）、不透明厂房遮挡
 * （玻璃不遮挡的机制、遮挡射线终点高度 0.5m、锚点后方不遮挡）、类别内与
 * 补足段稳定排序、保留名额 120/120/60 与补足、全局 ≤300、reset、out 复用、
 * attach/detach 差分、重算调度（0.25m/0.25°/10Hz/停止终算/forceRecalc）、
 * 基准地图初始全景无标签（§8.3 末条明确设计）与 35m 近景出现。
 *
 * 相机为真实 three PerspectiveCamera（node 环境可投影）；遮挡使用真实
 * BoxGeometry mesh 与 three Raycaster；时间源注入假时钟（§15.1 不依赖系统时间）。
 */

import { readFileSync } from 'node:fs'

import { BoxGeometry, Mesh, MeshStandardMaterial, PerspectiveCamera, Quaternion, Vector3 } from 'three'
import type { Object3D } from 'three'
import { describe, expect, it } from 'vitest'

import type { LabelCategory, LabelMetadataDto } from '../../../application/factorySceneModel'
import { CAMERA_FAR, CAMERA_FOV, CAMERA_NEAR } from '../../../config/cameraConfig'
import {
  LABEL_ANCHOR_Y,
  LABEL_CAMERA_ANGLE_DELTA_DEG,
  LABEL_CAMERA_POS_DELTA,
  LABEL_MAX_COUNT,
  LABEL_RECALC_MAX_HZ,
  LABEL_RESERVED_NODE,
  LABEL_RESERVED_PATH,
  LABEL_RESERVED_STATION,
  STATION_ENTER,
} from '../../../config/labelPolicy'
import { buildFactorySceneModel } from '../../../infrastructure/worker/builders/buildFactorySceneModel'
import type { SceneBuildOptions } from '../../../infrastructure/worker/builders/buildFactorySceneModel'
import { fitPerspectiveCamera } from '../../core/fitPerspectiveCamera'
import {
  createLabelRecalcScheduler,
  createLabelSelectionDiffer,
  createVisibleLabelSelector,
} from './selectVisibleLabels'
import type { VisibleLabelSelector } from './selectVisibleLabels'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function makeLabel(
  id: string,
  category: LabelCategory,
  x: number,
  z: number,
  y: number = LABEL_ANCHOR_Y,
): LabelMetadataDto {
  return { id, category, text: `标签${id}`, worldPosition: [x, y, z] }
}

/** 真实透视相机：位于 eye 直视 target（16:9 画幅，§9.1 参数） */
function makeCameraFacing(
  ex: number, ey: number, ez: number,
  tx: number, ty: number, tz: number,
): PerspectiveCamera {
  const camera = new PerspectiveCamera(CAMERA_FOV, 16 / 9, CAMERA_NEAR, CAMERA_FAR)
  camera.position.set(ex, ey, ez)
  camera.up.set(0, 1, 0)
  camera.lookAt(tx, ty, tz)
  return camera
}

/** 相机位于 (0,0.5,d) 直视原点锚点：标签距离恰为 d 且位于视锥中心 */
const camAt = (d: number): PerspectiveCamera => makeCameraFacing(0, 0.5, d, 0, 0.5, 0)

/** 原点相机直视 -z：网格夹具用 */
const originCamera = (): PerspectiveCamera => makeCameraFacing(0, 0.5, 0, 0, 0.5, -100)

function selectAll(
  selector: VisibleLabelSelector,
  labels: readonly LabelMetadataDto[],
  camera: PerspectiveCamera,
): LabelMetadataDto[] {
  const out: LabelMetadataDto[] = new Array(LABEL_MAX_COUNT)
  const count = selector.select(labels, camera, out)
  return out.slice(0, count)
}

const ids = (labels: readonly LabelMetadataDto[]): string[] => labels.map((label) => label.id)

function countByCategory(labels: readonly LabelMetadataDto[]): Record<LabelCategory, number> {
  const counts: Record<LabelCategory, number> = { station: 0, node: 0, path: 0 }
  for (const label of labels) counts[label.category] += 1
  return counts
}

/** 真实遮挡 mesh（闭合盒体：与 §6 实墙/墙柱/主梁/檩条同形态），世界矩阵即时更新 */
function makeBoxOccluder(
  sizeX: number, sizeY: number, sizeZ: number,
  x: number, y: number, z: number,
): Mesh {
  const mesh = new Mesh(new BoxGeometry(sizeX, sizeY, sizeZ), new MeshStandardMaterial())
  mesh.position.set(x, y, z)
  mesh.updateMatrixWorld(true)
  return mesh
}

const NO_OCCLUDERS: readonly Object3D[] = []

/**
 * 面向 -z 的网格标签（相机位于原点直视 -z 时全部处于视锥内且距离 ≤ 进入阈值）：
 * x ∈ [-xMax, xMax] 步长 xStep，z ∈ [zNear 负值 .. zFar 负值] 步长 zStep。
 */
function gridLabels(
  prefix: string,
  category: LabelCategory,
  xMax: number,
  xStep: number,
  zNear: number,
  zFar: number,
  zStep: number,
): LabelMetadataDto[] {
  const labels: LabelMetadataDto[] = []
  let index = 0
  // 整数索引避免浮点累计误差影响行列数
  const cols = Math.floor((2 * xMax) / xStep + 1e-9) + 1
  const rows = Math.floor((zNear - zFar) / zStep + 1e-9) + 1
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      labels.push(makeLabel(`${prefix}${index}`, category, -xMax + col * xStep, zNear - row * zStep))
      index += 1
    }
  }
  return labels
}

// ---------------------------------------------------------------------------
// §8.3 三类距离迟滞
// ---------------------------------------------------------------------------

describe('距离迟滞（§8.3：三类进入/退出阈值）', () => {
  it('站点：≤90m 进入、>95m 退出、迟滞带 (90,95] 内保持原状态', () => {
    const selector = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    const label = makeLabel('node:s1', 'station', 0, 0)
    // 初次出现在迟滞带（92m）：从未进入 → 不选中
    expect(selectAll(selector, [label], camAt(92))).toEqual([])
    // ≤90 进入（边界含等号）
    expect(ids(selectAll(selector, [label], camAt(90)))).toEqual(['node:s1'])
    // 迟滞带内保持选中（退出边界 95 含等号）
    expect(ids(selectAll(selector, [label], camAt(95)))).toEqual(['node:s1'])
    // >95 退出
    expect(selectAll(selector, [label], camAt(95.0001))).toEqual([])
    // 退出后回到迟滞带：未再次 ≤90 → 不重新进入
    expect(selectAll(selector, [label], camAt(94))).toEqual([])
    // 回到 ≤90 重新进入
    expect(ids(selectAll(selector, [label], camAt(90)))).toEqual(['node:s1'])
  })

  it('普通节点：≤40m 进入、>44m 退出、迟滞带 (40,44] 内保持原状态', () => {
    const selector = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    const label = makeLabel('node:n1', 'node', 0, 0)
    expect(selectAll(selector, [label], camAt(42))).toEqual([])
    expect(ids(selectAll(selector, [label], camAt(40)))).toEqual(['node:n1'])
    expect(ids(selectAll(selector, [label], camAt(44)))).toEqual(['node:n1'])
    expect(selectAll(selector, [label], camAt(44.0001))).toEqual([])
    expect(selectAll(selector, [label], camAt(43))).toEqual([])
    expect(ids(selectAll(selector, [label], camAt(40)))).toEqual(['node:n1'])
  })

  it('路径：≤25m 进入、>28m 退出、迟滞带 (25,28] 内保持原状态', () => {
    const selector = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    const label = makeLabel('edge:e1', 'path', 0, 0)
    expect(selectAll(selector, [label], camAt(27))).toEqual([])
    expect(ids(selectAll(selector, [label], camAt(25)))).toEqual(['edge:e1'])
    expect(ids(selectAll(selector, [label], camAt(28)))).toEqual(['edge:e1'])
    expect(selectAll(selector, [label], camAt(28.0001))).toEqual([])
    expect(selectAll(selector, [label], camAt(26))).toEqual([])
    expect(ids(selectAll(selector, [label], camAt(25)))).toEqual(['edge:e1'])
  })

  it('reset 清空迟滞状态：地图变更后按「从未进入」重新判定（§8.3 地图变化重算）', () => {
    const selector = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    const label = makeLabel('node:n1', 'node', 0, 0)
    selectAll(selector, [label], camAt(30))
    expect(ids(selectAll(selector, [label], camAt(43)))).toEqual(['node:n1'])
    selector.reset()
    expect(selectAll(selector, [label], camAt(43))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// §8.3 视锥过滤
// ---------------------------------------------------------------------------

describe('视锥过滤（§8.3）', () => {
  it('相机背后的标签不选中；迟滞状态仍按距离逐次更新（与视锥无关）', () => {
    const selector = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    const label = makeLabel('node:n1', 'node', 0, 0)
    // 相机背对标签（朝 +z 看）：距离 30m ≤ 40 但视锥外 → 不选中
    const away = makeCameraFacing(0, 0.5, 30, 0, 0.5, 100)
    expect(selectAll(selector, [label], away)).toEqual([])
    // 转向标签、距离 41m 处于 (40,44] 迟滞带：先前 30m 已进入 → 选中
    // （证明迟滞状态在视锥外的重算中仍按距离更新）
    expect(ids(selectAll(selector, [label], camAt(41)))).toEqual(['node:n1'])
  })

  it('横向超出半视角的标签不选中，转入视锥后选中', () => {
    const selector = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    // 距离 √(50²+30²)≈58.3 ≤ 90（站点进入），但横向角 atan(50/30)≈59° 超出水平半视角
    const label = makeLabel('node:s1', 'station', 50, 0)
    const facing = makeCameraFacing(0, 0.5, 30, 0, 0.5, 0)
    expect(selectAll(selector, [label], facing)).toEqual([])
    const turned = makeCameraFacing(0, 0.5, 30, 50, 0.5, 0)
    expect(ids(selectAll(selector, [label], turned))).toEqual(['node:s1'])
  })
})

// ---------------------------------------------------------------------------
// §8.3/§9.3 不透明厂房遮挡
// ---------------------------------------------------------------------------

describe('不透明厂房遮挡（§8.3/§9.3）', () => {
  it('视线被实墙类几何阻断的标签跳过，无遮挡标签保留', () => {
    const wall = makeBoxOccluder(4, 8, 0.2, 0, 4, 10)
    const selector = createVisibleLabelSelector({ occluders: [wall] })
    const blocked = makeLabel('node:b1', 'node', 0, 0)
    const clear = makeLabel('node:c1', 'node', 5, 0)
    const camera = makeCameraFacing(0, 0.5, 20, 2.5, 0.5, 0)
    expect(ids(selectAll(selector, [blocked, clear], camera))).toEqual(['node:c1'])
  })

  it('玻璃不遮挡的机制：只有 occluders 引用列表内的几何参与遮挡判定', () => {
    // 同一块几何不传入列表即不遮挡（§9.3：玻璃不在 labelOccluders 中；
    // 选择器不接触场景根 group，仅逐个 raycast 列表引用）
    const glassLikeWall = makeBoxOccluder(4, 8, 0.2, 0, 4, 10)
    const label = makeLabel('node:n1', 'node', 0, 0)
    const camera = camAt(20)
    const withoutGlass = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    expect(ids(selectAll(withoutGlass, [label], camera))).toEqual(['node:n1'])
    const withOpaque = createVisibleLabelSelector({ occluders: [glassLikeWall] })
    expect(selectAll(withOpaque, [label], camera)).toEqual([])
  })

  it('遮挡射线终点高度 = 锚点 LABEL_ANCHOR_Y=0.5m：低于锚点的障碍不遮挡，高于则遮挡', () => {
    expect(LABEL_ANCHOR_Y).toBe(0.5) // §13.2
    const label = makeLabel('node:n1', 'node', 0, 0) // 锚点 y=0.5（元数据携带）
    const camera = camAt(20) // 水平视线 y=0.5
    // 顶面 y=0.4 < 0.5：射线从障碍上方通过 → 不遮挡
    const low = makeBoxOccluder(4, 0.4, 4, 0, 0.2, 10)
    const lowSelector = createVisibleLabelSelector({ occluders: [low] })
    expect(ids(selectAll(lowSelector, [label], camera))).toEqual(['node:n1'])
    // 顶面 y=0.6 > 0.5：射线终点高度被覆盖 → 遮挡
    const high = makeBoxOccluder(4, 0.6, 4, 0, 0.3, 10)
    const highSelector = createVisibleLabelSelector({ occluders: [high] })
    expect(selectAll(highSelector, [label], camera)).toEqual([])
  })

  it('射线终点在锚点：锚点后方的几何不遮挡（far = 相机到锚点距离）', () => {
    const behind = makeBoxOccluder(4, 8, 0.2, 0, 4, -5)
    const selector = createVisibleLabelSelector({ occluders: [behind] })
    const label = makeLabel('node:n1', 'node', 0, 0)
    expect(ids(selectAll(selector, [label], camAt(20)))).toEqual(['node:n1'])
  })

  it('保留阶段遇遮挡跳过并继续该类后续候选；被遮挡候选不进入补足池', () => {
    // 143 个站点网格，x=0 整列（13 个）被 z=-12.5 的窄墙遮挡
    // （墙宽 0.5m：仅 x=0 列的射线穿过，|x|≥3 列的射线全部从墙侧掠过）
    const stations = gridLabels('node:s', 'station', 15, 3, -25, -85, 5)
    expect(stations.length).toBe(143)
    const wall = makeBoxOccluder(0.5, 8, 0.2, 0, 4, -12.5)
    const selector = createVisibleLabelSelector({ occluders: [wall] })
    const result = selectAll(selector, stations, originCamera())
    // 143 - 13 = 130 全部选中：保留名额由后续候选递补，
    // 且全局容量有余（170 空位）时被遮挡候选仍不出现 → 不进入补足池
    expect(result.length).toBe(130)
    const occludedColumn = stations
      .filter((label) => label.worldPosition[0] === 0)
      .map((label) => label.id)
    expect(occludedColumn.length).toBe(13)
    for (const id of occludedColumn) expect(ids(result)).not.toContain(id)
  })
})

// ---------------------------------------------------------------------------
// §8.3 排序、保留名额、补足与全局上限
// ---------------------------------------------------------------------------

describe('稳定排序与名额（§8.3）', () => {
  it('类别内按 (distanceSquared, id) 稳定排序：近者优先，等距按 id 字典序（与输入顺序无关）', () => {
    const selector = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    const camera = makeCameraFacing(0, 0.5, 60, 0, 0.5, 0)
    const far = makeLabel('node:far', 'station', 0, 0) // 距离 60
    const near = makeLabel('node:near', 'station', 0, 30) // 距离 30
    const tieB = makeLabel('node:z', 'station', 4, 50) // 距离 √(16+100)≈10.77
    const tieA = makeLabel('node:m', 'station', -4, 50) // 与 tieB 等距
    // 输入故意逆序
    const result = selectAll(selector, [far, tieB, near, tieA], camera)
    expect(ids(result)).toEqual(['node:m', 'node:z', 'node:near', 'node:far'])
  })

  it('保留名额 120/120/60：三类足额候选下全局恰好 300', () => {
    expect(LABEL_RESERVED_STATION).toBe(120)
    expect(LABEL_RESERVED_NODE).toBe(120)
    expect(LABEL_RESERVED_PATH).toBe(60)
    expect(LABEL_MAX_COUNT).toBe(300)
    const stations = gridLabels('node:s', 'station', 15, 3, -25, -85, 5) // 143
    const nodes = gridLabels('node:n', 'node', 9, 2, -14, -38, 2) // 130
    const paths = gridLabels('edge:p', 'path', 6, 2, -10, -24, 1.75) // 63
    expect(stations.length).toBe(143)
    expect(nodes.length).toBe(130)
    expect(paths.length).toBe(63)
    const selector = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    const result = selectAll(selector, [...stations, ...nodes, ...paths], originCamera())
    expect(result.length).toBe(LABEL_MAX_COUNT)
    expect(countByCategory(result)).toEqual({ station: 120, node: 120, path: 60 })
  })

  it('补足：类别不足额时空余容量由其他类别剩余候选按规则填满', () => {
    const stations = gridLabels('node:s', 'station', 15, 3, -25, -85, 5).slice(0, 100)
    const nodes = gridLabels('node:n', 'node', 9, 2, -14, -38, 2) // 130
    const paths = gridLabels('edge:p', 'path', 6, 2, -10, -24, 1.75).slice(0, 10)
    const selector = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    const result = selectAll(selector, [...stations, ...nodes, ...paths], originCamera())
    // 保留：100 站点 + 120 节点 + 10 路径 = 230；补足：70 空位吸收 10 个剩余节点
    expect(result.length).toBe(240)
    expect(countByCategory(result)).toEqual({ station: 100, node: 130, path: 10 })
  })

  it('补足段按 (distanceSquared, category, id) 稳定排序：距离优先于类别次序', () => {
    // 121 站点 + 61 路径：保留 120+60=180，补足候选 = 最远 1 站点（≈76m）+ 最远 1 路径（≈24m）
    const stations = gridLabels('node:s', 'station', 15, 3, -25, -85, 5).slice(0, 121)
    const paths = gridLabels('edge:p', 'path', 6, 2, -10, -24, 1.75).slice(0, 61)
    const selector = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    const result = selectAll(selector, [...stations, ...paths], originCamera())
    expect(result.length).toBe(182)
    // 补足段：路径（≈24m）虽然类别次序靠后，但距离更近 → 排在站点（≈76m）前
    expect(result[180].category).toBe('path')
    expect(result[181].category).toBe('station')
  })

  it('补足段等距时按类别次序决胜：node 先于 path', () => {
    // 121 节点（120 个 <25m + 1 个恰 25m）与 61 路径（60 个 <25m + 1 个恰 25m）
    const nodes = gridLabels('node:n', 'node', 6, 1.5, -10, -22, 1) // 9 列 × 13 行 = 117
    nodes.push(
      makeLabel('node:extra1', 'node', 1, -23),
      makeLabel('node:extra2', 'node', -1, -23),
      makeLabel('node:extra3', 'node', 2, -23),
      makeLabel('node:x', 'node', 0, -25), // 距离 25：唯一补足节点
    )
    expect(nodes.length).toBe(121)
    const paths = gridLabels('edge:p', 'path', 4, 1, -10, -15.4, 0.9).slice(0, 60)
    paths.push(makeLabel('edge:x', 'path', 0, -25)) // 距离 25：唯一补足路径
    expect(paths.length).toBe(61)
    const selector = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    const result = selectAll(selector, [...nodes, ...paths], originCamera())
    expect(result.length).toBe(182)
    // 两个补足候选等距（d²=625）：类别次序 node(1) < path(2)
    expect(result[180].id).toBe('node:x')
    expect(result[181].id).toBe('edge:x')
  })

  it('全局硬上限 300：单一类别 336 个足额候选也只选中 300', () => {
    const stations = gridLabels('node:s', 'station', 15, 2, -25, -85, 3) // 16 列 × 21 行 = 336
    expect(stations.length).toBe(336)
    const selector = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    const result = selectAll(selector, stations, originCamera())
    expect(result.length).toBe(LABEL_MAX_COUNT)
    // 保留 120 + 补足 180；全部按距离升序 → 最远的 36 个落选
    const distances = result.map((label) => {
      const [x, , z] = label.worldPosition
      return Math.sqrt(x * x + z * z)
    })
    expect(Math.max(...distances)).toBeLessThanOrEqual(90)
  })

  it('重算复用调用方 out 缓冲（§10.1）：同一数组覆写，结果与首次一致', () => {
    const selector = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    const labels = gridLabels('node:s', 'station', 15, 3, -25, -85, 5)
    const camera = originCamera()
    const out: LabelMetadataDto[] = new Array(LABEL_MAX_COUNT)
    const countA = selector.select(labels, camera, out)
    const snapshot = out.slice(0, countA)
    const countB = selector.select(labels, camera, out)
    expect(countB).toBe(countA)
    expect(out.length).toBe(LABEL_MAX_COUNT) // out 结构不变，仅就地覆写
    expect(out.slice(0, countB)).toEqual(snapshot)
  })

  it('候选集收缩的重算：桶/补足池旧槽沉底不参与结果（内部复用数组无残留）', () => {
    const selector = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    const camera = originCamera()
    // 第一次重算：143 站点 + 63 路径 → 桶与补足池均有大量候选
    const stations = gridLabels('node:s', 'station', 15, 3, -25, -85, 5)
    const paths = gridLabels('edge:p', 'path', 6, 2, -10, -24, 1.75)
    const first = selectAll(selector, [...stations, ...paths], camera)
    expect(countByCategory(first)).toEqual({ station: 143, node: 0, path: 63 })
    // 第二次重算（同一选择器）：候选集收缩 → 旧代槽位必须沉底，不得混入结果
    const fewStations = stations.slice(0, 3)
    const second = selectAll(selector, fewStations, camera)
    expect(ids(second).sort()).toEqual(ids(fewStations).sort())
    // 第三次重算：候选集重新扩张，复用的内部数组仍正确
    const third = selectAll(selector, [...stations, ...paths], camera)
    expect(countByCategory(third)).toEqual({ station: 143, node: 0, path: 63 })
  })

  it('比较器全序完备：等距同 id 的完全并列返回 0（排序稳定，不抛错）', () => {
    // label id 全局唯一由 §5.1 transfer 断言保证；选择器面对契约外重复 id
    // 时比较器仍须构成全序（返回 0），不得产生未定义排序行为
    const selector = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    const dupA = makeLabel('node:dup', 'station', 0, -30)
    const dupB = makeLabel('node:dup', 'station', 0, -30)
    const other = makeLabel('node:other', 'station', 0, -40)
    const result = selectAll(selector, [dupA, dupB, other], originCamera())
    expect(result.length).toBe(3)
    expect(ids(result).slice(0, 2)).toEqual(['node:dup', 'node:dup'])
    expect(result[2].id).toBe('node:other')
  })

  it('空标签集：返回 0', () => {
    const selector = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    expect(selectAll(selector, [], originCamera())).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// §8.3 attach/detach 差分
// ---------------------------------------------------------------------------

describe('createLabelSelectionDiffer（§8.3：attach/detach 仅变化项）', () => {
  const a = makeLabel('node:a', 'node', 0, 0)
  const b = makeLabel('node:b', 'node', 1, 0)
  const c = makeLabel('node:c', 'node', 2, 0)
  const d = makeLabel('node:d', 'node', 3, 0)

  function diffOnce(
    previous: LabelMetadataDto[],
    next: LabelMetadataDto[],
  ): { attach: LabelMetadataDto[], detach: string[] } {
    const differ = createLabelSelectionDiffer()
    const attachOut: LabelMetadataDto[] = new Array(LABEL_MAX_COUNT)
    const detachOut: string[] = new Array(LABEL_MAX_COUNT)
    const result = differ.diff(previous, previous.length, next, next.length, attachOut, detachOut)
    return {
      attach: attachOut.slice(0, result.attachCount),
      detach: detachOut.slice(0, result.detachCount),
    }
  }

  it('新进 attach、退出 detach、保留项不出现在差分中', () => {
    const { attach, detach } = diffOnce([a, b, c], [b, d])
    expect(attach).toEqual([d])
    expect(detach).toEqual(['node:a', 'node:c']) // 退出按上次选中顺序
  })

  it('集合不变：attach/detach 均为空（不清空重建 DOM）', () => {
    const { attach, detach } = diffOnce([a, b], [b, a])
    expect(attach).toEqual([])
    expect(detach).toEqual([])
  })

  it('首次选中（上次为空）：全部 attach；清空（本次为空）：全部 detach', () => {
    const first = diffOnce([], [a, b])
    expect(first.attach).toEqual([a, b])
    expect(first.detach).toEqual([])
    const cleared = diffOnce([a, b], [])
    expect(cleared.attach).toEqual([])
    expect(cleared.detach).toEqual(['node:a', 'node:b'])
  })

  it('返回对象为内部复用引用，逐次就地覆写（§10.1 无逐次分配）', () => {
    const differ = createLabelSelectionDiffer()
    const attachOut: LabelMetadataDto[] = new Array(LABEL_MAX_COUNT)
    const detachOut: string[] = new Array(LABEL_MAX_COUNT)
    const first = differ.diff([], 0, [a], 1, attachOut, detachOut)
    const second = differ.diff([a], 1, [b], 1, attachOut, detachOut)
    expect(second).toBe(first)
    expect(second.attachCount).toBe(1)
    expect(second.detachCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// §8.3/§5.2 重算时机调度
// ---------------------------------------------------------------------------

describe('createLabelRecalcScheduler（§8.3：阈值/10Hz/停止终算/强制重算）', () => {
  const q0 = (): Quaternion => new Quaternion()
  const rotY = (degrees: number): Quaternion =>
    new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (degrees * Math.PI) / 180)

  function makeScheduler(): { scheduler: ReturnType<typeof createLabelRecalcScheduler>, setTime: (t: number) => void } {
    let time = 0
    return {
      scheduler: createLabelRecalcScheduler({ now: () => time }),
      setTime: (t: number) => {
        time = t
      },
    }
  }

  it('阈值常量钉死：0.25m / 0.25° / 10Hz（§13.2）', () => {
    expect(LABEL_CAMERA_POS_DELTA).toBe(0.25)
    expect(LABEL_CAMERA_ANGLE_DELTA_DEG).toBe(0.25)
    expect(LABEL_RECALC_MAX_HZ).toBe(10)
  })

  it('首次调用无条件重算；亚阈值位姿变化不重算', () => {
    const { scheduler, setTime } = makeScheduler()
    expect(scheduler.onFrame(new Vector3(0, 0, 0), q0())).toBe(true)
    setTime(1000)
    expect(scheduler.onFrame(new Vector3(0.24, 0, 0), q0())).toBe(false)
    expect(scheduler.onFrame(new Vector3(0.24, 0, 0), rotY(0.24))).toBe(false)
  })

  it('位移 ≥0.25m（含边界）触发重算', () => {
    const { scheduler, setTime } = makeScheduler()
    expect(scheduler.onFrame(new Vector3(0, 0, 0), q0())).toBe(true)
    setTime(1000)
    expect(scheduler.onFrame(new Vector3(0.25, 0, 0), q0())).toBe(true)
  })

  it('朝向变化 ≥0.25° 触发重算（位移为 0）', () => {
    const { scheduler, setTime } = makeScheduler()
    expect(scheduler.onFrame(new Vector3(0, 0, 0), q0())).toBe(true)
    setTime(1000)
    expect(scheduler.onFrame(new Vector3(0, 0, 0), rotY(0.251))).toBe(true)
  })

  it('阻尼运动期最多 10Hz：间隔不足 100ms 的显著变化被节流', () => {
    const { scheduler, setTime } = makeScheduler()
    setTime(0)
    expect(scheduler.onFrame(new Vector3(0, 0, 0), q0())).toBe(true)
    setTime(50)
    expect(scheduler.onFrame(new Vector3(1, 0, 0), q0())).toBe(false)
    setTime(99)
    expect(scheduler.onFrame(new Vector3(2, 0, 0), q0())).toBe(false)
    setTime(100)
    expect(scheduler.onFrame(new Vector3(3, 0, 0), q0())).toBe(true)
  })

  it('停止即终算：被节流后位姿连续两帧不变，立即重算（不受 10Hz 限制）', () => {
    const { scheduler, setTime } = makeScheduler()
    setTime(0)
    expect(scheduler.onFrame(new Vector3(0, 0, 0), q0())).toBe(true)
    setTime(50)
    expect(scheduler.onFrame(new Vector3(1, 0, 0), q0())).toBe(false) // 节流，记为待终算
    setTime(60)
    expect(scheduler.onFrame(new Vector3(1, 0, 0), q0())).toBe(true) // 停止 → 立即终算
  })

  it('待终算期间变化回落到阈值以下：立即终算', () => {
    const { scheduler, setTime } = makeScheduler()
    setTime(0)
    expect(scheduler.onFrame(new Vector3(0, 0, 0), q0())).toBe(true)
    setTime(50)
    expect(scheduler.onFrame(new Vector3(1, 0, 0), q0())).toBe(false) // 节流
    setTime(60)
    // 相对上次重算位姿仅 0.1m（< 0.25）：回落 → 立即终算
    expect(scheduler.onFrame(new Vector3(0.1, 0, 0), q0())).toBe(true)
  })

  it('阈值相对上次重算位姿累计：多次亚阈值移动累计超阈值后触发', () => {
    const { scheduler, setTime } = makeScheduler()
    setTime(0)
    expect(scheduler.onFrame(new Vector3(0, 0, 0), q0())).toBe(true)
    setTime(1000)
    expect(scheduler.onFrame(new Vector3(0.1, 0, 0), q0())).toBe(false)
    setTime(1010)
    expect(scheduler.onFrame(new Vector3(0.2, 0, 0), q0())).toBe(false)
    setTime(1020)
    expect(scheduler.onFrame(new Vector3(0.3, 0, 0), q0())).toBe(true)
  })

  it('forceRecalc：下一帧无条件重算（viewport/地图变化），之后恢复阈值判定', () => {
    const { scheduler, setTime } = makeScheduler()
    setTime(0)
    expect(scheduler.onFrame(new Vector3(0, 0, 0), q0())).toBe(true)
    setTime(10)
    scheduler.forceRecalc()
    expect(scheduler.onFrame(new Vector3(0, 0, 0), q0())).toBe(true)
    setTime(20)
    expect(scheduler.onFrame(new Vector3(0.1, 0, 0), q0())).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §8.3 末条：基准地图初始全景无标签（明确设计）；35m 近景按规则出现
// ---------------------------------------------------------------------------

describe('基准地图集成（public/map.json 全量）', () => {
  // §13 固定值内联注入（与组合根 BROWSER_SCENE_BUILD_OPTIONS 一致）
  const OPTIONS: SceneBuildOptions = {
    factoryMargin: 10,
    labelAnchorY: 0.5,
    path: {
      pathWidth: 0.12,
      curveMaxError: 0.01,
      curveMaxSegment: 0.25,
      miterLimit: 2,
      chevronSpacing: 6,
      chevronMinPathLength: 1.0,
    },
    nodes: {
      stationColors: { work: '#2196F3', charge: '#8BC34A', park: '#F44336' },
    },
  }

  function loadBaselineModel(): ReturnType<typeof buildFactorySceneModel> {
    const url = new URL('../../../../../../public/map.json', import.meta.url)
    const payload: unknown = JSON.parse(readFileSync(url, 'utf8'))
    return buildFactorySceneModel(payload, OPTIONS)
  }

  it('初始 45° 斜视全景机位：所有标签距离 >90m，首屏无标签（明确设计）', () => {
    const model = loadBaselineModel()
    const fit = fitPerspectiveCamera(model.bounds, 16 / 9)
    const camera = new PerspectiveCamera(CAMERA_FOV, 16 / 9, CAMERA_NEAR, CAMERA_FAR)
    camera.position.set(fit.position[0], fit.position[1], fit.position[2])
    camera.up.set(fit.up[0], fit.up[1], fit.up[2])
    camera.lookAt(fit.target[0], fit.target[1], fit.target[2])

    // 设计依据显式化：最近标签距离 > 站点进入阈值
    const minDistance = Math.min(...model.labels.map((label) => {
      const [x, y, z] = label.worldPosition
      return Math.sqrt(
        (x - fit.position[0]) ** 2 + (y - fit.position[1]) ** 2 + (z - fit.position[2]) ** 2,
      )
    }))
    expect(minDistance).toBeGreaterThan(STATION_ENTER)

    const selector = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    expect(selectAll(selector, model.labels, camera)).toEqual([])
  })

  it('35m 近景机位：标签按距离档出现且总数 ≤300', () => {
    const model = loadBaselineModel()
    const { centerX, centerZ } = model.bounds
    const offset = 35 * Math.SQRT1_2 // §10.2 近景：距 target 35m、45° 俯角
    const camera = makeCameraFacing(
      centerX, offset, centerZ + offset,
      centerX, 0, centerZ,
    )
    const selector = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    const result = selectAll(selector, model.labels, camera)
    expect(result.length).toBeGreaterThan(0)
    expect(result.length).toBeLessThanOrEqual(LABEL_MAX_COUNT)
    // 初始全景无标签 → 拉近后出现，差分视角下即全集 attach（迟滞从「未进入」起步）
    const farSelector = createVisibleLabelSelector({ occluders: NO_OCCLUDERS })
    const fit = fitPerspectiveCamera(model.bounds, 16 / 9)
    const panorama = new PerspectiveCamera(CAMERA_FOV, 16 / 9, CAMERA_NEAR, CAMERA_FAR)
    panorama.position.set(fit.position[0], fit.position[1], fit.position[2])
    panorama.up.set(fit.up[0], fit.up[1], fit.up[2])
    panorama.lookAt(fit.target[0], fit.target[1], fit.target[2])
    expect(selectAll(farSelector, model.labels, panorama).length).toBe(0)
    expect(selectAll(farSelector, model.labels, camera).length).toBe(result.length)
  })
})
