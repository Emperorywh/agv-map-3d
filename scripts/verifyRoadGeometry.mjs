/**
 * 道路重构回归：复用 Vite 的真实模块解析与路径别名，不新增测试框架。
 * 覆盖分类边界、道路并集、转弯闭环、方向保留及真实地图资源释放。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'vite'

const server = await createServer({
  cacheDir: 'node_modules/.tmp/road-tests-vite',
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
})

try {
  const { validateMap } = await server.ssrLoadModule('/src/features/map-visualization/model/validateMap.ts')
  const { createMapModel } = await server.ssrLoadModule('/src/features/map-visualization/model/createMapModel.ts')
  const { buildMapGeometry, dedupePhysicalPaths } = await server.ssrLoadModule('/src/features/map-visualization/scene/buildMapGeometry.ts')
  const { buildRoadNetwork } = await server.ssrLoadModule('/src/features/map-visualization/scene/roadTopology.ts')
  const { classifyRoadPaths } = await server.ssrLoadModule('/src/features/map-visualization/scene/roadPresentation.ts')
  const { bufferRoadPolyline, unionRoadPolygons } = await server.ssrLoadModule('/src/features/map-visualization/scene/roadGeometry.ts')
  let checks = 0
  const check = (label, test) => {
    test()
    checks += 1
    console.log(`通过：${label}`)
  }

  /**
   * 测试只构造最小合法原始数据，仍经过生产校验、模型与拓扑流程。
   * 导航点使用未知业务类型，避免把测试主路端点误当成实际库位。
   */
  function fixture(nodes, connections) {
    const nodeList = nodes.map(([id, x, y, type = 'navigation']) => ({ id, x, y, type, mapId: 'road-test' }))
    const byId = new Map(nodeList.map((node) => [node.id, node]))
    const edges = connections.map(([id, from, to, bezier]) => {
      const a = byId.get(from)
      const b = byId.get(to)
      return {
        id, mapId: 'road-test', snodeId: from, enodeId: to,
        sx: a.x, sy: a.y, ex: b.x, ey: b.y, edgeType: bezier ? 'BEZIER' : 'LINE',
        cx: bezier?.[0] ?? null, cy: bezier?.[1] ?? null,
        dx: bezier?.[2] ?? null, dy: bezier?.[3] ?? null,
        isBackEdge: id.endsWith('-reverse'),
      }
    })
    return createMapModel(validateMap({ nodes: nodeList, edges }))
  }
  const model = fixture(
    [['a', -10, 0], ['b', 0, 0], ['c', 10, 0], ['d', 0, 4], ['w', 0, -2, 'warehouse']],
    [['ab', 'a', 'b'], ['ab-reverse', 'b', 'a'], ['bc', 'b', 'c'], ['bd', 'b', 'd'], ['bw', 'b', 'w']],
  )
  const physical = dedupePhysicalPaths(model.mapModel)
  const network = buildRoadNetwork(model.mapModel, physical)
  const roles = classifyRoadPaths(model.mapModel, physical, network)
  const roleOf = (id, source = roles) => source.get(physical.physicalPathIndexOfEdge.get(id))
  check('主通道、支路与库位接入分级，不以方向或限速推导宽度', () => {
    assert.equal(roleOf('ab'), 'main')
    assert.equal(roleOf('bc'), 'main')
    assert.equal(roleOf('bd'), 'branch')
    assert.equal(roleOf('bw'), 'access')
  })
  check('正反向只去重几何，逻辑方向完整保留', () => {
    assert.equal(physical.physicalPaths.length, 4)
    assert.equal(physical.physicalPathIndexOfEdge.size, 5)
    assert.equal(model.mapModel.edges.get('ab-reverse').snodeId, 'b')
    assert.equal(model.mapModel.edges.get('ab-reverse').isBackEdge, true)
  })
  check('显式分级覆盖与冲突收窄', () => {
    const configured = classifyRoadPaths(model.mapModel, physical, network, new Map([
      ['ab', 'main'], ['ab-reverse', 'access'], ['bd', 'main'],
    ]))
    assert.equal(roleOf('ab', configured), 'access')
    assert.equal(roleOf('bd', configured), 'main')
  })
  check('经过 work 控制点的短库位末梢仍保留接入角色', () => {
    const stub = fixture(
      [['a', -10, 0], ['b', 0, 0], ['c', 10, 0], ['s', 0, 1.5, 'work'], ['w', 0, 2, 'warehouse']],
      [['ab', 'a', 'b'], ['bc', 'b', 'c'], ['bs', 'b', 's'], ['sw', 's', 'w']],
    )
    const paths = dedupePhysicalPaths(stub.mapModel)
    const classified = classifyRoadPaths(stub.mapModel, paths, buildRoadNetwork(stub.mapModel, paths))
    assert.equal(classified.get(paths.physicalPathIndexOfEdge.get('bs')), 'access')
  })
  check('长库位巷道不被短末梢规则逐段剥离', () => {
    const lane = fixture(
      [['a', 0, 0, 'work'], ['b', 2, 0, 'work'], ['c', 4, 0, 'work'], ['d', 20, 0, 'work']],
      [['ab', 'a', 'b'], ['bc', 'b', 'c'], ['cd', 'c', 'd']],
    )
    const paths = dedupePhysicalPaths(lane.mapModel)
    const classified = classifyRoadPaths(lane.mapModel, paths, buildRoadNetwork(lane.mapModel, paths))
    assert.equal(classified.get(paths.physicalPathIndexOfEdge.get('ab')), 'main')
    assert.equal(classified.get(paths.physicalPathIndexOfEdge.get('bc')), 'main')
    assert.equal(classified.get(paths.physicalPathIndexOfEdge.get('cd')), 'main')
  })

  /**
   * 直接检验并集边界：十字中央必须没有内部截线，平行道路不能凭空连通。
   * 三角形面积与多边形面积互相校验，避免孔洞处理或三角化产生隐藏错误。
   */
  const signedArea = (ring) => ring.reduce((sum, p, i) => {
    const next = ring[(i + 1) % ring.length]
    return sum + p[0] * next[1] - next[0] * p[1]
  }, 0) / 2
  const area = (polygons) => polygons.reduce((total, rings) => total + Math.abs(signedArea(rings[0])) - rings.slice(1).reduce((sum, ring) => sum + Math.abs(signedArea(ring)), 0), 0)
  check('十字路口内部白边被裁掉', () => {
    const cross = unionRoadPolygons([
      ...bufferRoadPolyline([[-4, 0], [4, 0]], 0.5),
      ...bufferRoadPolyline([[0, -4], [0, 4]], 0.5),
    ])
    assert.equal(cross.length, 1)
    assert.equal(cross[0].length, 1)
    assert.ok(Math.abs(area(cross) - 15) < 1e-4)
    for (const p of cross[0][0]) assert.ok(Math.abs(p[0]) >= 0.5 || Math.abs(p[1]) >= 0.5)
  })
  check('平行道路不跨空地合并；闭环保留内孔', () => {
    const parallel = unionRoadPolygons([
      ...bufferRoadPolyline([[0, 0], [10, 0]], 0.5),
      ...bufferRoadPolyline([[0, 3], [10, 3]], 0.5),
    ])
    assert.equal(parallel.length, 2)
    const loop = unionRoadPolygons(bufferRoadPolyline([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], 0.5))
    assert.equal(loop[0].length, 2)
    assert.ok(area(loop) > 39 && area(loop) < 41)
  })
  check('急弯、回折、零长度、近重合与空输入产生有限几何', () => {
    assert.deepEqual(bufferRoadPolyline([[0, 0], [0, 0]], 0.5), [])
    assert.deepEqual(unionRoadPolygons([]), [])
    for (const points of [
      [[0, 0], [1, 0], [1, 1]],
      [[0, 0], [0, 0], [1, 0], [0.001, 0.001]],
      [[0, 0], [0.00001, 0], [0.00002, 0]],
    ]) {
      const polygons = unionRoadPolygons(bufferRoadPolyline(points, 0.5))
      for (const number of polygons.flat(3)) assert.ok(Number.isFinite(number))
      for (const p of polygons.flat(2)) assert.ok(Math.abs(p[0]) < 2 && Math.abs(p[1]) < 2)
    }
  })
  check('贝塞尔保持全部采样点，不以直线替换曲线', () => {
    const curved = fixture([['a', 0, 0], ['b', 4, 4]], [['curve', 'a', 'b', [3, 0, 4, 1]]])
    const paths = dedupePhysicalPaths(curved.mapModel)
    assert.equal(paths.physicalPaths[0].points.length, 25)
    const before = JSON.stringify(paths.physicalPaths)
    buildMapGeometry(curved.mapModel, curved.worldTransform).dispose()
    assert.equal(JSON.stringify(paths.physicalPaths), before)
  })

  const keys = ['roadSurface', 'roadBoundaries', 'roadGuides', 'roadJunctionLights']
  function assertGeometry(geometry) {
    for (const key of keys) {
      const buffer = geometry[key]
      assert.equal(buffer.index.count % 3, 0)
      for (const number of buffer.attributes.position.array) assert.ok(Number.isFinite(number), `${key} 非有限顶点`)
      for (const index of buffer.index.array) assert.ok(index < buffer.attributes.position.count, `${key} 越界索引`)
      if (buffer.attributes.color) assert.equal(buffer.attributes.color.count, buffer.attributes.position.count)
    }
    assert.equal('pathDirectionArrows' in geometry, false)
    assert.equal('pathCenterLines' in geometry, false)
  }
  /**
   * 接入角色不能再让道路消失：即使全图被归为接入，也必须具有路面和白边。
   * 引导线的顶点与透明度不受分级覆盖影响，防止车辆行驶到几乎不可见的路径上。
   */
  check('全接入图完整生成路面、白边和清晰轨迹', () => {
    const access = buildMapGeometry(model.mapModel, model.worldTransform, new Map(model.mapModel.edgeList.map((edge) => [edge.id, 'access'])))
    const normal = buildMapGeometry(model.mapModel, model.worldTransform)
    assertGeometry(access)
    assert.ok(access.roadSurface.index.count > 0)
    assert.ok(access.roadBoundaries.index.count > 0)
    assert.ok(access.roadGuides.index.count > 0)
    assert.deepEqual(access.roadGuides.attributes.position.array, normal.roadGuides.attributes.position.array)
    assert.deepEqual(access.roadGuides.attributes.color.array, normal.roadGuides.attributes.color.array)
    for (let i = 3; i < access.roadGuides.attributes.color.array.length; i += 4) {
      assert.ok(access.roadGuides.attributes.color.array[i] >= 0.85)
    }
    access.dispose()
    normal.dispose()
  })
  const raw = JSON.parse(fs.readFileSync(new URL('../json/map.json', import.meta.url), 'utf8'))
  const full = createMapModel(validateMap(raw))
  const snapshot = JSON.stringify([full.mapModel.nodeList, full.mapModel.edgeList, [...full.mapModel.outEdgeIds]])
  const started = performance.now()
  const geometry = buildMapGeometry(full.mapModel, full.worldTransform)
  const buildMs = performance.now() - started
  check('真实地图全量构建、逻辑方向与数据不变', () => {
    assertGeometry(geometry)
    assert.equal(geometry.physical.physicalPathIndexOfEdge.size, full.mapModel.edgeList.length)
    assert.equal(JSON.stringify([full.mapModel.nodeList, full.mapModel.edgeList, [...full.mapModel.outEdgeIds]]), snapshot)
    assert.equal(geometry.roadRoles.size, geometry.physical.physicalPaths.length)
    assert.ok(buildMs < 10000, `全量构建耗时异常：${buildMs.toFixed(0)}ms`)
  })
  /**
   * 直接检查最终三角形覆盖真实路径，不再仅凭索引数量判断“路径已显示”。
   * 空间网格限制点在三角形内的查询成本，容差仅覆盖整数包络和浮点缓冲误差。
   */
  function triangleCoverage(buffer) {
    const cellSize = 2
    const tolerance = 0.0002
    const cells = new Map()
    const positions = buffer.attributes.position.array
    const indices = buffer.index.array
    for (let i = 0; i < indices.length; i += 3) {
      const triangle = [...indices.slice(i, i + 3)].map((index) => [positions[index * 3], positions[index * 3 + 2]])
      /**
       * 零面积三角形没有可见覆盖，不能把三条边距离同为零误判成有效路面。
       * 容差只用于有效三角形的边缘，不用于扩大退化几何的覆盖范围。
       */
      const [a, b, c] = triangle
      if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 1e-12) continue
      const minX = Math.floor((Math.min(...triangle.map((point) => point[0])) - tolerance) / cellSize)
      const maxX = Math.floor((Math.max(...triangle.map((point) => point[0])) + tolerance) / cellSize)
      const minZ = Math.floor((Math.min(...triangle.map((point) => point[1])) - tolerance) / cellSize)
      const maxZ = Math.floor((Math.max(...triangle.map((point) => point[1])) + tolerance) / cellSize)
      for (let x = minX; x <= maxX; x += 1) {
        for (let z = minZ; z <= maxZ; z += 1) {
          const key = `${x},${z}`
          const list = cells.get(key) ?? []
          list.push(triangle)
          cells.set(key, list)
        }
      }
    }
    return (point) => (cells.get(`${Math.floor(point.x / cellSize)},${Math.floor(point.z / cellSize)}`) ?? []).some((triangle) => {
      const sides = triangle.map((a, i) => {
        const b = triangle[(i + 1) % 3]
        return ((b[0] - a[0]) * (point.z - a[1]) - (b[1] - a[1]) * (point.x - a[0])) /
          Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), 1e-12)
      })
      return sides.every((side) => side >= -tolerance) || sides.every((side) => side <= tolerance)
    })
  }
  check('全部真实路径的采样点及段中点都落在路面和引导几何上', () => {
    const onSurface = triangleCoverage(geometry.roadSurface)
    const onGuide = triangleCoverage(geometry.roadGuides)
    for (const path of geometry.physical.physicalPaths) {
      const samples = [...path.points]
      for (let i = 1; i < path.points.length; i += 1) {
        const a = path.points[i - 1]
        const b = path.points[i]
        samples.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
      }
      for (const point of samples) {
        const world = full.worldTransform.toWorldXZ(point.x, point.y)
        assert.ok(onSurface(world), `缺失路面：${path.representativeEdgeId}，坐标 ${point.x},${point.y}`)
        assert.ok(onGuide(world), `缺失引导：${path.representativeEdgeId}，坐标 ${point.x},${point.y}`)
      }
    }
  })
  check('全部道路 GPU 几何只释放一次', () => {
    const disposed = new Map(keys.map((key) => [key, 0]))
    for (const key of keys) geometry[key].addEventListener('dispose', () => disposed.set(key, disposed.get(key) + 1))
    geometry.dispose()
    geometry.dispose()
    for (const count of disposed.values()) assert.equal(count, 1)
  })
  console.log(`道路回归完成：${checks} 项；真实地图构建 ${buildMs.toFixed(0)}ms；分级 ${JSON.stringify([...geometry.roadRoles.values()].reduce((counts, role) => ({ ...counts, [role]: (counts[role] ?? 0) + 1 }), {}))}`)
} finally {
  await server.close()
}
