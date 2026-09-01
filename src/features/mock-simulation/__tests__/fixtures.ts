/**
 * mock-simulation 共置测试夹具（仅服务本 Feature 的测试）。
 *
 * 职责：提供最小合成地图构造器（原始 JSON 形态经 validateMap/createMapModel
 *       建模），保持各测试关注点在「哪条规则、哪个结果」上。合成拓扑覆盖：
 *       有向链、成本回退、充电选择、死路与无充电分量等 SPEC §9.1～§9.2
 *       要求的形态。
 * 边界：复用 map-visualization 公开入口的 validateMap/createMapModel（依赖
 *       边界规则允许），不复制校验逻辑；夹具是原始 JSON，字段合法性正是
 *       被测链路的一部分。
 */
import { createMapModel, validateMap, type MapModel, type ValidatedMapData } from '@/features/map-visualization'

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
    cost: null,
    maxLoadSpeed: 1,
    maxFreeSpeed: 1,
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

/** 合成地图原始形态：顶层 mapId 可选（缺省由首节点派生） */
export interface RawMapInput {
  mapId?: unknown
  nodes: unknown[]
  edges?: unknown[]
}

/** 组装 MapModel 并同时返回校验结果（供需要断言异常列表的用例） */
export function buildModelWith(raw: RawMapInput): {
  mapModel: MapModel
  validated: ValidatedMapData
} {
  const validated = validateMap(raw)
  return { mapModel: createMapModel(validated).mapModel, validated }
}

/** 组装只读 MapModel：原始 JSON → validateMap → createMapModel */
export function buildModel(raw: RawMapInput): MapModel {
  return buildModelWith(raw).mapModel
}

