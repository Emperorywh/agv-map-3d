/**
 * 地图字段与引用校验（SPEC §2.1～§2.3、§11.12；TASK-003）。
 *
 * 职责：把任意解析后的 map.json 裁决为「已过滤、已冻结」的有效元素集合与
 *       逐项异常记录：身份（ID/mapId）、坐标、LINE/BEZIER 几何与允许的
 *       null、悬空引用、重复 ID、未知节点类型与缺失数组都在这里处理。
 * 边界：纯函数，不发起请求、不写诊断通道（异常由调用方上报）、不做任何
 *       派生索引（索引归 createMapModel）；不创建 Three.js 对象。
 * 关键不变量：
 * 1. 致命结构错误只有一种：根不是对象或 nodes 缺失/非数组——此时无法构成
 *    地图，以稳定错误码 MAP_ROOT_INVALID 抛出；其余一切问题逐项隔离；
 * 2. 逐项隔离不得级联污染：坏节点被剔除后，引用它的边按悬空引用剔除，
 *    引用坏边的分组按无效成员剔除，但其余元素全部保留；
 * 3. ID 是不透明字符串：非空字符串才有效；重复节点/边 ID 首个生效；
 * 4. mapId 一致性：顶层 mapId 缺省时由第一个有效元素派生，其后 mapId 不
 *    一致的元素按 MAP_MAPID_CONFLICT 剔除；
 * 5. LINE 要求 sx/sy/ex/ey 有限且控制点必须为 null/缺失；BEZIER 要求全部
 *    12 个坐标有限——两类边各自只有一种合法形态（SPEC §2.2）；
 * 6. 未知节点类型不剔除：category='unknown' 保留并记录采样告警，渲染层
 *    使用灰色通用站点兜底（SPEC §2.1 / §11.12）；
 * 7. edges/zones/nodeEdgeGroups 缺失按空数组跳过（§11.12），不视为致命；
 * 8. 输出深度冻结：调用方无法通过返回值修改任何已校验元素。
 */
import { isFiniteNumber, isPlainObject } from '@/shared/validation'
import { StructuredError } from '@/shared/diagnostics'
import { computeEdgeGeometryLength } from './edgeGeometry'
import {
  KNOWN_NODE_TYPES,
  type EdgeType,
  type MapAnomaly,
  type MapEdge,
  type MapGroup,
  type MapNode,
  type RawMapElement,
  type ValidatedMapData,
} from './types'

function mapRootInvalid(message: string, field: string, actual: unknown): StructuredError {
  return new StructuredError({
    code: 'MAP_ROOT_INVALID',
    message,
    context: { field, actual: typeof actual },
  })
}

/** 非空字符串裁决；其余一律视为缺失 */
function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** 有限数值裁决；其余（含 NaN/Infinity/非数值）一律视为缺失 */
function asFinite(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null
}

/** 数值或缺失 → number | null：可选数值字段缺失/非法统一收敛为 null */
function optionalFinite(value: unknown): number | null {
  return value === null || value === undefined ? null : asFinite(value)
}

function pushAnomaly(list: MapAnomaly[], anomaly: MapAnomaly): void {
  list.push(Object.freeze(anomaly))
}

function freezeNode(node: MapNode): MapNode {
  return Object.freeze(node)
}

function freezeEdge(edge: MapEdge): MapEdge {
  return Object.freeze(edge)
}

function freezeGroup(group: MapGroup): MapGroup {
  return Object.freeze(group)
}

/**
 * 校验单个元素的 mapId：首元素确定期望值；之后不一致的元素返回 null（剔除）。
 * expectedMapId 以对象包装以便跨元素累积状态（纯函数内部的可变构建态）。
 */
function checkElementMapId(
  raw: RawMapElement,
  kind: string,
  index: number,
  expectedMapId: { value: string | null },
  anomalies: MapAnomaly[],
): string | null {
  const mapId = asNonEmptyString(raw.mapId)
  if (mapId === null) {
    pushAnomaly(anomalies, {
      code: 'MAP_MAPID_CONFLICT',
      level: 'error',
      message: `${kind}[${index}] 缺失非空 mapId，已逐项剔除`,
      context: { kind, index },
    })
    return null
  }
  if (expectedMapId.value === null) {
    expectedMapId.value = mapId
    return mapId
  }
  if (expectedMapId.value !== mapId) {
    pushAnomaly(anomalies, {
      code: 'MAP_MAPID_CONFLICT',
      level: 'error',
      message: `${kind}[${index}] 的 mapId 与地图主 mapId 不一致，已逐项剔除`,
      context: { kind, index, mapId, expected: expectedMapId.value },
    })
    return null
  }
  return mapId
}

/** 校验节点数组，返回有效节点与 id 索引；无效节点逐项剔除 */
function validateNodes(rawNodes: readonly unknown[], anomalies: MapAnomaly[]): {
  nodes: MapNode[]
  nodeIndex: Map<string, MapNode>
  mapId: string | null
} {
  const nodes: MapNode[] = []
  const nodeIndex = new Map<string, MapNode>()
  const expectedMapId: { value: string | null } = { value: null }

  rawNodes.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      pushAnomaly(anomalies, {
        code: 'MAP_NODE_INVALID',
        level: 'error',
        message: `节点条目不是对象，已逐项剔除`,
        context: { index },
      })
      return
    }
    const id = asNonEmptyString(entry.id)
    if (id === null) {
      pushAnomaly(anomalies, {
        code: 'MAP_NODE_INVALID',
        level: 'error',
        message: '节点缺失非空字符串 id，已逐项剔除',
        context: { index },
      })
      return
    }
    if (nodeIndex.has(id)) {
      pushAnomaly(anomalies, {
        code: 'MAP_NODE_DUPLICATE_ID',
        level: 'error',
        message: `节点 id 重复，仅首个生效`,
        context: { index, id },
      })
      return
    }
    const mapId = checkElementMapId(entry, 'node', index, expectedMapId, anomalies)
    if (mapId === null) {
      return
    }
    const x = asFinite(entry.x)
    const y = asFinite(entry.y)
    if (x === null || y === null) {
      pushAnomaly(anomalies, {
        code: 'MAP_NODE_INVALID',
        level: 'error',
        message: `节点 ${id} 坐标缺失或非有限数值，已逐项剔除`,
        context: { index, id, x: entry.x, y: entry.y },
      })
      return
    }

    // 未知节点类型：保留节点并产生采样告警，渲染层走灰色通用站点兜底
    const rawType = typeof entry.type === 'string' ? entry.type : ''
    const category = KNOWN_NODE_TYPES.has(rawType) ? (rawType as MapNode['category']) : 'unknown'
    if (category === 'unknown') {
      pushAnomaly(anomalies, {
        code: 'MAP_NODE_UNKNOWN_TYPE',
        level: 'warn',
        message: `节点 ${id} 类型未知（${JSON.stringify(entry.type)}），使用通用站点兜底`,
        context: { index, id, type: entry.type },
      })
    }

    // name/angle 属于展示字段：缺失时安全回退（name→id，angle→null），不剔除
    const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : id
    const angle = asFinite(entry.angle)

    const node = freezeNode({
      id,
      name,
      type: rawType,
      category,
      mapId,
      x,
      y,
      angle,
    })
    nodes.push(node)
    nodeIndex.set(id, node)
  })

  return { nodes, nodeIndex, mapId: expectedMapId.value }
}

/** 校验逻辑边：几何形态、悬空引用逐项裁决；有效边附带物理长度 */
function validateEdges(
  rawEdges: readonly unknown[],
  nodeIndex: ReadonlyMap<string, MapNode>,
  mapId: string | null,
  anomalies: MapAnomaly[],
): { edges: MapEdge[]; edgeIndex: Map<string, MapEdge> } {
  const edges: MapEdge[] = []
  const edgeIndex = new Map<string, MapEdge>()
  const expectedMapId: { value: string | null } = { value: mapId }

  rawEdges.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      pushAnomaly(anomalies, {
        code: 'MAP_EDGE_INVALID',
        level: 'error',
        message: '逻辑边条目不是对象，已逐项剔除',
        context: { index },
      })
      return
    }
    const id = asNonEmptyString(entry.id)
    if (id === null || edgeIndex.has(id)) {
      pushAnomaly(anomalies, {
        code: 'MAP_EDGE_INVALID',
        level: 'error',
        message: `逻辑边缺失非空 id 或 id 重复，已逐项剔除`,
        context: { index, id: entry.id },
      })
      return
    }
    const edgeMapId = checkElementMapId(entry, 'edge', index, expectedMapId, anomalies)
    if (edgeMapId === null) {
      return
    }
    const edgeType = entry.edgeType
    if (edgeType !== 'LINE' && edgeType !== 'BEZIER') {
      pushAnomaly(anomalies, {
        code: 'MAP_EDGE_INVALID',
        level: 'error',
        message: `逻辑边 ${id} 的 edgeType 非法，只允许 'LINE' 或 'BEZIER'`,
        context: { index, id, edgeType },
      })
      return
    }

    const sx = asFinite(entry.sx)
    const sy = asFinite(entry.sy)
    const ex = asFinite(entry.ex)
    const ey = asFinite(entry.ey)
    if (sx === null || sy === null || ex === null || ey === null) {
      pushAnomaly(anomalies, {
        code: 'MAP_EDGE_INVALID',
        level: 'error',
        message: `逻辑边 ${id} 起止坐标缺失或非有限数值`,
        context: { index, id },
      })
      return
    }

    let cx: number | null = null
    let cy: number | null = null
    let dx: number | null = null
    let dy: number | null = null
    if (edgeType === 'LINE') {
      // LINE：控制点必须为 null/缺失；出现任何非空控制点即几何形态非法
      const hasControl = [entry.cx, entry.cy, entry.dx, entry.dy].some(
        (value) => value !== null && value !== undefined,
      )
      if (hasControl) {
        pushAnomaly(anomalies, {
          code: 'MAP_EDGE_INVALID',
          level: 'error',
          message: `LINE 逻辑边 ${id} 不允许携带贝塞尔控制点`,
          context: { index, id },
        })
        return
      }
    } else {
      cx = asFinite(entry.cx)
      cy = asFinite(entry.cy)
      dx = asFinite(entry.dx)
      dy = asFinite(entry.dy)
      if (cx === null || cy === null || dx === null || dy === null) {
        pushAnomaly(anomalies, {
          code: 'MAP_EDGE_INVALID',
          level: 'error',
          message: `BEZIER 逻辑边 ${id} 控制点缺失或非有限数值`,
          context: { index, id },
        })
        return
      }
    }

    const snodeId = asNonEmptyString(entry.snodeId)
    const enodeId = asNonEmptyString(entry.enodeId)
    if (
      snodeId === null ||
      enodeId === null ||
      !nodeIndex.has(snodeId) ||
      !nodeIndex.has(enodeId)
    ) {
      pushAnomaly(anomalies, {
        code: 'MAP_EDGE_DANGLING_REF',
        level: 'error',
        message: `逻辑边 ${id} 引用了不存在或已被剔除的节点，已逐项剔除`,
        context: { index, id, snodeId: entry.snodeId, enodeId: entry.enodeId },
      })
      return
    }

    const length = computeEdgeGeometryLength({ edgeType, sx, sy, ex, ey, cx, cy, dx, dy })
    const edge = freezeEdge({
      id,
      mapId: edgeMapId,
      edgeType: edgeType as EdgeType,
      sx,
      sy,
      ex,
      ey,
      cx,
      cy,
      dx,
      dy,
      snodeId,
      enodeId,
      isBackEdge: entry.isBackEdge === true,
      // 代价/限速缺失或非法时收敛为 null，调用方按 §9.2 回退（如物理长度）
      cost: optionalFinite(entry.cost),
      maxLoadSpeed: optionalFinite(entry.maxLoadSpeed),
      maxFreeSpeed: optionalFinite(entry.maxFreeSpeed),
      length,
    })
    edges.push(edge)
    edgeIndex.set(id, edge)
  })

  return { edges, edgeIndex }
}

/** 校验独占区分组：缺失数组按空处理，无效成员引用逐项过滤，分组本身保留 */
function validateGroups(
  rawGroups: readonly unknown[],
  nodeIndex: ReadonlyMap<string, MapNode>,
  edgeIndex: ReadonlyMap<string, MapEdge>,
  anomalies: MapAnomaly[],
): MapGroup[] {
  const groups: MapGroup[] = []
  const groupIds = new Set<string>()

  rawGroups.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      pushAnomaly(anomalies, {
        code: 'MAP_GROUP_INVALID',
        level: 'error',
        message: '独占区分组条目不是对象，已逐项剔除',
        context: { index },
      })
      return
    }
    const id = asNonEmptyString(entry.id)
    if (id === null || groupIds.has(id)) {
      pushAnomaly(anomalies, {
        code: 'MAP_GROUP_INVALID',
        level: 'error',
        message: '独占区分组缺失非空 id 或 id 重复，已逐项剔除',
        context: { index, id: entry.id },
      })
      return
    }
    groupIds.add(id)
    const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : id

    // 成员数组：缺失按空跳过（§11.12）；非数组视为异常但同样按空处理
    const memberNodeIds: string[] = []
    if (entry.nodeIds !== undefined && !Array.isArray(entry.nodeIds)) {
      pushAnomaly(anomalies, {
        code: 'MAP_GROUP_INVALID',
        level: 'error',
        message: `独占区分组 ${id} 的 nodeIds 不是数组，按空处理`,
        context: { index, id },
      })
    } else if (Array.isArray(entry.nodeIds)) {
      for (const memberId of entry.nodeIds) {
        const member = asNonEmptyString(memberId)
        if (member !== null && nodeIndex.has(member)) {
          memberNodeIds.push(member)
        } else {
          pushAnomaly(anomalies, {
            code: 'MAP_GROUP_MEMBER_INVALID',
            level: 'warn',
            message: `独占区分组 ${id} 引用了不存在或已被剔除的节点，已跳过该引用`,
            context: { index, groupId: id, nodeId: memberId },
          })
        }
      }
    }

    const memberEdgeIds: string[] = []
    if (entry.edgeIds !== undefined && !Array.isArray(entry.edgeIds)) {
      pushAnomaly(anomalies, {
        code: 'MAP_GROUP_INVALID',
        level: 'error',
        message: `独占区分组 ${id} 的 edgeIds 不是数组，按空处理`,
        context: { index, id },
      })
    } else if (Array.isArray(entry.edgeIds)) {
      for (const memberId of entry.edgeIds) {
        const member = asNonEmptyString(memberId)
        if (member !== null && edgeIndex.has(member)) {
          memberEdgeIds.push(member)
        } else {
          pushAnomaly(anomalies, {
            code: 'MAP_GROUP_MEMBER_INVALID',
            level: 'warn',
            message: `独占区分组 ${id} 引用了不存在或已被剔除的边，已跳过该引用`,
            context: { index, groupId: id, edgeId: memberId },
          })
        }
      }
    }

    groups.push(
      freezeGroup({
        id,
        name,
        memberNodeIds: Object.freeze(memberNodeIds),
        memberEdgeIds: Object.freeze(memberEdgeIds),
      }),
    )
  })

  return groups
}

/**
 * 校验地图原始数据：返回深度冻结的有效元素与逐项异常记录。
 * 只有根结构致命错误（非对象 / nodes 缺失或非数组）会抛出 MAP_ROOT_INVALID。
 */
export function validateMap(raw: unknown): ValidatedMapData {
  if (!isPlainObject(raw)) {
    throw mapRootInvalid('地图数据根必须是 JSON 对象', '(root)', raw)
  }
  if (!Array.isArray(raw.nodes)) {
    throw mapRootInvalid('地图 nodes 必须为数组：没有节点无法构成地图', 'nodes', raw.nodes)
  }
  // edges/groups 缺失按空数组跳过（§11.12）；zones 当前不消费，直接忽略
  const rawNodes: readonly unknown[] = raw.nodes
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : []
  const rawGroups = Array.isArray(raw.nodeEdgeGroups) ? raw.nodeEdgeGroups : []

  const anomalies: MapAnomaly[] = []
  const { nodes, nodeIndex, mapId } = validateNodes(rawNodes, anomalies)
  const { edges, edgeIndex } = validateEdges(rawEdges, nodeIndex, mapId, anomalies)
  const groups = validateGroups(rawGroups, nodeIndex, edgeIndex, anomalies)

  const data: ValidatedMapData = {
    mapId: mapId ?? '',
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    groups: Object.freeze(groups),
    anomalies: Object.freeze(anomalies),
  }
  return Object.freeze(data)
}
