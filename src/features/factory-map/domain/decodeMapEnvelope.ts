/**
 * 信封解码：unknown → FactoryMap（SPEC §3.1、§3.2、§3.3）。
 *
 * 唯一合法顶层结构：{ code, message, data: { currentMapInfoVersion: { mapJson } } }
 * - code 必须严格等于 200；mapJson 必须是对象；原始 mapJson 本体不是合法顶层输入
 * - 顶层未列出的字段（如 timestamp）一律忽略，不视为非法信封
 * - 解码器只读取 §3.2 列出的字段；zones、nodeEdgeGroups 等未列出字段不进入领域模型
 *
 * 校验顺序：信封形状 → 集合形状 → 容量 → 逐条字段校验（收集全部字段级错误后
 * 抛出首个并携带错误总数）→ 节点引用 → 几何弧长 → 地图范围。
 * 全部通过后才创建只读 FactoryMap，不产出部分结果。
 */

import { computeMapBounds } from './bounds'
import { MapEnvelopeError, MapValidationError } from './errors'
import { createFactoryMap } from './factoryMap'
import type { FactoryMap } from './factoryMap'
import {
  assertEdgeArcLengths,
  assertMapElementCapacity,
  assertMapExtentWithinLimits,
  assertNodeReferencesExist,
  describeValue,
  isPlainObject,
  parseMapEdges,
  parseMapNodes,
} from './invariants'

/** 读取并校验信封，返回其中的 mapJson 对象 */
function readEnvelopeMapJson(payload: unknown): Record<string, unknown> {
  if (!isPlainObject(payload)) {
    throw new MapEnvelopeError(
      'MAP_ENVELOPE_NOT_OBJECT',
      `地图信封必须是非 null 对象（形如 { code, message, data }），实际为 ${describeValue(payload)}`,
      { fieldPath: '(root)' },
    )
  }
  if (payload.code !== 200) {
    throw new MapEnvelopeError(
      'MAP_ENVELOPE_CODE_INVALID',
      `信封 code 必须严格等于 200，实际为 ${describeValue(payload.code)}`,
      { fieldPath: 'code' },
    )
  }
  const data = payload.data
  if (!isPlainObject(data)) {
    throw new MapEnvelopeError(
      'MAP_ENVELOPE_FIELD_MISSING',
      `信封缺少 data 对象，实际为 ${describeValue(data)}`,
      { fieldPath: 'data' },
    )
  }
  const version = data.currentMapInfoVersion
  if (!isPlainObject(version)) {
    throw new MapEnvelopeError(
      'MAP_ENVELOPE_FIELD_MISSING',
      `信封缺少 data.currentMapInfoVersion 对象，实际为 ${describeValue(version)}`,
      { fieldPath: 'data.currentMapInfoVersion' },
    )
  }
  const mapJson = version.mapJson
  if (!isPlainObject(mapJson)) {
    throw new MapEnvelopeError(
      'MAP_ENVELOPE_FIELD_MISSING',
      `信封缺少 data.currentMapInfoVersion.mapJson 对象，实际为 ${describeValue(mapJson)}`,
      { fieldPath: 'data.currentMapInfoVersion.mapJson' },
    )
  }
  return mapJson
}

/** 读取集合字段：nodes / edges 必须是数组（§3.3 集合字段行） */
function readCollection(mapJson: Record<string, unknown>, key: 'nodes' | 'edges'): unknown[] {
  const value = mapJson[key]
  if (!Array.isArray(value)) {
    throw new MapValidationError(
      'MAP_COLLECTION_NOT_ARRAY',
      `mapJson.${key} 必须是数组，实际为 ${describeValue(value)}`,
      { fieldPath: key },
    )
  }
  return value
}

/**
 * 解码唯一输入信封并执行 §3.3 全部不变量校验。
 * nodes 与 edges 同时为空是合法输入（empty 语义由上层页面状态判定）；
 * nodes 为空但 edges 非空会因引用不成立而校验失败。
 */
export function decodeMapEnvelope(payload: unknown): FactoryMap {
  const mapJson = readEnvelopeMapJson(payload)
  const rawNodes = readCollection(mapJson, 'nodes')
  const rawEdges = readCollection(mapJson, 'edges')

  // 容量先于逐条解析：超限 payload 不做无谓的字段级扫描
  assertMapElementCapacity(rawNodes.length, rawEdges.length)

  const { nodes, errors: nodeErrors } = parseMapNodes(rawNodes)
  const { edges, errors: edgeErrors } = parseMapEdges(rawEdges)
  const fieldErrors = nodeErrors.concat(edgeErrors)
  if (fieldErrors.length > 0) {
    throw fieldErrors[0].withTotalCount(fieldErrors.length)
  }

  const nodeIds = new Set(nodes.map((node) => node.id))
  assertNodeReferencesExist(edges, nodeIds)
  assertEdgeArcLengths(edges)

  const map = createFactoryMap(nodes, edges)
  assertMapExtentWithinLimits(computeMapBounds(map))
  return map
}
