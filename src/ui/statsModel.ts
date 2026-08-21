/**
 * 统计面板视图模型（SPEC §8.3 / §10）：由 domain 纯数据派生统计展示结构的纯函数。
 *
 * ui 层只消费 domain 类型与 store、不 import rendering（SPEC §12）——
 * 本模块是统计面板与 domain 数据之间的唯一转换点（与 detailModel 同模式），
 * 组件只做展示。
 */

import type { NormalizeStats } from '../domain/normalize'
import type { AgvSnapshot, AgvStatus } from '../domain/simulator'
import type { NormalizedMap } from '../domain/types'

import { AGV_STATUS_LABELS } from './detailModel'

/** AGV 状态展示顺序（与 config/theme.ts agvStatusColors 六状态键一致；键一致性由单测断言） */
export const AGV_STATUS_ORDER: readonly AgvStatus[] = [
  'idle',
  'toPick',
  'hauling',
  'toCharge',
  'charging',
  'loading',
]

/** AGV 单状态计数行 */
export interface AgvStatusCount {
  status: AgvStatus
  label: string
  count: number
}

/**
 * 统计 AGV 各状态台数（SPEC §8.3）：输入为 0.5s 低频快照（面板节流刷新，不读每帧瞬时值）；
 * 六状态固定顺序输出，无该状态台数时计数为 0（行不随状态迁移消失，面板布局稳定）。
 */
export function countAgvByStatus(snapshot: readonly AgvSnapshot[]): AgvStatusCount[] {
  const counts: Record<AgvStatus, number> = {
    idle: 0,
    toPick: 0,
    hauling: 0,
    toCharge: 0,
    charging: 0,
    loading: 0,
  }
  for (const agv of snapshot) {
    counts[agv.status] += 1
  }
  return AGV_STATUS_ORDER.map((status) => ({
    status,
    label: AGV_STATUS_LABELS[status],
    count: counts[status],
  }))
}

/** 统计行（地图规模与数据质量计数共用展示结构） */
export interface StatCountRow {
  key: string
  label: string
  count: number
}

/** 地图规模总数（SPEC §8.3：节点 / 走廊 / 边总数；取规范化后实际入场景的数据口径） */
export function buildMapTotals(map: NormalizedMap): StatCountRow[] {
  return [
    { key: 'nodes', label: '节点', count: map.nodes.length },
    { key: 'corridors', label: '走廊', count: map.corridors.length },
    { key: 'edges', label: '有向边', count: map.edges.length },
  ]
}

/**
 * 加载期坏数据跳过 / 降级计数（SPEC §10：所有跳过都有日志与计数，计数面板可见）。
 * 含规范化跳过 / 降级与走廊配对警告计数；真实 map.json 实测全为 0（SPEC §4.1）。
 */
export function buildDataSkipCounts(stats: NormalizeStats): StatCountRow[] {
  return [
    { key: 'skippedNodes', label: '跳过节点（缺坐标）', count: stats.skippedNodes },
    { key: 'skippedEdges', label: '跳过边（悬空 / 退化）', count: stats.skippedEdges },
    { key: 'unknownNodeKinds', label: '未知类型降级节点', count: stats.unknownNodeKinds },
    { key: 'degradedEdges', label: '降级边', count: stats.degradedEdges },
    {
      key: 'corridorGeometryMismatch',
      label: '走廊配对几何偏差',
      count: stats.corridors.geometryMismatch,
    },
    {
      key: 'duplicateDirectionEdges',
      label: '重复方向边',
      count: stats.corridors.duplicateDirectionEdges,
    },
  ]
}
