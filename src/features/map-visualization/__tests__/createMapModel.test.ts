/*
 * 只读 MapModel 构建测试（与实现共置）。
 *
 * 职责：锁定 TASK-003 的派生模型合同：物理长度口径、有向出边、弱连通分量
 *       （含 charge 查询与稳定编号）、世界原点与场景包围盒、组合仿射与方向
 *       符号，以及「顺序无关」与「深度冻结」两个关键不变量。
 * 关键不变量（SPEC §2.5、§5.5、§9.1～§9.2）：
 * 1. 原点只来自节点包围盒中心，与节点遍历顺序无关；
 * 2. rotation.y = -平面角（世界映射唯一符号换算点），镜像与旋转按固定顺序
 *    参与方向合成；
 * 3. 分量覆盖全部节点，按节点数降序稳定编号；出边索引只含出边方向。
 */
import { describe, expect, it } from 'vitest'
import { createMapModel } from '@/features/map-visualization/model/createMapModel'
import { validateMap } from '@/features/map-visualization/model/validateMap'
import { BEZIER_SAMPLE_SEGMENTS, sampleCubicBezier } from '@/features/map-visualization/model/edgeGeometry'
import type { AffineParams } from '@/shared/spatial'
import { makeBezierEdge, makeGroup, makeLineEdge, makeNode } from './fixtures'

function rawMap(nodes: unknown[], edges: unknown[], nodeEdgeGroups: unknown[] = []): unknown {
  return { nodes, edges, zones: [], nodeEdgeGroups }
}

/** 两分量 + 孤立节点 fixture：
 *  分量0：a-b-c（a、b、c 依次相连，c 为 charge）共 3 节点 2 边
 *  分量1：d-e（d 为 charge）共 2 节点 1 边
 *  孤立：s（无任何边，park） */
function multiComponentMap(): unknown {
  return rawMap(
    [
      makeNode({ id: 'a', name: 'A', x: 0, y: 0 }),
      makeNode({ id: 'b', name: 'B', x: 3, y: 4 }),
      makeNode({ id: 'c', name: 'C', type: 'charge', x: 6, y: 0 }),
      makeNode({ id: 'd', name: 'D', type: 'charge', x: 100, y: 0 }),
      makeNode({ id: 'e', name: 'E', x: 103, y: 4 }),
      makeNode({ id: 's', name: 'S', type: 'park', x: -50, y: -50 }),
    ],
    [
      makeLineEdge({ id: 'e-ab', snodeId: 'a', enodeId: 'b' }),
      makeLineEdge({ id: 'e-bc', snodeId: 'b', enodeId: 'c' }),
      makeLineEdge({ id: 'e-de', snodeId: 'd', enodeId: 'e' }),
      makeLineEdge({ id: 'e-back', snodeId: 'b', enodeId: 'a', isBackEdge: true }),
    ],
    [makeGroup({ id: 'g1', nodeIds: ['a', 'b', 'c'], edgeIds: ['e-ab', 'e-bc', 'e-back'] })],
  )
}

describe('createMapModel：索引与有向出边', () => {
  it('建立 node/edge/group 索引；出边索引只含出边方向，无出边节点为空数组', () => {
    const { mapModel } = createMapModel(validateMap(multiComponentMap()))
    expect(mapModel.nodes.get('a')?.name).toBe('A')
    expect(mapModel.edges.get('e-ab')?.enodeId).toBe('b')
    expect(mapModel.groups.get('g1')?.memberNodeIds).toEqual(['a', 'b', 'c'])

    // b 有两条出边（正向 e-bc 与反向 e-back）；c 只有入边；a 有正向出边 e-ab
    expect(mapModel.outEdgeIds.get('a')).toEqual(['e-ab'])
    expect(mapModel.outEdgeIds.get('b')).toEqual(['e-bc', 'e-back'])
    expect(mapModel.outEdgeIds.get('c')).toEqual([])
    expect(mapModel.outEdgeIds.get('s')).toEqual([])

    // 出边总数必须等于逻辑边总数（每条边恰好计入一次起点）
    let total = 0
    for (const list of mapModel.outEdgeIds.values()) {
      total += list.length
    }
    expect(total).toBe(mapModel.edgeList.length)
  })

  it('弱连通分量覆盖全部节点、按节点数降序编号，charge 查询与边计数正确', () => {
    const { mapModel } = createMapModel(validateMap(multiComponentMap()))
    expect(mapModel.components.map((component) => component.nodeIds.length)).toEqual([3, 2, 1])
    expect(mapModel.components[0].nodeIds).toEqual(['a', 'b', 'c'])
    expect(mapModel.components[0].chargeNodeIds).toEqual(['c'])
    expect(mapModel.components[0].edgeCount).toBe(3)
    expect(mapModel.components[1].nodeIds).toEqual(['d', 'e'])
    expect(mapModel.components[1].chargeNodeIds).toEqual(['d'])
    expect(mapModel.components[2].nodeIds).toEqual(['s'])
    expect(mapModel.components[2].chargeNodeIds).toEqual([])
    expect(mapModel.components[2].edgeCount).toBe(0)

    // componentIndexOfNode 全覆盖且与分量编号一致
    for (const component of mapModel.components) {
      for (const nodeId of component.nodeIds) {
        expect(mapModel.componentIndexOfNode.get(nodeId)).toBe(component.index)
      }
    }
  })

  it('同尺寸分量按最小节点插入序稳定编号（顺序无关的决胜规则）', () => {
    const data = validateMap(
      rawMap(
        [
          makeNode({ id: 'p', type: 'charge', x: 0, y: 0 }),
          makeNode({ id: 'q', x: 1, y: 0 }),
          makeNode({ id: 'r', x: 10, y: 0 }),
          makeNode({ id: 't', x: 11, y: 0 }),
        ],
        [
          makeLineEdge({ id: 'e-pq', snodeId: 'p', enodeId: 'q' }),
          makeLineEdge({ id: 'e-rt', snodeId: 'r', enodeId: 't' }),
        ],
      ),
    )
    const { mapModel } = createMapModel(data)
    expect(mapModel.components).toHaveLength(2)
    expect(mapModel.components[0].nodeIds).toEqual(['p', 'q'])
    expect(mapModel.components[1].nodeIds).toEqual(['r', 't'])
  })
})

describe('createMapModel：物理长度（TASK-003 口径）', () => {
  it('LINE 为端点直线距离', () => {
    const { mapModel } = createMapModel(validateMap(rawMap(
      [makeNode({ id: 'a' }), makeNode({ id: 'b', x: 3, y: 4 })],
      [makeLineEdge({ sx: 0, sy: 0, ex: 3, ey: 4 })],
    )))
    expect(mapModel.edgeList[0].length).toBe(5)
  })

  it('BEZIER 为固定 24 段采样折线长度：直线控制点时等于弦长，曲线时大于弦长', () => {
    const straight = createMapModel(validateMap(rawMap(
      [makeNode({ id: 'a' }), makeNode({ id: 'b', x: 3, y: 0 })],
      [makeBezierEdge({ sx: 0, sy: 0, cx: 1, cy: 0, dx: 2, dy: 0, ex: 3, ey: 0 })],
    )))
    expect(straight.mapModel.edgeList[0].length).toBeCloseTo(3, 10)

    const curved = createMapModel(validateMap(rawMap(
      [makeNode({ id: 'a' }), makeNode({ id: 'b', x: 3, y: 0 })],
      [makeBezierEdge({ cx: 1, cy: 5, dx: 2, dy: 5 })],
    )))
    expect(curved.mapModel.edgeList[0].length).toBeGreaterThan(3)
  })

  it('采样函数恒返回 segments+1 个点且端点无漂移', () => {
    const points = sampleCubicBezier(0, 0, 1, 5, 2, 5, 3, 0, BEZIER_SAMPLE_SEGMENTS)
    expect(points).toHaveLength(BEZIER_SAMPLE_SEGMENTS + 1)
    expect(points[0]).toEqual({ x: 0, y: 0 })
    expect(points[points.length - 1]).toEqual({ x: 3, y: 0 })
  })
})

describe('createMapModel：世界原点与场景包围盒', () => {
  it('恒等变换下原点为节点包围盒中心，世界坐标符合 §2.5 公式', () => {
    const { mapModel, worldTransform } = createMapModel(validateMap(rawMap(
      [
        makeNode({ id: 'a', x: 0, y: 0 }),
        makeNode({ id: 'b', x: 2, y: 0 }),
        makeNode({ id: 'c', x: 1, y: 3 }),
      ],
      [],
    )))
    expect(worldTransform.origin).toEqual({ x: 1, y: 1.5 })
    expect(worldTransform.toWorldXZ(2, 0)).toEqual({ x: 1, z: -1.5 })
    expect(mapModel.sceneBounds).toMatchObject({
      minWorldX: -1,
      maxWorldX: 1,
      minWorldZ: -1.5,
      maxWorldZ: 1.5,
      centerWorldX: 0,
      centerWorldZ: 0,
      diagonal: Math.hypot(2, 3),
    })
  })

  it('原点与包围盒与节点遍历顺序无关（车辆到达顺序不得改变世界原点）', () => {
    const nodes = [
      makeNode({ id: 'a', x: 0, y: 0 }),
      makeNode({ id: 'b', x: 2, y: 0 }),
      makeNode({ id: 'c', x: 1, y: 3 }),
    ]
    const forward = createMapModel(validateMap(rawMap(nodes, [])))
    const shuffled = createMapModel(validateMap(rawMap([nodes[2], nodes[0], nodes[1]], [])))
    expect(shuffled.worldTransform.origin).toEqual(forward.worldTransform.origin)
    expect(shuffled.mapModel.sceneBounds).toEqual(forward.mapModel.sceneBounds)
  })

  it('组合仿射（scale=2、rotation=π/2、mirrorY、平移）按固定顺序作用于原点与坐标', () => {
    const transform: AffineParams = { scale: 2, rotation: Math.PI / 2, mirrorY: true, translateX: 10, translateY: 20 }
    const { worldTransform, mapModel } = createMapModel(
      validateMap(
        rawMap(
          [
            makeNode({ id: 'a', x: 0, y: 0 }),
            makeNode({ id: 'b', x: 2, y: 0 }),
            makeNode({ id: 'c', x: 2, y: 1 }),
          ],
          [],
        ),
      ),
      { coordinateTransform: transform },
    )
    // 包围盒中心 (1,0.5)：镜像 → (1,-0.5)；旋转 90° → (0.5,1)；缩放 → (1,2)；平移 → (11,22)
    expect(worldTransform.origin).toEqual({ x: 11, y: 22 })
    // 节点 (2,0)：镜像不变 → 旋转 90° (0,2) → 缩放 (0,4) → 平移 (10,24) → 世界 (−1,2)
    expect(worldTransform.toWorldXZ(2, 0)).toEqual({ x: -1, z: 2 })
    // 节点 (0,0) → 平移 (10,20) → 世界 (−1,−2)
    expect(worldTransform.toWorldXZ(0, 0)).toEqual({ x: -1, z: -2 })
    // 节点 (2,1)：镜像 (2,−1) → 旋转 (1,2) → 缩放 (2,4) → 平移 (12,24) → 世界 (1,2)
    expect(worldTransform.toWorldXZ(2, 1)).toEqual({ x: 1, z: 2 })
    expect(mapModel.sceneBounds).toMatchObject({
      minWorldX: -1,
      maxWorldX: 1,
      minWorldZ: -2,
      maxWorldZ: 2,
      centerWorldX: 0,
      centerWorldZ: 0,
      diagonal: Math.hypot(2, 4),
    })
  })

  it('方向符号：恒等下 rotation.y = -θ；仅旋转 α 时为 -(θ+α)；镜像参与方向合成', () => {
    const identity = createMapModel(validateMap(rawMap([makeNode({ id: 'a' })], [])))
    expect(identity.worldTransform.angleToWorldYRotation(Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 12)
    expect(identity.worldTransform.angleToWorldYRotation(0)).toBeCloseTo(0, 12)

    const rotated = createMapModel(validateMap(rawMap([makeNode({ id: 'a' })], [])), {
      coordinateTransform: { scale: 1, rotation: Math.PI / 2, mirrorY: false, translateX: 0, translateY: 0 },
    })
    expect(rotated.worldTransform.angleToWorldYRotation(0)).toBeCloseTo(-Math.PI / 2, 12)

    // 镜像：θ 先翻转为 -θ 再加旋转；rotation.y = -(α - θ) = θ - α
    const mirrored = createMapModel(validateMap(rawMap([makeNode({ id: 'a' })], [])), {
      coordinateTransform: { scale: 1, rotation: 0, mirrorY: true, translateX: 0, translateY: 0 },
    })
    expect(mirrored.worldTransform.angleToWorldYRotation(Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12)
  })

  it('空地图回退为全零退化包围盒与原点，不产生 NaN', () => {
    const { mapModel, worldTransform } = createMapModel(validateMap(rawMap([], [])))
    expect(worldTransform.origin).toEqual({ x: 0, y: 0 })
    expect(mapModel.sceneBounds).toMatchObject({
      minWorldX: 0,
      maxWorldX: 0,
      minWorldZ: 0,
      maxWorldZ: 0,
      diagonal: 0,
    })
    expect(mapModel.components).toHaveLength(0)
  })
})

describe('createMapModel：不可变模型', () => {
  it('模型、条目、分量与包围盒全部冻结，构建期可变容器不外泄', () => {
    const { mapModel } = createMapModel(validateMap(multiComponentMap()))
    expect(Object.isFrozen(mapModel)).toBe(true)
    expect(Object.isFrozen(mapModel.nodeList)).toBe(true)
    expect(Object.isFrozen(mapModel.edgeList)).toBe(true)
    expect(Object.isFrozen(mapModel.groupList)).toBe(true)
    expect(Object.isFrozen(mapModel.components)).toBe(true)
    expect(Object.isFrozen(mapModel.components[0])).toBe(true)
    expect(Object.isFrozen(mapModel.components[0].nodeIds)).toBe(true)
    expect(Object.isFrozen(mapModel.sceneBounds)).toBe(true)
    expect(Object.isFrozen(mapModel.nodes.get('a'))).toBe(true)
    expect(Object.isFrozen(mapModel.edges.get('e-ab'))).toBe(true)
    expect(Object.isFrozen(mapModel.outEdgeIds.get('a'))).toBe(true)
  })

  it('mapId 与输入数据一致并在模型上可直接读取', () => {
    const { mapModel } = createMapModel(validateMap(multiComponentMap()))
    expect(mapModel.mapId).toBe('m1')
  })
})

/* ==== 节点展示语义角色（视觉对齐 P0-5.4） ==== */

describe('createMapModel：nodeVisualRoles', () => {
  it('work 类别按度数细分：主干走廊交汇（≥5 邻居）为工位，其余为库位取放点', () => {
    // hub 为六岔 work 主干交汇；t（3 邻居）与 a（1 邻居）为普通取放点
    const { mapModel } = createMapModel(
      validateMap(
        rawMap(
          [
            makeNode({ id: 'hub', type: 'work', x: 0, y: 0 }),
            makeNode({ id: 'n1', type: 'work', x: 5, y: 0 }),
            makeNode({ id: 'n2', type: 'work', x: -5, y: 0 }),
            makeNode({ id: 'n3', type: 'work', x: 0, y: 5 }),
            makeNode({ id: 'n4', type: 'work', x: 0, y: -5 }),
            makeNode({ id: 'n5', type: 'work', x: 3, y: 3 }),
            makeNode({ id: 'n6', type: 'work', x: -3, y: -3 }),
            makeNode({ id: 't', type: 'work', x: 50, y: 0 }),
            makeNode({ id: 't1', type: 'work', x: 55, y: 0 }),
            makeNode({ id: 't2', type: 'work', x: 50, y: 5 }),
            makeNode({ id: 'a', name: 'A', x: 100, y: 0 }),
            makeNode({ id: 'b', name: 'B', x: 103, y: 4 }),
            makeNode({ id: 'c', name: 'C', type: 'charge', x: 106, y: 0 }),
          ],
          [
            makeLineEdge({ id: 'eh1', snodeId: 'hub', enodeId: 'n1', sx: 0, sy: 0, ex: 5, ey: 0 }),
            makeLineEdge({ id: 'eh2', snodeId: 'hub', enodeId: 'n2', sx: 0, sy: 0, ex: -5, ey: 0 }),
            makeLineEdge({ id: 'eh3', snodeId: 'hub', enodeId: 'n3', sx: 0, sy: 0, ex: 0, ey: 5 }),
            makeLineEdge({ id: 'eh4', snodeId: 'hub', enodeId: 'n4', sx: 0, sy: 0, ex: 0, ey: -5 }),
            makeLineEdge({ id: 'eh5', snodeId: 'hub', enodeId: 'n5', sx: 0, sy: 0, ex: 3, ey: 3 }),
            makeLineEdge({ id: 'eh6', snodeId: 'hub', enodeId: 'n6', sx: 0, sy: 0, ex: -3, ey: -3 }),
            makeLineEdge({ id: 'et1', snodeId: 't', enodeId: 't1', sx: 50, sy: 0, ex: 55, ey: 0 }),
            makeLineEdge({ id: 'et2', snodeId: 't', enodeId: 't2', sx: 50, sy: 0, ex: 50, ey: 5 }),
            makeLineEdge({ id: 'e-ab', snodeId: 'a', enodeId: 'b' }),
            makeLineEdge({ id: 'e-bc', snodeId: 'b', enodeId: 'c' }),
          ],
          [],
        ),
      ),
    )
    expect(mapModel.nodeVisualRoles.get('hub')).toBe('work-station')
    expect(mapModel.nodeVisualRoles.get('t')).toBe('storage-slot')
    expect(mapModel.nodeVisualRoles.get('n1')).toBe('storage-slot')
    expect(mapModel.nodeVisualRoles.get('a')).toBe('storage-slot')
    expect(mapModel.nodeVisualRoles.get('b')).toBe('storage-slot')
    expect(mapModel.nodeVisualRoles.get('c')).toBe('charge')
  })

  it('charge/park 恒为对应业务角色', () => {
    const { mapModel } = createMapModel(validateMap(multiComponentMap()))
    expect(mapModel.nodeVisualRoles.get('c')).toBe('charge')
    expect(mapModel.nodeVisualRoles.get('s')).toBe('park')
  })

  it('unknown 类别按去重邻居度数二分：≥3 为 junction，≤2 为 route-control', () => {
    // x 为四岔 unknown 节点；tip 为一度 unknown 节点；pair 为二度 unknown 节点
    const { mapModel } = createMapModel(
      validateMap(
        rawMap(
          [
            makeNode({ id: 'x', type: 'robot', x: 0, y: 0 }),
            makeNode({ id: 'n1', type: 'robot', x: 5, y: 0 }),
            makeNode({ id: 'n2', type: 'robot', x: -5, y: 0 }),
            makeNode({ id: 'n3', type: 'robot', x: 0, y: 5 }),
            makeNode({ id: 'n4', type: 'robot', x: 0, y: -5 }),
            makeNode({ id: 'pair-a', type: 'robot', x: 50, y: 0 }),
            makeNode({ id: 'pair-b', type: 'robot', x: 55, y: 0 }),
          ],
          [
            makeLineEdge({ id: 'ex1', snodeId: 'x', enodeId: 'n1', sx: 0, sy: 0, ex: 5, ey: 0 }),
            makeLineEdge({ id: 'ex2', snodeId: 'x', enodeId: 'n2', sx: 0, sy: 0, ex: -5, ey: 0 }),
            makeLineEdge({ id: 'ex3', snodeId: 'x', enodeId: 'n3', sx: 0, sy: 0, ex: 0, ey: 5 }),
            makeLineEdge({ id: 'ex4', snodeId: 'x', enodeId: 'n4', sx: 0, sy: 0, ex: 0, ey: -5 }),
            makeLineEdge({ id: 'ep', snodeId: 'pair-a', enodeId: 'pair-b', sx: 50, sy: 0, ex: 55, ey: 0 }),
          ],
          [],
        ),
      ),
    )
    expect(mapModel.nodeVisualRoles.get('x')).toBe('junction')
    expect(mapModel.nodeVisualRoles.get('pair-a')).toBe('route-control')
    expect(mapModel.nodeVisualRoles.get('pair-b')).toBe('route-control')
  })

  it('度数按无序邻居对去重：正反向边不重复计数', () => {
    // a—b 之间正反向两条逻辑边 = 1 个邻居 → a/b 都是 route-control
    const { mapModel } = createMapModel(
      validateMap(
        rawMap(
          [
            makeNode({ id: 'u1', type: 'robot', x: 0, y: 0 }),
            makeNode({ id: 'u2', type: 'robot', x: 4, y: 0 }),
          ],
          [
            makeLineEdge({ id: 'f1', snodeId: 'u1', enodeId: 'u2', sx: 0, sy: 0, ex: 4, ey: 0 }),
            makeLineEdge({ id: 'f2', snodeId: 'u2', enodeId: 'u1', sx: 4, sy: 0, ex: 0, ey: 0, isBackEdge: true }),
          ],
          [],
        ),
      ),
    )
    expect(mapModel.nodeVisualRoles.get('u1')).toBe('route-control')
    expect(mapModel.nodeVisualRoles.get('u2')).toBe('route-control')
  })

  it('角色索引覆盖全部节点且冻结', () => {
    const { mapModel } = createMapModel(validateMap(multiComponentMap()))
    expect(mapModel.nodeVisualRoles.size).toBe(mapModel.nodeList.length)
    expect(Object.isFrozen(mapModel)).toBe(true)
  })
})
