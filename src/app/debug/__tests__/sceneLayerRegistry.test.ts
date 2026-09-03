/*
 * 调试图层注册表测试（与实现共置）。
 *
 * 职责：校验图层匹配规则（精确名/前缀/排除前缀）、批量显隐应用的计数与幂
 *       等，以及注册表自身的关键不变量——图层之间命名互斥（一个对象至多
 *       属于一个图层，保证开关顺序无关）与键/标签唯一。
 * 关键不变量：本模块是 DEBUG MODE 图层开关的事实源，注册表结构错误必须在
 *       单测期暴露而不是开发期踩坑。
 */
import { describe, expect, it } from 'vitest'
import {
  DEBUG_LAYERS,
  applyAllLayerVisibility,
  applyLayerVisibility,
  matchesLayer,
  type DebugLayerSpec,
  type VisibilityNode,
} from '../sceneLayerRegistry'

/** 最小场景树构造器：name(visible)[children…] */
function node(name: string, visible = true, children: VisibilityNode[] = []): VisibilityNode {
  return { name, visible, children }
}

describe('注册表不变量', () => {
  it('图层键与标签唯一', () => {
    const keys = DEBUG_LAYERS.map((layer) => layer.key)
    expect(new Set(keys).size).toBe(keys.length)
    const labels = DEBUG_LAYERS.map((layer) => layer.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('任一对象名至多属于一个图层（图层互斥）', () => {
    // 收集全部图层可能命中的名字样本：精确名 + 前缀展开样本
    const exactNames = DEBUG_LAYERS.flatMap((layer) => layer.objectNames ?? [])
    for (const layer of DEBUG_LAYERS) {
      const samples = new Set<string>([
        ...exactNames,
        ...(layer.objectNamePrefixes ?? []).map((prefix) => `${prefix}sample`),
      ])
      for (const sample of samples) {
        const probe: VisibilityNode = node(sample)
        const hits = DEBUG_LAYERS.filter((candidate) => matchesLayer(probe, candidate))
        expect(hits.map((candidate) => candidate.key), `对象名 ${sample} 命中多个图层`).toHaveLength(1)
      }
    }
  })

  it('每个图层至少声明一种匹配规则', () => {
    for (const layer of DEBUG_LAYERS) {
      const hasRule =
        (layer.objectNames !== undefined && layer.objectNames.length > 0) ||
        (layer.objectNamePrefixes !== undefined && layer.objectNamePrefixes.length > 0)
      expect(hasRule, `图层 ${layer.key} 缺少匹配规则`).toBe(true)
    }
  })
})

describe('matchesLayer', () => {
  const exactLayer: DebugLayerSpec = { key: 'exact', label: '精确', objectNames: ['map-nodes'] }

  it('精确名命中', () => {
    expect(matchesLayer(node('map-nodes'), exactLayer)).toBe(true)
    expect(matchesLayer(node('map-nodes-extra'), exactLayer)).toBe(false)
  })

  const prefixLayer: DebugLayerSpec = {
    key: 'prefix',
    label: '前缀',
    objectNamePrefixes: ['fleet-'],
    excludedNamePrefixes: ['fleet-label-', 'fleet-rings-'],
  }

  it('前缀命中且排除项优先', () => {
    expect(matchesLayer(node('fleet-shell-b0'), prefixLayer)).toBe(true)
    expect(matchesLayer(node('fleet-label-bg-b0'), prefixLayer)).toBe(false)
    expect(matchesLayer(node('fleet-rings-b1'), prefixLayer)).toBe(false)
    expect(matchesLayer(node('traffic-locks'), prefixLayer)).toBe(false)
  })

  it('无匹配规则的图层不命中任何对象', () => {
    expect(matchesLayer(node('anything'), { key: 'empty', label: '空' })).toBe(false)
  })
})

describe('applyLayerVisibility / applyAllLayerVisibility', () => {
  const scene = node(
    'scene-root',
    true,
    [
      node('map-nodes'),
      node('map-path-surface'),
      node('fleet-shell-b0'),
      node('fleet-label-bg-b0'),
      node('group', true, [node('fleet-shell-b1')]),
    ],
  )

  it('按规则批量显隐并返回受影响对象数（含嵌套子树）', () => {
    const root = structuredClone(scene)
    const counts = applyAllLayerVisibility(root, { nodes: false, vehicles: false })
    expect(counts.nodes).toBe(1)
    expect(counts.vehicles).toBe(2)
    const deep = root.children[4].children[0]
    expect(deep.visible).toBe(false)
    expect(root.children[3].visible).toBe(true)
  })

  it('多次应用幂等，恢复显隐回到初值', () => {
    const root = structuredClone(scene)
    const layer = DEBUG_LAYERS.find((candidate) => candidate.key === 'vehicles')
    expect(layer).toBeDefined()
    expect(applyLayerVisibility(root, layer!, false)).toBe(2)
    expect(applyLayerVisibility(root, layer!, false)).toBe(2)
    expect(applyLayerVisibility(root, layer!, true)).toBe(2)
    expect(root.children[2].visible).toBe(true)
  })

  it('开关状态缺省视为可见（visible=true）', () => {
    const root = structuredClone(scene)
    const counts = applyAllLayerVisibility(root, {})
    for (const count of Object.values(counts)) {
      expect(count).toBeGreaterThanOrEqual(0)
    }
    expect(root.children[0].visible).toBe(true)
  })

  it('根为 null 时返回 0 且不抛错', () => {
    const layer = DEBUG_LAYERS[0]
    expect(applyLayerVisibility(null, layer, false)).toBe(0)
    expect(applyAllLayerVisibility(null, {}).nodes).toBe(0)
  })
})
