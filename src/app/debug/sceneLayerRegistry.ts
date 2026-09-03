/**
 * 调试图层注册表（项目开发宪法 §8 DEBUG MODE 的图层开关事实源）。
 *
 * 职责：集中声明场景图中可独立开关的图层（对象命名与匹配规则），并提供
 *       「按规则对场景子树批量显隐」的纯遍历函数。图层开关是视觉对齐迭代
 *       的定位工具：逐层排除即可确定某个视觉 artifact 的归属对象。
 * 边界：只依赖最小结构接口（name/visible/children），不导入 Three.js——
 *       THREE.Object3D 天然满足该接口，测试用普通对象即可覆盖；图层清单
 *       必须与各 Feature 图层的场景命名保持同步（命名变更时先改这里）。
 * 关键不变量：
 * 1. 图层之间命名互斥（objectNames 与前缀规则匹配的任一对象至多属于一个
 *       图层），保证开关顺序无关、多次应用幂等；
 * 2. 前缀规则的排除项（excludedNamePrefixes）用于把车体批次与标签/环批次
 *       解耦（fleet-* 同前缀不同语义）；
 * 3. 本模块不持有场景对象引用、不进 React state，每次应用都是一次纯遍历。
 */

/** 场景节点最小结构接口（THREE.Object3D 结构性满足） */
export interface VisibilityNode {
  name: string
  visible: boolean
  children: readonly VisibilityNode[]
}

/** 一个可开关图层的声明：精确命名和/或前缀规则（互斥由 REGISTRY_INVARIANTS 测试保证） */
export interface DebugLayerSpec {
  /** 图层键（Leva 控件键，稳定英文标识） */
  readonly key: string
  /** 图层显示名（面板中文标签） */
  readonly label: string
  /** 精确匹配的场景对象名 */
  readonly objectNames?: readonly string[]
  /** 前缀匹配的场景对象名 */
  readonly objectNamePrefixes?: readonly string[]
  /** 前缀匹配的排除项（优先于 objectNamePrefixes） */
  readonly excludedNamePrefixes?: readonly string[]
}

/** 调试图层清单：与 map-visualization / fleet-monitoring 图层命名同步 */
export const DEBUG_LAYERS: readonly DebugLayerSpec[] = [
  { key: 'roadSurface', label: '路面', objectNames: ['map-path-surface'] },
  { key: 'roadCenterline', label: '道路中线', objectNames: ['map-path-centerline'] },
  { key: 'nodes', label: '节点盘', objectNames: ['map-nodes'] },
  {
    key: 'park',
    label: '停车点',
    objectNames: ['map-park-slabs', 'map-park-halos', 'map-landmark-names'],
  },
  {
    key: 'charge',
    label: '充电设施',
    objectNames: [
      'map-charge-piles',
      'map-charge-rings',
      'map-charge-bolts',
      'map-charge-lights',
    ],
  },
  {
    key: 'vehicles',
    label: '车体',
    objectNamePrefixes: ['fleet-'],
    excludedNamePrefixes: ['fleet-label-'],
  },
  { key: 'vehicleLabels', label: '车辆标签', objectNamePrefixes: ['fleet-label-'] },
]

/**
 * 单节点是否命中图层：精确名优先，其次前缀命中且未被排除。
 * 根节点自身也参与匹配（图层对象通常直接挂在场景根或图层组上）。
 */
export function matchesLayer(node: VisibilityNode, layer: DebugLayerSpec): boolean {
  if (layer.objectNames !== undefined && layer.objectNames.includes(node.name)) {
    return true
  }
  if (layer.objectNamePrefixes === undefined) {
    return false
  }
  if (
    layer.excludedNamePrefixes !== undefined &&
    layer.excludedNamePrefixes.some((prefix) => node.name.startsWith(prefix))
  ) {
    return false
  }
  return layer.objectNamePrefixes.some((prefix) => node.name.startsWith(prefix))
}

/**
 * 对场景子树应用一个图层的显隐，返回受影响对象数（0 表示场景中无该图层
 * 对象——图层未挂载是合法状态，如无车辆数据的车辆图层）。
 */
export function applyLayerVisibility(
  root: VisibilityNode | null,
  layer: DebugLayerSpec,
  visible: boolean,
): number {
  if (root === null) {
    return 0
  }
  let count = 0
  const visit = (node: VisibilityNode): void => {
    if (matchesLayer(node, layer)) {
      node.visible = visible
      count += 1
    }
    for (const child of node.children) {
      visit(child)
    }
  }
  visit(root)
  return count
}

/** 按开关状态应用全部图层，返回「图层键 → 受影响对象数」（诊断/测试用） */
export function applyAllLayerVisibility(
  root: VisibilityNode | null,
  visibleByKey: Readonly<Record<string, boolean>>,
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const layer of DEBUG_LAYERS) {
    const visible = visibleByKey[layer.key] ?? true
    counts[layer.key] = applyLayerVisibility(root, layer, visible)
  }
  return counts
}
