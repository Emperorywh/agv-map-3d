#!/usr/bin/env node
/**
 * map.json 实测结构分析脚本（SPEC §4.1 / §15.9）。
 *
 * 独立 Node 脚本（不依赖 src / 第三方包），随仓库提交，数据更新后可复跑：
 *   node scripts/analyze-map.mjs
 *
 * 输出 SPEC §4.1 的关键统计：节点/边计数、类型分布、边型、isBackEdge 分布、
 * 无序节点对配对（双向走廊组 / 单向边）、悬空引用、坐标范围。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const mapJsonPath = fileURLToPath(new URL('../public/map.json', import.meta.url))

/** @param {number} value @param {number} digits */
function fixed(value, digits = 2) {
  return value.toFixed(digits)
}

const raw = JSON.parse(readFileSync(mapJsonPath, 'utf8'))
const mapJson = raw?.data?.currentMapInfoVersion?.mapJson
if (!mapJson || !Array.isArray(mapJson.nodes) || !Array.isArray(mapJson.edges)) {
  console.error('map.json 顶层结构缺失：需要 data.currentMapInfoVersion.mapJson.{nodes,edges}')
  process.exit(1)
}

const { nodes, edges } = mapJson

// ---- 节点类型分布 ----
const nodeTypes = new Map()
for (const node of nodes) {
  nodeTypes.set(node.type, (nodeTypes.get(node.type) ?? 0) + 1)
}

// ---- 边型分布 / isBackEdge ----
const edgeTypes = new Map()
let backEdgeTotal = 0
for (const edge of edges) {
  edgeTypes.set(edge.edgeType, (edgeTypes.get(edge.edgeType) ?? 0) + 1)
  if (edge.isBackEdge === true) backEdgeTotal++
}

// ---- 无序节点对配对（SPEC §6.1 走廊配对的统计口径） ----
const nodeIds = new Set(nodes.map((node) => node.id))
const pairGroups = new Map()
let danglingEdges = 0
for (const edge of edges) {
  if (!nodeIds.has(edge.snodeId) || !nodeIds.has(edge.enodeId)) {
    danglingEdges++
    continue
  }
  const key =
    edge.snodeId < edge.enodeId
      ? `${edge.snodeId}|${edge.enodeId}`
      : `${edge.enodeId}|${edge.snodeId}`
  let group = pairGroups.get(key)
  if (group === undefined) {
    group = []
    pairGroups.set(key, group)
  }
  group.push(edge)
}

let pairedGroups = 0
let pairedGroupEdges = 0
let pairedExactlyOneBack = 0
let pairedBothNonBack = 0
let pairedBothBack = 0
let unpairedEdges = 0
let unpairedBackEdges = 0
for (const group of pairGroups.values()) {
  const directions = new Set(group.map((edge) => `${edge.snodeId}>${edge.enodeId}`))
  const backCount = group.filter((edge) => edge.isBackEdge === true).length
  if (directions.size >= 2) {
    pairedGroups++
    pairedGroupEdges += group.length
    if (backCount === 1) pairedExactlyOneBack++
    else if (backCount === 0) pairedBothNonBack++
    else pairedBothBack++
  } else {
    unpairedEdges += group.length
    unpairedBackEdges += backCount
  }
}

// ---- 坐标范围（节点口径，SPEC §4.1 表） ----
let minX = Infinity
let maxX = -Infinity
let minY = Infinity
let maxY = -Infinity
for (const node of nodes) {
  if (typeof node.x !== 'number' || typeof node.y !== 'number') continue
  minX = Math.min(minX, node.x)
  maxX = Math.max(maxX, node.x)
  minY = Math.min(minY, node.y)
  maxY = Math.max(maxY, node.y)
}

// ---- 输出 ----
const type = (name) => nodeTypes.get(name) ?? 0
const edgeType = (name) => edgeTypes.get(name) ?? 0

console.log('map.json 实测统计（SPEC §4.1 复跑口径）')
console.log(`  节点 nodes: ${nodes.length} / 边 edges: ${edges.length}`)
console.log(
  `  节点类型: node ${type('node')} / work ${type('work')} / charge ${type('charge')} / park ${type('park')}`,
)
console.log(`  边类型: LINE ${edgeType('LINE')} / BEZIER ${edgeType('BEZIER')}`)
console.log(`  isBackEdge=true 总数: ${backEdgeTotal}`)
console.log(
  `  配对组（双向走廊）: ${pairedGroups}（恰一 back ${pairedExactlyOneBack} / 双非 back ${pairedBothNonBack} / 双 back ${pairedBothBack}），含 ${pairedGroupEdges} 条有向边`,
)
console.log(`  无配对单向边: ${unpairedEdges}，其中 back ${unpairedBackEdges}`)
console.log(`  悬空引用边（指向不存在节点）: ${danglingEdges}`)
console.log(`  坐标范围: x ∈ [${fixed(minX)}, ${fixed(maxX)}]，y ∈ [${fixed(minY)}, ${fixed(maxY)}]`)
