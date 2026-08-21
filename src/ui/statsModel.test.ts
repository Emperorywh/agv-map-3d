import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { agvStatusColors } from '../config/theme'
import { normalizeMapFromJson } from '../domain/normalize'
import type { NormalizeStats } from '../domain/normalize'
import type { AgvSnapshot, AgvStatus } from '../domain/simulator'
import type { NormalizedMap } from '../domain/types'
import { AGV_STATUS_LABELS } from './detailModel'
import {
  AGV_STATUS_ORDER,
  buildDataSkipCounts,
  buildMapTotals,
  countAgvByStatus,
} from './statsModel'

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

function agv(id: number, status: AgvStatus): AgvSnapshot {
  return {
    id,
    status,
    battery: 100,
    edgeId: null,
    nodeId: null,
    task: null,
    position: { x: 0, y: 0, z: 0 },
    yaw: 0,
  }
}

function syntheticStats(): NormalizeStats {
  return {
    inputNodes: 10,
    inputEdges: 8,
    nodes: 9,
    edges: 5,
    skippedNodes: 1,
    skippedEdges: 2,
    unknownNodeKinds: 3,
    degradedEdges: 4,
    corridors: {
      inputEdges: 8,
      corridors: 6,
      bidirectional: 4,
      oneWay: 2,
      bidirectionalWithBack: 3,
      bidirectionalBothForward: 1,
      bidirectionalBothBack: 0,
      oneWayBack: 0,
      geometryMismatch: 5,
      duplicateDirectionEdges: 6,
    },
  }
}

function syntheticMap(): NormalizedMap {
  return {
    calibration: { scale: 1, rotationRad: 0, offsetX: 0, offsetY: 0 },
    bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    floor: 1,
    nodes: [
      { id: 'n1', name: '甲', kind: 'work', x: 0, y: 0, angle: null },
      { id: 'n2', name: '乙', kind: 'park', x: 1, y: 1, angle: null },
    ],
    edges: [
      {
        id: 'e12',
        name: '边甲乙',
        from: 'n1',
        to: 'n2',
        geometry: {
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
          cumulativeLengths: [0, Math.SQRT2],
          length: Math.SQRT2,
        },
        sFacing: 0,
        eFacing: 0,
        isBackEdge: false,
        cost: 1,
        maxSpeedLoad: null,
        maxSpeedFree: null,
        maxRotationSpeedLoad: null,
        maxRotationSpeedFree: null,
        maxAccelerationLoad: null,
        maxAccelerationFree: null,
        maxDecelerationLoad: null,
        maxDecelerationFree: null,
      },
    ],
    corridors: [],
  }
}

// ---------------------------------------------------------------------------
// AGV 状态计数（SPEC §8.3）
// ---------------------------------------------------------------------------

describe('countAgvByStatus：AGV 各状态数量', () => {
  it('空快照：六状态固定顺序输出、计数全 0、标签与 AGV_STATUS_LABELS 一致', () => {
    const rows = countAgvByStatus([])
    expect(rows.map((row) => row.status)).toEqual([...AGV_STATUS_ORDER])
    expect(rows).toHaveLength(6)
    for (const row of rows) {
      expect(row.count).toBe(0)
      expect(row.label).toBe(AGV_STATUS_LABELS[row.status])
    }
  })

  it('混合状态快照：按状态聚合计数，顺序固定，总和等于快照长度', () => {
    const snapshot = [
      agv(0, 'idle'),
      agv(1, 'toPick'),
      agv(2, 'toPick'),
      agv(3, 'hauling'),
      agv(4, 'charging'),
      agv(5, 'loading'),
      agv(6, 'loading'),
      agv(7, 'loading'),
    ]
    const rows = countAgvByStatus(snapshot)
    const byStatus = new Map(rows.map((row) => [row.status, row.count]))
    expect(byStatus.get('idle')).toBe(1)
    expect(byStatus.get('toPick')).toBe(2)
    expect(byStatus.get('hauling')).toBe(1)
    expect(byStatus.get('toCharge')).toBe(0)
    expect(byStatus.get('charging')).toBe(1)
    expect(byStatus.get('loading')).toBe(3)
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(snapshot.length)
    expect(rows.map((row) => row.status)).toEqual([...AGV_STATUS_ORDER])
  })

  it('AGV_STATUS_ORDER 与 theme.agvStatusColors 六状态键一一对应', () => {
    expect([...AGV_STATUS_ORDER].sort()).toEqual(Object.keys(agvStatusColors).sort())
  })
})

// ---------------------------------------------------------------------------
// 地图规模与数据跳过计数（SPEC §8.3 / §10）
// ---------------------------------------------------------------------------

describe('buildMapTotals / buildDataSkipCounts', () => {
  it('地图规模：节点 / 走廊 / 有向边取规范化后数组长度', () => {
    const rows = buildMapTotals(syntheticMap())
    expect(rows).toEqual([
      { key: 'nodes', label: '节点', count: 2 },
      { key: 'corridors', label: '走廊', count: 0 },
      { key: 'edges', label: '有向边', count: 1 },
    ])
  })

  it('数据跳过计数：规范化跳过 / 降级与走廊配对警告计数逐项映射', () => {
    const rows = buildDataSkipCounts(syntheticStats())
    const byKey = new Map(rows.map((row) => [row.key, row.count]))
    expect(byKey.get('skippedNodes')).toBe(1)
    expect(byKey.get('skippedEdges')).toBe(2)
    expect(byKey.get('unknownNodeKinds')).toBe(3)
    expect(byKey.get('degradedEdges')).toBe(4)
    expect(byKey.get('corridorGeometryMismatch')).toBe(5)
    expect(byKey.get('duplicateDirectionEdges')).toBe(6)
    expect(rows.every((row) => row.label.length > 0)).toBe(true)
  })
})

describe('statsModel：真实 map.json 集成', () => {
  const mapJsonPath = fileURLToPath(new URL('../../public/map.json', import.meta.url))
  const { map, stats } = normalizeMapFromJson(readFileSync(mapJsonPath, 'utf-8'))

  it('地图规模与 SPEC §4.1 实测口径一致（1767 节点 / 2046 走廊 / 3043 有向边）', () => {
    const byKey = new Map(buildMapTotals(map).map((row) => [row.key, row.count]))
    expect(byKey.get('nodes')).toBe(1767)
    expect(byKey.get('corridors')).toBe(2046)
    expect(byKey.get('edges')).toBe(3043)
  })

  it('真实数据零跳过零降级（SPEC §4.1：加载期坏数据计数全为 0）', () => {
    for (const row of buildDataSkipCounts(stats)) {
      expect(row.count).toBe(0)
    }
  })
})
