import { describe, expect, it } from 'vitest'

import {
  EDGE_TYPES,
  NODE_TYPES,
  createFactoryMap,
  isStationNodeType,
} from './factoryMap'
import type { FactoryMapEdge, FactoryMapNode } from './factoryMap'

describe('合法枚举（SPEC §3.2）', () => {
  it('节点类型仅 node/work/park/charge', () => {
    expect(NODE_TYPES).toEqual(['node', 'work', 'park', 'charge'])
  })

  it('路径类型仅 LINE/BEZIER', () => {
    expect(EDGE_TYPES).toEqual(['LINE', 'BEZIER'])
  })

  it('站点类型为 work/park/charge（§7.3）', () => {
    expect(isStationNodeType('node')).toBe(false)
    expect(isStationNodeType('work')).toBe(true)
    expect(isStationNodeType('park')).toBe(true)
    expect(isStationNodeType('charge')).toBe(true)
  })
})

describe('createFactoryMap 只读实体（SPEC §3.3）', () => {
  const node: FactoryMapNode = { id: 'n1', name: 'N1', type: 'work', x: 1, y: 2, angle: 0.5 }
  const edge: FactoryMapEdge = {
    id: 'e1', name: 'E1', edgeType: 'LINE',
    sx: 1, sy: 2, ex: 3, ey: 4,
    cx: null, cy: null, dx: null, dy: null,
    isBackEdge: false, snodeId: 'n1', enodeId: 'n1',
  }

  it('深度冻结实体、集合与元素', () => {
    const map = createFactoryMap([node], [edge])
    expect(Object.isFrozen(map)).toBe(true)
    expect(Object.isFrozen(map.nodes)).toBe(true)
    expect(Object.isFrozen(map.edges)).toBe(true)
    expect(Object.isFrozen(map.nodes[0])).toBe(true)
    expect(Object.isFrozen(map.edges[0])).toBe(true)
  })

  it('复制输入集合：外部数组后续变化不影响实体', () => {
    const nodes = [node]
    const edges: FactoryMapEdge[] = []
    const map = createFactoryMap(nodes, edges)
    nodes.push({ id: 'n2', name: 'N2', type: 'node', x: 0, y: 0, angle: null })
    expect(map.nodes).toHaveLength(1)
    expect(map.edges).toHaveLength(0)
  })
})
