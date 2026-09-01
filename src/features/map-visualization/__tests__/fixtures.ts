/**
 * map-visualization 共置测试夹具（仅服务本 Feature 的测试）。
 *
 * 职责：提供可组合的原始地图元素构造器与最小合法地图，保持测试关注点
 *       在「哪条规则、哪个结果」上，而不是在每个用例里堆完整字段。
 * 边界：夹具是原始 JSON 形态（字段按 unknown 由 validateMap 裁决），不
 *       预先保证合法性——非法字段正是各用例要验证的对象。
 */

/** 原始节点构造器：字段与当前 map.json 同名（以 unknown 进入校验） */
export function makeNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'n-default',
    name: '默认节点',
    type: 'work',
    mapId: 'm1',
    highPrecision: false,
    x: 0,
    y: 0,
    angle: null,
    ...overrides,
  }
}

/** 原始 LINE 逻辑边构造器：控制点恒为 null（SPEC §2.2 允许的 null） */
export function makeLineEdge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'e-default',
    mapId: 'm1',
    edgeType: 'LINE',
    sx: 0,
    sy: 0,
    ex: 3,
    ey: 4,
    cx: null,
    cy: null,
    dx: null,
    dy: null,
    isBackEdge: false,
    cost: 5,
    maxLoadSpeed: 1,
    maxFreeSpeed: 1,
    maxLoadRotationSpeed: null,
    maxFreeRotationSpeed: null,
    loadSecurity: null,
    freeSecurity: null,
    snodeId: 'a',
    enodeId: 'b',
    ...overrides,
  }
}

/** 原始 BEZIER 逻辑边构造器：四个控制点齐全 */
export function makeBezierEdge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'bz-default',
    mapId: 'm1',
    edgeType: 'BEZIER',
    sx: 0,
    sy: 0,
    ex: 3,
    ey: 0,
    cx: 1,
    cy: 1,
    dx: 2,
    dy: 1,
    isBackEdge: false,
    cost: null,
    maxLoadSpeed: 1,
    maxFreeSpeed: 1,
    snodeId: 'a',
    enodeId: 'b',
    ...overrides,
  }
}

/** 原始独占区分组构造器 */
export function makeGroup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'g1',
    name: '独占区1',
    nodeIds: [],
    edgeIds: [],
    ...overrides,
  }
}
