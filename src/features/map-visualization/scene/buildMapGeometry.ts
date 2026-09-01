/**
 * 物理路径去重与静态地图几何（SPEC §2.2、§5.1；TASK-004）。
 *
 * 职责：
 * 1. dedupePhysicalPaths：把有向逻辑边按「正/反向几何归一后相同」的签名去重，
 *    生成物理路径集合（当前地图 9,265 条逻辑边 → 5,068 条物理路径），并保留
 *    逻辑边 → 物理路径的完整映射（方向、限速与拓扑语义仍留在逻辑边上）；
 * 2. buildMapGeometry：在世界坐标下把物理路径离散化为静态合批几何（深灰路面
 *    条带 BufferGeometry + 中线 LineSegments 几何），并生成全部节点的实例
 *    矩阵与颜色数据（供一个 InstancedMesh 渲染）。
 * 边界：输入必须来自 createMapModel 的只读 MapModel（已校验、有限坐标）；
 *       本模块不创建 Mesh/材质、不进 React、不做拓扑寻路；图层高度等外观
 *       常量来自 mapAppearance。
 * 关键不变量：
 * 1. 归一化签名只由几何坐标决定：BEZIER 反向 = 端点与控制点整体逆序；同一
 *    节点对之间几何不同的平行路径不会被合并（不得按节点对去重，SPEC §2.2）；
 * 2. BEZIER 固定采样 BEZIER_SAMPLE_SEGMENTS=24 段（全应用唯一离散化口径，
 *    与逻辑边物理长度共用 sampleCubicBezier）；因此中心线段总数恒为
 *    LINE 物理路径数 ×1 + BEZIER 物理路径数 ×24（当前地图 44,559）；
 * 3. 重复几何数 = 逻辑边总数 − 物理路径数（当前地图 4,197）；每条逻辑边都
 *    能映射到唯一物理路径，映射无遗漏、无悬空；
 * 4. 静态几何顶点全部位于世界坐标并已烘焙图层高度（见 mapAppearance 阶梯），
 *    图层组件以零位移原样上载；本模块创建的 BufferGeometry 由返回值上的
 *    dispose() 明确释放（资源所有权：创建者释放）。
 */
import * as THREE from 'three'
import type { MapModel, MapEdge, EdgeType } from '../model/types'
import {
  BEZIER_SAMPLE_SEGMENTS,
  sampleCubicBezier,
  type PlanePoint2,
} from '../model/edgeGeometry'
import type { WorldTransform } from '@/shared/spatial'
import {
  NODE_COLORS,
  NODE_Y,
  PATH_CENTERLINE_Y,
  PATH_SURFACE_WIDTH_M,
  PATH_SURFACE_Y,
} from './mapAppearance'

/** 一条去重后的物理路径（几何与其覆盖的逻辑边集合） */
export interface PhysicalPath {
  /** 物理路径序号：按代表逻辑边的首次出现顺序稳定编号 */
  readonly index: number
  readonly edgeType: EdgeType
  /** 首次出现的代表逻辑边 ID（诊断与映射锚点） */
  readonly representativeEdgeId: string
  /** 几何与该路径重合的全部逻辑边 ID（正、反向都计入） */
  readonly logicalEdgeIds: readonly string[]
  /** 归一化方向下的平面采样点：LINE 2 个点，BEZIER 24+1 个点（米） */
  readonly points: readonly PlanePoint2[]
}

/** 物理路径去重结果（纯数据，不含 Three.js 对象） */
export interface PhysicalPathIndex {
  readonly physicalPaths: readonly PhysicalPath[]
  /** 逻辑边 ID → 物理路径 index（覆盖全部逻辑边，无遗漏） */
  readonly physicalPathIndexOfEdge: ReadonlyMap<string, number>
  /** 被去重掉的重复几何逻辑边数（逻辑边总数 − 物理路径数） */
  readonly duplicateEdgeCount: number
  /** 中心线段总数（LINE 每条 1 段、BEZIER 每条 24 段之和） */
  readonly centerSegmentCount: number
}

/** 逻辑边正向几何坐标序列（LINE 4 个数、BEZIER 8 个数） */
function edgeForwardCoords(edge: MapEdge): number[] {
  if (edge.edgeType === 'LINE') {
    return [edge.sx, edge.sy, edge.ex, edge.ey]
  }
  // BEZIER 控制点已由 validateMap 保证为非空有限数值
  return [
    edge.sx,
    edge.sy,
    edge.cx as number,
    edge.cy as number,
    edge.dx as number,
    edge.dy as number,
    edge.ex,
    edge.ey,
  ]
}

/**
 * 逻辑边反向几何坐标序列：按「点对」逆序（s→c→d→e 变为 e→d→c→s），
 * 不得使用扁平数组 reverse——那会把单个数字反转成错误坐标对。
 */
function edgeBackwardCoords(edge: MapEdge): number[] {
  if (edge.edgeType === 'LINE') {
    return [edge.ex, edge.ey, edge.sx, edge.sy]
  }
  return [
    edge.ex,
    edge.ey,
    edge.dx as number,
    edge.dy as number,
    edge.cx as number,
    edge.cy as number,
    edge.sx,
    edge.sy,
  ]
}

/**
 * 物理路径去重：按归一化几何签名合并正反向重合的逻辑边。
 * 签名取「正向坐标序列」与「逆向坐标序列」中字典序较小者的序列化字符串；
 * 字符串比较只用于选方向与判等，不解析回数值。
 */
export function dedupePhysicalPaths(mapModel: MapModel): PhysicalPathIndex {
  const physicalPaths: PhysicalPath[] = []
  const indexByKey = new Map<string, number>()
  const physicalPathIndexOfEdge = new Map<string, number>()
  let centerSegmentCount = 0

  for (const edge of mapModel.edgeList) {
    const forward = edgeForwardCoords(edge)
    const backward = edgeBackwardCoords(edge)
    const forwardKey = forward.join(',')
    const backwardKey = backward.join(',')
    // 归一化方向：两种读法中字典序较小者作为该几何的唯一签名
    const useForward = forwardKey <= backwardKey
    const key = useForward ? forwardKey : backwardKey

    const existingIndex = indexByKey.get(key)
    if (existingIndex !== undefined) {
      const existing = physicalPaths[existingIndex]
      // 复用既有物理路径：仅追加逻辑边映射，几何不重复入批
      physicalPaths[existingIndex] = {
        ...existing,
        logicalEdgeIds: Object.freeze([...existing.logicalEdgeIds, edge.id]),
      }
      physicalPathIndexOfEdge.set(edge.id, existingIndex)
      continue
    }

    const points = useForward
      ? sampleEdgePoints(edge)
      : sampleEdgePoints(edge).slice().reverse()
    const index = physicalPaths.length
    indexByKey.set(key, index)
    physicalPaths.push({
      index,
      edgeType: edge.edgeType,
      representativeEdgeId: edge.id,
      logicalEdgeIds: Object.freeze([edge.id]),
      points: Object.freeze(points),
    })
    physicalPathIndexOfEdge.set(edge.id, index)
    centerSegmentCount += points.length - 1
  }

  return {
    physicalPaths: Object.freeze(physicalPaths),
    physicalPathIndexOfEdge,
    duplicateEdgeCount: mapModel.edgeList.length - physicalPaths.length,
    centerSegmentCount,
  }
}

/** 逻辑边在自身方向下的平面采样点（LINE 两端点；BEZIER 24+1 个采样点） */
function sampleEdgePoints(edge: MapEdge): PlanePoint2[] {
  if (edge.edgeType === 'LINE') {
    return [
      { x: edge.sx, y: edge.sy },
      { x: edge.ex, y: edge.ey },
    ]
  }
  return sampleCubicBezier(
    edge.sx,
    edge.sy,
    edge.cx as number,
    edge.cy as number,
    edge.dx as number,
    edge.dy as number,
    edge.ex,
    edge.ey,
    BEZIER_SAMPLE_SEGMENTS,
  )
}

/** 节点实例静态数据：列主序平移矩阵与 RGB 颜色（供单个 InstancedMesh 上载） */
export interface NodeInstanceData {
  readonly count: number
  /** 列主序 4×4 矩阵数组，长度 16×count；仅含平移（站点为正圆，无朝向） */
  readonly matrices: Float32Array
  /** RGB 颜色数组，长度 3×count（instanceColor 直读） */
  readonly colors: Float32Array
}

/** 已构建的静态地图几何与节点实例数据（GPU 资源由本对象拥有并释放） */
export interface MapGeometry {
  /** 物理路径路面条带（三角形合批，静态） */
  readonly pathsSurface: THREE.BufferGeometry
  /** 物理路径中线（LineSegments 合批，静态） */
  readonly pathsCenterline: THREE.BufferGeometry
  /** 节点实例矩阵与颜色（图层据此创建唯一 InstancedMesh） */
  readonly nodeInstances: NodeInstanceData
  /** 物理路径去重明细（供诊断与后续图层复用） */
  readonly physical: PhysicalPathIndex
  /** 释放本对象创建的全部 GPU 几何；幂等，调用后对象不再可用 */
  dispose(): void
}

/**
 * 构建世界坐标静态地图几何。
 * 世界坐标由统一 WorldTransform 变换（原点为地图包围盒中心，已一次定型），
 * 图层高度由 mapAppearance 阶梯直接烘焙进顶点。
 */
export function buildMapGeometry(
  mapModel: MapModel,
  worldTransform: WorldTransform,
): MapGeometry {
  const physical = dedupePhysicalPaths(mapModel)

  const surfacePositions: number[] = []
  const surfaceIndices: number[] = []
  const centerlinePositions: number[] = []
  const halfWidth = PATH_SURFACE_WIDTH_M / 2

  for (const path of physical.physicalPaths) {
    // 统一坐标转换：平面点 → 世界地面点（mapX-originX, 0, mapY-originY）
    const worldPoints = path.points.map((p) => worldTransform.toWorldXZ(p.x, p.y))
    for (let i = 1; i < worldPoints.length; i += 1) {
      const a = worldPoints[i - 1]
      const b = worldPoints[i]
      const segmentLength = Math.hypot(b.x - a.x, b.z - a.z)
      // 零长度段不产生几何（校验层保证长度为正，此处兜底防退化三角形）
      if (segmentLength === 0) {
        continue
      }
      // 中线：每段一对端点
      centerlinePositions.push(a.x, PATH_CENTERLINE_Y, a.z)
      centerlinePositions.push(b.x, PATH_CENTERLINE_Y, b.z)

      // 路面条带：沿段法线（-dir.z, dir.x）向两侧展开 halfWidth
      const dirX = (b.x - a.x) / segmentLength
      const dirZ = (b.z - a.z) / segmentLength
      const normalX = -dirZ * halfWidth
      const normalZ = dirX * halfWidth
      const base = surfacePositions.length / 3
      surfacePositions.push(
        a.x + normalX,
        PATH_SURFACE_Y,
        a.z + normalZ,
        a.x - normalX,
        PATH_SURFACE_Y,
        a.z - normalZ,
        b.x - normalX,
        PATH_SURFACE_Y,
        b.z - normalZ,
        b.x + normalX,
        PATH_SURFACE_Y,
        b.z + normalZ,
      )
      surfaceIndices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
  }

  const pathsSurface = new THREE.BufferGeometry()
  pathsSurface.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(surfacePositions, 3),
  )
  pathsSurface.setIndex(surfaceIndices)
  pathsSurface.computeBoundingSphere()

  const pathsCenterline = new THREE.BufferGeometry()
  pathsCenterline.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(centerlinePositions, 3),
  )
  pathsCenterline.computeBoundingSphere()

  const nodeInstances = buildNodeInstances(mapModel, worldTransform)

  let disposed = false
  return {
    pathsSurface,
    pathsCenterline,
    nodeInstances,
    physical,
    dispose() {
      // 幂等释放：重复调用不得抛错（StrictMode 卸载与原子替换都会触发）
      if (disposed) {
        return
      }
      disposed = true
      pathsSurface.dispose()
      pathsCenterline.dispose()
    },
  }
}

/** 生成全部节点的实例矩阵与颜色：平移矩阵 + 类别颜色，顺序与 nodeList 一致 */
function buildNodeInstances(
  mapModel: MapModel,
  worldTransform: WorldTransform,
): NodeInstanceData {
  const count = mapModel.nodeList.length
  const matrices = new Float32Array(count * 16)
  const colors = new Float32Array(count * 3)
  const colorScratch = new THREE.Color()

  for (let i = 0; i < count; i += 1) {
    const node = mapModel.nodeList[i]
    const world = worldTransform.toWorldXZ(node.x, node.y)
    const m = i * 16
    // 列主序单位矩阵，仅平移（节点是正圆站点，不使用可能为 null 的 angle）
    matrices[m] = 1
    matrices[m + 5] = 1
    matrices[m + 10] = 1
    matrices[m + 12] = world.x
    matrices[m + 13] = NODE_Y
    matrices[m + 14] = world.z
    matrices[m + 15] = 1

    colorScratch.set(NODE_COLORS[node.category])
    const c = i * 3
    colors[c] = colorScratch.r
    colors[c + 1] = colorScratch.g
    colors[c + 2] = colorScratch.b
  }

  return { count, matrices, colors }
}
